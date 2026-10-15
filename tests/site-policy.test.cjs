const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../site-policy.js');

test('una instalación vacía permite cualquier sitio sin guardar visitas', () => {
  const config = policy.read();
  assert.equal(policy.isBlocked('example.com', config), false);
  assert.equal(policy.isBlocked('video.other.test', config), false);
  assert.deepEqual(config.rules, []);
});

for (const [input, expected] of [
  [' https://WWW.Example.com:8443/article?a=1#video ', 'www.example.com'],
  ['Example.COM.', 'example.com'],
  ['localhost:8080/path', 'localhost'],
  ['http://127.0.0.1:3000/', '127.0.0.1'],
  ['https://[::1]:443/video', '[::1]'],
  ['https://música.example/', 'xn--msica-7ua.example'],
  ['example.co.uk/news', 'example.co.uk']
]) {
  test(`normaliza ${input.trim()} sin ampliar su dominio`, () => {
    assert.equal(policy.normalizeHost(input), expected);
  });
}
for (const input of ['', 'not a domain', 'ftp://example.com', 'file:///tmp/video', 'chrome://extensions',
  'javascript:alert(1)', 'https://user:password@example.com', '*.example.com', 'https://-bad.example',
  'https://example..com', 'https://example.com:bad', null]) {
  test(`rechaza una URL no válida: ${String(input)}`, () => assert.throws(() => policy.normalizeHost(input)));
}
test('exactitud, subdominios y precedencia independiente del orden de almacenamiento', () => {
  const stored = {
    'siteRule:example.com': { action: 'block', includeSubdomains: true },
    'siteRule:video.example.com': { action: 'allow', includeSubdomains: true },
    'siteRule:ads.video.example.com': { action: 'block', includeSubdomains: false }
  };
  for (const entries of [Object.entries(stored), Object.entries(stored).reverse()]) {
    const cfg = policy.read(Object.fromEntries(entries));
    assert.equal(policy.isBlocked('example.com', cfg), true);
    assert.equal(policy.isBlocked('news.example.com', cfg), true);
    assert.equal(policy.isBlocked('video.example.com', cfg), false);
    assert.equal(policy.isBlocked('live.video.example.com', cfg), false);
    assert.equal(policy.isBlocked('ads.video.example.com', cfg), true);
    assert.equal(policy.isBlocked('child.ads.video.example.com', cfg), false);
    assert.equal(policy.isBlocked('fakeexample.com', cfg), false);
    assert.equal(policy.isBlocked('example.com.other.test', cfg), false);
  }
});
test('un bloqueo exacto no alcanza www ni otros subdominios', () => {
  const cfg = policy.read({ 'siteRule:example.com': { action: 'block', includeSubdomains: false } });
  assert.equal(policy.isBlocked('example.com', cfg), true);
  assert.equal(policy.isBlocked('www.example.com', cfg), false);
});
test('pausar conserva las reglas sin bloquear', () => {
  const cfg = policy.read({ enabled: false, 'siteRule:example.com': { action: 'block', includeSubdomains: true } });
  assert.equal(policy.isBlocked('example.com', cfg), false);
  assert.equal(cfg.rules.length, 1);
});
test('excepciones antiguas se leen sin convertir otros sitios en bloqueados', () => {
  const cfg = policy.read({ enabled: false, mode: 'hide', allowHosts: ['Example.com', null, 'example.com'] });
  assert.deepEqual(cfg.rules, [{ host: 'example.com', action: 'allow', includeSubdomains: true }]);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.mode, 'hide');
  assert.equal(policy.isBlocked('other.test', cfg), false);
});
test('datos dañados se ignoran y las entradas antiguas no reaparecen tras migrar', () => {
  const cfg = policy.read({ schemaVersion: 2, allowHosts: ['old.test'],
    'siteRule:example.com': null,
    'siteRule:other.test': { action: 'block', includeSubdomains: 'false' },
    'siteRule:bad.test': { action: 'unknown', includeSubdomains: false } });
  assert.deepEqual(cfg.rules, []);
});
test('eliminar una excepción recupera el bloqueo heredado', () => {
  const cfg = policy.read({
    'siteRule:example.com': { action: 'block', includeSubdomains: true },
    'siteRule:video.example.com': { action: 'allow', includeSubdomains: false }
  });
  assert.equal(policy.isBlocked('video.example.com', cfg), false);
  cfg.rules = cfg.rules.filter(rule => rule.host !== 'video.example.com');
  assert.equal(policy.isBlocked('video.example.com', cfg), true);
});
