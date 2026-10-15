const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

// Ejecutar el worker real con storage controlado permite forzar cuotas y migraciones fallidas.
function worker(initial = {}) {
  let stored = structuredClone(initial);
  let listener, installed;
  let fail = false;
  const scope = vm.createContext({ URL, console, chrome: {
    runtime: {
      onInstalled: { addListener(fn) { installed = fn; } },
      onMessage: { addListener(fn) { listener = fn; } }
    },
    storage: { sync: {
      async get() { return structuredClone(stored); },
      async set(patch) {
        if (fail) { fail = false; throw new Error('QUOTA_BYTES exceeded'); }
        Object.assign(stored, structuredClone(patch));
      },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; }
    } }
  } });
  scope.importScripts = (file) => vm.runInContext(readFileSync(resolve(__dirname, '..', file), 'utf8'), scope);
  vm.runInContext(readFileSync(resolve(__dirname, '../background.js'), 'utf8'), scope);
  return {
    request: (operation, payload = {}) => new Promise(resolve => {
      assert.equal(listener({ type: 'siteSettings', operation, ...payload }, {}, resolve), true);
    }),
    install: () => installed(),
    stored: () => structuredClone(stored),
    failNextWrite: () => { fail = true; }
  };
}

test('instalación y migración son idempotentes y no crean bloqueos', async () => {
  const app = worker({ enabled: false, mode: 'hide', allowHosts: ['Example.com', 'example.com', null] });
  app.install();
  assert.equal((await app.request('updatePreferences', { preferences: {} })).ok, true);
  assert.deepEqual(app.stored(), {
    schemaVersion: 2, enabled: false, mode: 'hide', migrationNotice: true,
    'siteRule:example.com': { action: 'allow', includeSubdomains: true }
  });
  await app.request('dismissNotice');
  app.install();
  await app.request('updatePreferences', { preferences: {} });
  assert.equal(app.stored().migrationNotice, false);
});
test('una instalación nueva permite sitios sin mostrar un aviso de migración', async () => {
  const app = worker();
  await app.request('updatePreferences', { preferences: {} });
  assert.deepEqual(app.stored(), { schemaVersion: 2 });
});
test('escrituras simultáneas preservan otras reglas y preferencias', async () => {
  const app = worker({ enabled: true, mode: 'autoplay', allowHosts: ['old.test'] });
  const results = await Promise.all([
    app.request('setRule', { rule: { host: 'https://a.test/path', action: 'block', includeSubdomains: false } }),
    app.request('setRule', { rule: { host: 'b.test', action: 'allow', includeSubdomains: true } }),
    app.request('updatePreferences', { preferences: { enabled: false } }),
    app.request('updatePreferences', { preferences: { mode: 'hide' } })
  ]);
  assert.ok(results.every(result => result.ok));
  const stored = app.stored();
  assert.deepEqual(stored['siteRule:a.test'], { action: 'block', includeSubdomains: false });
  assert.deepEqual(stored['siteRule:b.test'], { action: 'allow', includeSubdomains: true });
  assert.deepEqual(stored['siteRule:old.test'], { action: 'allow', includeSubdomains: true });
  assert.equal(stored.enabled, false);
  assert.equal(stored.mode, 'hide');
});
test('cambiar de lista actualiza una única entrada; eliminar conserva los dominios superiores', async () => {
  const app = worker({ schemaVersion: 2, 'siteRule:example.com': { action: 'block', includeSubdomains: true } });
  await app.request('setRule', { rule: { host: 'video.example.com', action: 'block', includeSubdomains: false } });
  await app.request('setRule', { rule: { host: 'video.example.com', action: 'allow', includeSubdomains: false } });
  assert.equal(app.stored()['siteRule:video.example.com'].action, 'allow');
  assert.equal(Object.keys(app.stored()).filter(key => key === 'siteRule:video.example.com').length, 1);
  await app.request('removeRule', { host: 'video.example.com' });
  assert.equal(app.stored()['siteRule:video.example.com'], undefined);
  assert.equal(app.stored()['siteRule:example.com'].action, 'block');
});
test('un error de cuota se comunica y permite reintentar sin alterar las reglas', async () => {
  const app = worker({ schemaVersion: 2 });
  app.failNextWrite();
  const request = { rule: { host: 'example.com', action: 'block', includeSubdomains: false } };
  const result = await app.request('setRule', request);
  assert.equal(result.ok, false);
  assert.match(result.error, /QUOTA/);
  assert.deepEqual(app.stored(), { schemaVersion: 2 });
  assert.equal((await app.request('setRule', request)).ok, true);
});
test('una migración fallida conserva las preferencias antiguas para el reintento', async () => {
  const initial = { enabled: true, allowHosts: ['example.com'] };
  const app = worker(initial);
  app.failNextWrite();
  assert.equal((await app.request('dismissNotice')).ok, false);
  assert.deepEqual(app.stored(), initial);
  assert.equal((await app.request('dismissNotice')).ok, true);
  assert.equal(app.stored()['siteRule:example.com'].action, 'allow');
});
test('el worker rechaza reglas y preferencias inválidas', async () => {
  const app = worker({ schemaVersion: 2 });
  for (const [operation, payload] of [
    ['setRule', { rule: { host: 'chrome://extensions', action: 'block', includeSubdomains: false } }],
    ['setRule', { rule: { host: 'example.com', action: 'unknown', includeSubdomains: false } }],
    ['updatePreferences', { preferences: { enabled: 'false' } }],
    ['updatePreferences', { preferences: { mode: 'unknown' } }],
    ['updatePreferences', { preferences: { rules: [] } }],
    ['unknown', {}]
  ]) assert.equal((await app.request(operation, payload)).ok, false);
  assert.deepEqual(app.stored(), { schemaVersion: 2 });
});
