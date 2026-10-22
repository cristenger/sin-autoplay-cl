const { test: nodeTest, before, after, beforeEach, afterEach } = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, async () => {
  try { await fn(); }
  catch (error) {
    if (page && !page.isClosed()) {
      const { mkdir } = require('node:fs/promises');
      await mkdir(path.join(root, 'output/playwright'), { recursive: true });
      await page.screenshot({ path: path.join(root, `output/playwright/failure-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.png`) });
    }
    throw error;
  }
});
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const path = require('node:path');
const { launchBrowser, browserLocale, catalogLocale } = require('./browser.cjs');
const catalog = require(`../_locales/${catalogLocale}/messages.json`);
const ui = (key, value = '') => catalog[key].message.replace(/\$[a-z]+\$/g, () => value);

const root = path.resolve(__dirname, '..');
const allowedDefaults = { schemaVersion: 2, enabled: true, mode: 'autoplay' };
const localRule = 'siteRule:127.0.0.1';
const defaults = { ...allowedDefaults, [localRule]: { action: 'block', includeSubdomains: false } };
let server, context, origin, page, settingsPage, extensionId;
let pageErrors;
let browserCleanup = async () => {};
let expectedActive = true;

// PCM local y silencioso: reproduce medios reales sin servicios externos ni codecs extra.
const wav = Buffer.alloc(44 + 8000 * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
wav.writeUInt32LE(wav.length - 44, 40);

const fixture = (url) => `<!doctype html><html><body>
<article><div class="${url.searchParams.has('plain') ? '' : 'player'}">
<video id="video" class="video-js" src="/media.wav" width="320" height="180" muted loop controls
${url.searchParams.has('autoplay') ? 'autoplay preload="auto"' : ''}></video>
<button id="play">Play</button></div><button id="cookies">Aceptar cookies</button></article>
<script>
window.pageSawBridge = false;
window.addEventListener('message', e => { if(e.data?.type === '__sinAutoplayCLBridge__') window.pageSawBridge = true; }, true);
window.result = null;
window.attempt = (media = document.querySelector('video')) => media.play().then(() => 'playing', e => e.name);
document.getElementById('play').onclick = () => { window.result = window.attempt(); };
${url.searchParams.has('earlyPlay') ? 'window.earlyResult = window.attempt();' : ''}
</script></body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/media.wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.end(wav);
    } else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture(url)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  ({ context, cleanup: browserCleanup } = await launchBrowser(root));
  context.setDefaultTimeout(5000);
  const bootstrap = await context.newPage();
  const session = await context.newCDPSession(bootstrap);
  const worlds = [];
  session.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
  await session.send('Runtime.enable');
  await bootstrap.goto(origin);
  await bootstrap.waitForFunction(() => document.documentElement.dataset.sinautoplay === 'off');
  const world = worlds.find(world => world.origin.startsWith('chrome-extension://'));
  assert.ok(world, 'Debe existir el mundo aislado de la extensión');
  extensionId = (await session.send('Runtime.evaluate', {
    contextId: world.id, expression: 'chrome.runtime.id', returnByValue: true
  })).result.value;
  settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${extensionId}/popup.html`);
  assert.equal(await settingsPage.evaluate(() => chrome.i18n.getUILanguage().split('-')[0]), browserLocale.split('-')[0]);
  assert.equal(await settingsPage.evaluate(() => chrome.i18n.getMessage('uiLanguage')), catalogLocale);
  // Esperar también la inicialización del service worker.
  await settingsPage.evaluate(() => SiteSettings.updatePreferences({}));
  await bootstrap.close();
});
after(async () => {
  await context?.close();
  await browserCleanup();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
});

async function configure(settings) {
  await settingsPage.evaluate(async settings => {
    const stored = await chrome.storage.sync.get(null);
    const removed = Object.keys(stored).filter(key => !(key in settings));
    if (removed.length) await chrome.storage.sync.remove(removed);
    await chrome.storage.sync.set(settings);
  }, settings);
  expectedActive = settings.enabled !== false && settings[localRule]?.action === 'block';
  if (page && !page.isClosed() && page.url().startsWith(origin)) {
    // Esperar entrega de storage y MessagePort sin depender de pausas fijas.
    await page.waitForFunction(enabled =>
      document.documentElement.dataset.sinautoplay === (enabled ? 'on' : 'off'),
    expectedActive);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
}
async function open(query = '') {
  await page.goto(`${origin}/${query}`);
  await page.locator('#play').waitFor();
  await page.waitForFunction(active => document.documentElement.dataset.sinautoplay === (active ? 'on' : 'off'), expectedActive);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function attempt() { return page.evaluate(() => window.attempt()); }
async function paused() { return page.locator('video').evaluate(media => media.paused); }
async function manual() {
  await page.locator('#play').click();
  assert.equal(await page.evaluate(() => window.result), 'playing');
  assert.equal(await paused(), false);
}
beforeEach(async () => {
  page = null;
  await configure(defaults);
  page = await context.newPage();
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
});
afterEach(async () => {
  for (const tab of context.pages()) if (tab !== settingsPage) await tab.close();
  assert.deepEqual(pageErrors, [], 'La página no debe generar errores JavaScript');
});

test('bloquea play() automático y el autoplay del parser', async () => {
  await open('?autoplay&earlyPlay');
  // Antes de resolver storage se permite play(); al llegar la regla se detiene.
  assert.ok(['playing', 'NotAllowedError', 'AbortError'].includes(await page.evaluate(() => window.earlyResult)));
  assert.equal(await attempt(), 'NotAllowedError');
  assert.equal(await paused(), true);
  assert.equal(await page.locator('video').getAttribute('autoplay'), null);
});

test('rechaza pointerdown y teclas sintéticas', async () => {
  await open();
  for (const type of ['pointerdown', 'keydown']) {
    await page.locator('video').evaluate((media, type) => media.dispatchEvent(type === 'keydown'
      ? new KeyboardEvent(type, { key: 'Enter', bubbles: true })
      : new PointerEvent(type, { bubbles: true })), type);
    assert.equal(await attempt(), 'NotAllowedError');
  }
});

test('un botón Play hermano funciona aunque el video tenga clase video-js', async () => {
  await open();
  await manual();
});

test('aceptar cookies en el mismo artículo no autoriza autoplay', async () => {
  await open('?plain');
  await page.locator('#cookies').click();
  assert.equal(await attempt(), 'NotAllowedError');
  assert.equal(await paused(), true);
});

test('teclado Enter y espacio permiten reproducir con el botón Play', async () => {
  await open();
  await page.locator('#play').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.result), 'playing');
  await page.locator('video').evaluate(media => media.pause());
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => window.result), 'playing');
});

test('los controles nativos permiten reproducción manual', async () => {
  await open();
  await page.bringToFront();
  for (let iteration = 0; iteration < 3; iteration++) {
    if (iteration) {
      await page.locator('video').evaluate((media, iteration) => { media.src = '/media.wav?native=' + iteration; }, iteration);
      assert.equal(await attempt(), 'NotAllowedError', 'Mantener el foco no autoriza llamadas JS tras cambiar la fuente');
    }
    await page.waitForFunction(() => document.querySelector('video').readyState >= 1);
    await page.locator('video').hover();
    // Los controles nativos de Chromium tienen una animación de aparición.
    await page.waitForTimeout(250);
    await page.locator('video').click({ position: { x: 20, y: 160 } });
    await page.waitForFunction(() => !document.querySelector('video').paused);
  }
});

test('focus programático y focus sintético no conceden permiso de reproducción', async () => {
  await open();
  await page.locator('video').evaluate(media => {
    media.focus();
    media.dispatchEvent(new FocusEvent('focus', { composed: true,
      sourceCapabilities: new InputDeviceCapabilities({ firesTouchEvents: false }) }));
  });
  assert.equal(await attempt(), 'NotAllowedError');
  await page.evaluate(() => {
    document.getElementById('cookies').onclick = () => {
      document.querySelector('video').focus();
      window.cookieResult = window.attempt();
    };
  });
  await page.locator('#cookies').click();
  assert.equal(await page.evaluate(() => window.cookieResult), 'NotAllowedError');
});

test('reintentar play después de tres segundos conserva el permiso', async () => {
  await open();
  await manual();
  await page.waitForTimeout(3100);
  assert.equal(await attempt(), 'playing');
  await page.locator('video').evaluate(media => media.pause());
  assert.equal(await attempt(), 'playing');
});

test('cambiar la fuente requiere una nueva interacción manual', async () => {
  await open();
  await manual();
  await page.locator('video').evaluate(media => { media.src = '/media.wav?second'; });
  assert.equal(await attempt(), 'NotAllowedError');
  await manual();
});

test('alterar html y enviar una configuración pública falsa no desactiva el bloqueo', async () => {
  await open();
  await page.evaluate(() => {
    document.documentElement.dataset.sinautoplay = 'off';
    window.postMessage({ type: 'configuration', active: false }, '*');
    const channel = new MessageChannel();
    window.postMessage({ type: '__sinAutoplayCLBridge__' }, '*', [channel.port2]);
    channel.port1.postMessage({ type: 'configuration', active: false });
  });
  assert.equal(await attempt(), 'NotAllowedError');
  assert.equal(await page.evaluate(() => window.pageSawBridge), true); // Solo ve el mensaje falso posterior.
  assert.equal(await page.evaluate(() => document.documentElement.dataset.sinautoplay), 'on');
});

test('la página no recibe el puerto privado del arranque', async () => {
  await open();
  assert.equal(await page.evaluate(() => window.pageSawBridge), false);
});

test('desactivar restaura autoplay y preload, incluso al cargar desactivada', async () => {
  await open('?autoplay');
  assert.equal(await page.locator('video').getAttribute('preload'), 'none');
  await configure({ ...defaults, enabled: false });
  assert.equal(await page.locator('video').getAttribute('autoplay'), '');
  assert.equal(await page.locator('video').getAttribute('preload'), 'auto');
  assert.equal(await attempt(), 'playing');
  await open('?autoplay&earlyPlay');
  assert.equal(await page.evaluate(() => window.earlyResult), 'playing');
  assert.equal(await page.locator('video').getAttribute('preload'), 'auto');
});

test('activar pausa autoplay existente y permite un nuevo clic manual', async () => {
  await configure({ ...defaults, enabled: false });
  await open();
  assert.equal(await attempt(), 'playing');
  await configure(defaults);
  assert.equal(await paused(), true);
  await manual();
});

test('activar mantiene una reproducción que el usuario inició manualmente', async () => {
  await configure({ ...defaults, enabled: false });
  await open();
  await manual();
  await page.waitForTimeout(3100);
  await configure(defaults);
  assert.equal(await paused(), false);
});

test('propiedad, setAttribute y toggleAttribute neutralizan autoplay y se restauran', async () => {
  for (const kind of ['property', 'attribute', 'toggle']) {
    await open();
    await page.locator('video').evaluate((media, kind) => {
      if (kind === 'property') media.autoplay = true;
      if (kind === 'attribute') media.setAttribute('AUTOPLAY', '');
      if (kind === 'toggle') media.toggleAttribute('autoplay', true);
    }, kind);
    assert.equal(await page.locator('video').getAttribute('autoplay'), null);
    await configure({ ...defaults, enabled: false });
    assert.equal(await page.locator('video').evaluate(media => media.autoplay), true);
    assert.equal(await page.locator('video').getAttribute('preload'), null);
    await configure(defaults);
  }
});

test('cancelar autoplay durante el bloqueo no lo restaura al desactivar', async () => {
  await open();
  await page.locator('video').evaluate(media => { media.autoplay = true; media.autoplay = false; });
  await configure({ ...defaults, enabled: false });
  assert.equal(await page.locator('video').getAttribute('autoplay'), null);
});

test('excepciones por sitio se aplican también al iframe', async () => {
  await open();
  await page.evaluate(origin => {
    const frame = document.createElement('iframe');
    frame.src = origin.replace('127.0.0.1', 'localhost'); document.body.append(frame);
  }, origin);
  await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow != null);
  const frame = await page.locator('iframe').contentFrame();
  await frame.locator('video').waitFor();
  assert.equal(await frame.locator('video').evaluate(media => media.play().then(() => 'playing', e => e.name)), 'NotAllowedError');
  await configure({ ...defaults, [localRule]: { action: 'allow', includeSubdomains: false } });
  await frame.locator('html').evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await frame.locator('video').evaluate(media => media.play().then(() => 'playing', e => e.name)), 'playing');
});

test('bloquea y permite reproducción manual dentro de Shadow DOM', async () => {
  await open();
  await page.evaluate(() => {
    const host = document.createElement('div'); host.id = 'shadow'; document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div class="player"><video src="/media.wav" width="320" height="180" muted loop></video><button>Play shadow</button></div>';
    shadow.querySelector('button').onclick = () => { window.shadowResult = window.attempt(shadow.querySelector('video')); };
  });
  const video = page.locator('#shadow video');
  assert.equal(await video.evaluate(media => media.play().then(() => 'playing', e => e.name)), 'NotAllowedError');
  await page.locator('#shadow button').click();
  assert.equal(await page.evaluate(() => window.shadowResult), 'playing');
});

test('modo ocultar cambia visibilidad y la desactivación la restaura', async () => {
  await open();
  await configure({ ...defaults, mode: 'hide' });
  assert.equal(await page.locator('video').isVisible(), false);
  await configure({ ...defaults, mode: 'hide', enabled: false });
  assert.equal(await page.locator('video').isVisible(), true);
});

test('popup muestra el estado global desactivado', async () => {
  await configure({ ...defaults, enabled: false });
  await open();
  const popup = await openPopup();
  assert.equal(await popup.locator('#hostStatus').textContent(), ui('blockingPaused'));
  await popup.close();
});

async function openPopup(url = origin) {
  const popup = await context.newPage();
  popup.on('pageerror', error => pageErrors.push(error.message));
  // Un popup abierto como pestaña no recibe la concesión activeTab del icono.
  // Simular solo esa consulta; el UI, worker, storage y content scripts son reales.
  await popup.addInitScript(url => {
    if (location.protocol === 'chrome-extension:') chrome.tabs.query = async () => [{ url }];
  }, url);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => loaded);
  await popup.evaluate(() => refresh());
  return popup;
}
async function openOptions() {
  const options = await context.newPage();
  options.on('pageerror', error => pageErrors.push(error.message));
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.evaluate(() => refresh());
  return options;
}
async function waitState(active, tab = page) {
  await tab.waitForFunction(active => document.documentElement.dataset.sinautoplay === (active ? 'on' : 'off'), active);
  await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function saveSite(options, input, action = 'block', subdomains = false) {
  await options.locator('#siteUrl').fill(input);
  await options.locator('#siteAction').selectOption(action);
  await options.locator('#includeSubdomains').setChecked(subdomains);
  await options.getByRole('button', { name: ui('saveSite'), exact: true }).click();
  await options.waitForFunction(() => !document.querySelector('#siteForm button').disabled && !!document.querySelector('#feedback').textContent);
  assert.equal(await options.locator('#error').textContent(), '');
}

test('por defecto permite autoplay HTML y JavaScript sin cambiar atributos ni ocultar', async () => {
  await configure({ ...allowedDefaults, mode: 'hide' });
  await open('?autoplay&earlyPlay');
  assert.equal(await page.evaluate(() => window.earlyResult), 'playing');
  assert.equal(await attempt(), 'playing');
  assert.equal(await paused(), false);
  assert.equal(await page.locator('video').getAttribute('autoplay'), '');
  assert.equal(await page.locator('video').getAttribute('preload'), 'auto');
  assert.equal(await page.locator('video').isVisible(), true);
  const stored = await settingsPage.evaluate(() => chrome.storage.sync.get(null));
  assert.equal(Object.keys(stored).some(key => key.startsWith('siteRule:')), false);
});

test('popup bloquea el sitio abierto, conserva Play manual y vuelve a permitirlo sin recargar', async () => {
  await configure(allowedDefaults);
  await open('?autoplay');
  assert.equal(await attempt(), 'playing');
  const popup = await openPopup();
  assert.equal(await popup.locator('#hostStatus').textContent(), ui('autoplayAllowed'));
  await popup.getByRole('button', { name: ui('blockHere'), exact: true }).click();
  await waitState(true);
  assert.equal(await paused(), true);
  assert.equal(await attempt(), 'NotAllowedError');
  await manual();
  await popup.getByRole('button', { name: ui('allowHere'), exact: true }).click();
  await waitState(false);
  await page.locator('video').evaluate(media => media.pause());
  assert.equal(await attempt(), 'playing');
  const rule = await settingsPage.evaluate(key => chrome.storage.sync.get(key), localRule);
  assert.deepEqual(rule[localRule], { action: 'allow', includeSubdomains: false });
  await popup.getByRole('button', { name: ui('blockHere'), exact: true }).click();
  await waitState(true);
  assert.equal(await paused(), false, 'Bloquear el sitio conserva la sesión iniciada manualmente');
});

test('popup añade una excepción sin borrar el bloqueo del dominio superior', async () => {
  await configure({ ...allowedDefaults, 'siteRule:example.com': { action: 'block', includeSubdomains: true } });
  const popup = await openPopup('https://video.example.com/article');
  assert.equal(await popup.locator('#ruleSource').textContent(), ui('ruleSubdomains', 'example.com'));
  await popup.getByRole('button', { name: ui('allowHere'), exact: true }).click();
  await popup.waitForFunction(() => document.querySelector('#hostStatus').textContent === chrome.i18n.getMessage('autoplayAllowed'));
  const stored = await settingsPage.evaluate(() => chrome.storage.sync.get(null));
  assert.equal(stored['siteRule:example.com'].action, 'block');
  assert.deepEqual(stored['siteRule:video.example.com'], { action: 'allow', includeSubdomains: false });
});

test('popup respeta el alcance elegido y deshabilita reglas para páginas internas', async () => {
  await configure(allowedDefaults);
  const popup = await openPopup('https://www.example.com/');
  await popup.locator('#includeSubdomains').check();
  await popup.getByRole('button', { name: ui('blockHere'), exact: true }).click();
  await popup.waitForFunction(() => !document.querySelector('#toggleHost').disabled);
  const stored = await settingsPage.evaluate(() => chrome.storage.sync.get(null));
  assert.deepEqual(stored['siteRule:www.example.com'], { action: 'block', includeSubdomains: true });
  assert.equal(stored['siteRule:example.com'], undefined);
  const internal = await openPopup('chrome://extensions/');
  assert.equal(await internal.locator('#toggleHost').isDisabled(), true);
  assert.equal(await internal.locator('#hostStatus').textContent(), ui('openHttpSite'));
});

test('Gestionar sitios abre la página de opciones declarada en el manifiesto', async () => {
  const popup = await openPopup();
  const opened = context.waitForEvent('page');
  await popup.getByRole('button', { name: ui('manageSites'), exact: true }).click();
  const options = await opened;
  await options.waitForURL(`chrome-extension://${extensionId}/options.html`);
  assert.equal(await options.getByRole('heading', { level: 1 }).textContent(), ui('manageSites'));
});

test('panel añade URL, cambia de lista, busca, elimina y actualiza la página abierta', async () => {
  await configure(allowedDefaults);
  await open();
  const options = await openOptions();
  await saveSite(options, `${origin}/article?video=1`);
  await waitState(true);
  assert.equal(await attempt(), 'NotAllowedError');
  await manual();
  const row = options.locator(`tr[data-host="127.0.0.1"]`);
  await row.getByRole('button', { name: ui('allowHost', '127.0.0.1'), exact: true }).click();
  await waitState(false);
  await options.locator('[data-filter="block"]').click();
  assert.equal(await options.locator('#rules tr').count(), 0);
  await options.locator('[data-filter="allow"]').click();
  assert.equal(await row.count(), 1);
  await options.locator('#search').fill('missing');
  assert.equal(await options.locator('#rules tr').count(), 0);
  await options.locator('#search').fill('127.0.0.1');
  await row.getByRole('button', { name: ui('deleteAllowed', '127.0.0.1'), exact: true }).click();
  await options.waitForFunction(() => !document.querySelector('#rules tr'));
  assert.equal(await attempt(), 'playing');
  assert.equal(await options.locator('#empty').isVisible(), true);
});

test('panel actualiza reglas duplicadas, cambia alcance y rechaza URLs inválidas', async () => {
  await configure(allowedDefaults);
  const options = await openOptions();
  await saveSite(options, 'https://WWW.Example.com:8080/article');
  await saveSite(options, 'www.example.com/another', 'allow');
  assert.equal(await options.locator('#rules tr').count(), 1);
  const row = options.locator('tr[data-host="www.example.com"]');
  await row.getByRole('checkbox').check();
  await options.waitForFunction(() => !document.querySelector('#siteForm button').disabled);
  assert.deepEqual((await settingsPage.evaluate(() => chrome.storage.sync.get('siteRule:www.example.com')))['siteRule:www.example.com'],
    { action: 'allow', includeSubdomains: true });
  await options.locator('#siteUrl').fill('javascript:alert(1)');
  await options.getByRole('button', { name: ui('saveSite'), exact: true }).click();
  assert.notEqual(await options.locator('#error').textContent(), '');
  assert.equal(await options.locator('#rules tr').count(), 1);
});

test('panel y popup abiertos conservan cambios simultáneos en reglas y preferencias', async () => {
  await configure(allowedDefaults);
  const popup = await openPopup();
  const options = await openOptions();
  await Promise.all([
    popup.getByRole('button', { name: ui('blockHere'), exact: true }).click(),
    saveSite(options, 'https://other.test/video', 'allow', true)
  ]);
  await options.waitForFunction(() => document.querySelectorAll('#rules tr').length === 2);
  await options.locator('#enabled').uncheck();
  await popup.waitForFunction(() => document.querySelector('#hostStatus').textContent === chrome.i18n.getMessage('blockingPaused'));
  const stored = await settingsPage.evaluate(() => chrome.storage.sync.get(null));
  assert.equal(stored.enabled, false);
  assert.equal(stored[localRule].action, 'block');
  assert.deepEqual(stored['siteRule:other.test'], { action: 'allow', includeSubdomains: true });
});

test('panel muestra errores de guardado y permite reintentar sin fingir éxito', async () => {
  await configure(allowedDefaults);
  const options = await openOptions();
  await options.evaluate(() => {
    window.originalSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async () => ({ ok: false, error: 'QUOTA_BYTES exceeded' });
  });
  await options.locator('#siteUrl').fill('example.com');
  await options.getByRole('button', { name: ui('saveSite'), exact: true }).click();
  await options.waitForFunction(() => document.querySelector('#error').textContent.includes('QUOTA_BYTES'));
  assert.equal(await options.locator('#rules tr').count(), 0);
  assert.equal(await options.locator('#feedback').textContent(), '');
  await options.evaluate(() => { chrome.runtime.sendMessage = window.originalSendMessage; });
  await saveSite(options, 'example.com');
  assert.equal(await options.locator('#rules tr').count(), 1);
});

test('migración preserva preferencias y excepciones, informa una vez y permite otros sitios', async () => {
  await configure({ enabled: false, mode: 'hide', allowHosts: ['Example.com'] });
  const options = await openOptions();
  await options.evaluate(() => SiteSettings.updatePreferences({}));
  await options.waitForFunction(() => !document.querySelector('#migrationNotice').hidden);
  assert.equal(await options.locator('#enabled').isChecked(), false);
  assert.equal(await options.locator('#mode').inputValue(), 'hide');
  assert.equal(await options.locator('tr[data-host="example.com"]').count(), 1);
  const stored = await settingsPage.evaluate(() => chrome.storage.sync.get(null));
  assert.equal(stored.allowHosts, undefined);
  assert.equal(stored.schemaVersion, 2);
  assert.deepEqual(stored['siteRule:example.com'], { action: 'allow', includeSubdomains: true });
  await options.getByRole('button', { name: ui('dismissNotice'), exact: true }).click();
  await options.waitForFunction(() => document.querySelector('#migrationNotice').hidden);
  await options.reload();
  await options.evaluate(() => refresh());
  assert.equal(await options.locator('#migrationNotice').isVisible(), false);
  expectedActive = false;
  await open('?autoplay');
  assert.equal(await attempt(), 'playing');
});

test('un iframe bloqueado como dominio no se bloquea dentro de un sitio superior permitido', async () => {
  await configure({ ...allowedDefaults, 'siteRule:localhost': { action: 'block', includeSubdomains: false } });
  await open();
  await page.evaluate(origin => {
    const frame = document.createElement('iframe');
    frame.src = origin.replace('127.0.0.1', 'localhost') + '/?autoplay'; document.body.append(frame);
  }, origin);
  const frame = page.locator('iframe').contentFrame();
  await frame.locator('video').waitFor();
  await frame.locator('html[data-sinautoplay="off"]').waitFor();
  assert.equal(await frame.locator('video').evaluate(media => media.play().then(() => 'playing', e => e.name)), 'playing');
});


test('una nueva fuente puede iniciarse directamente con un nuevo clic', async () => {
  await open();
  await manual();
  await page.locator('video').evaluate(media => { media.src = '/media.wav?third'; });
  await manual();
});

test('audio automático se bloquea y aria-controls permite un control externo', async () => {
  await open();
  await page.evaluate(() => {
    const audio = document.createElement('audio');
    audio.id = 'audio'; audio.src = '/media.wav'; audio.muted = true; audio.loop = true;
    document.body.append(audio);
    const button = document.createElement('button');
    button.id = 'audioPlay'; button.textContent = 'Reproducir audio';
    button.setAttribute('aria-controls', 'audio');
    button.onclick = () => { window.audioResult = window.attempt(audio); };
    document.body.append(button);
  });
  assert.equal(await page.locator('audio').evaluate(media => media.play().then(() => 'playing', e => e.name)), 'NotAllowedError');
  await page.locator('#audioPlay').click();
  assert.equal(await page.evaluate(() => window.audioResult), 'playing');
});

test('Shadow DOM cerrado respeta reproducción manual y cambios de configuración', async () => {
  await open();
  await configure({ ...defaults, enabled: false });
  await page.evaluate(() => {
    const host = document.createElement('div'); document.body.append(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<video src="/media.wav" width="320" height="180" muted loop controls></video>';
    window.closedVideo = shadow.querySelector('video');
  });
  assert.equal(await page.evaluate(() => window.attempt(window.closedVideo)), 'playing');
  await configure(defaults);
  assert.equal(await page.evaluate(() => window.closedVideo.paused), true);
  const rect = await page.evaluate(() => {
    const rect = window.closedVideo.getBoundingClientRect(); return { x: rect.x + 20, y: rect.y + 160 };
  });
  await page.mouse.move(rect.x, rect.y);
  await page.waitForTimeout(250);
  await page.mouse.click(rect.x, rect.y);
  await page.waitForFunction(() => !window.closedVideo.paused);
});

test('el click de un botón dentro de un shadow cerrado conserva la ruta del gesto real', async () => {
  await open();
  await page.evaluate(() => {
    const host = document.createElement('div'); document.body.append(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<div class="player"><video src="/media.wav" muted loop></video><button>Play closed</button></div>';
    window.closedVideo = shadow.querySelector('video');
    window.closedButton = shadow.querySelector('button');
    window.closedButton.onclick = () => { window.closedResult = window.attempt(window.closedVideo); };
  });
  assert.equal(await page.evaluate(() => window.attempt(window.closedVideo)), 'NotAllowedError');
  const rect = await page.evaluate(() => {
    const rect = window.closedButton.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(rect.x, rect.y);
  assert.equal(await page.evaluate(() => window.closedResult), 'playing');
  assert.equal(await page.evaluate(() => window.closedVideo.paused), false);
});

test('storage tardío no altera atributos ni retrasa play en un sitio permitido', async () => {
  // Caso unitario determinista de la carrera inicial, además de los casos instalados.
  await page.goto('about:blank');
  await page.setContent('<video muted autoplay preload="auto"></video>');
  await page.evaluate(() => {
    window.nativePlayCalls = 0;
    HTMLMediaElement.prototype.play = function () { window.nativePlayCalls++; return Promise.resolve(); };
    window.chrome = { runtime: {}, storage: {
      sync: { get: (defaults, callback) => { window.deliverSettings = callback; } },
      onChanged: { addListener() {} }
    } };
  });
  await page.addScriptTag({ path: path.join(root, 'main-world.js') });
  await page.addScriptTag({ path: path.join(root, 'site-policy.js') });
  await page.addScriptTag({ path: path.join(root, 'content.js') });
  await page.evaluate(() => {
    window.startupResult = document.querySelector('video').play().then(() => 'playing', error => error.name);
  });
  assert.equal(await page.evaluate(() => window.nativePlayCalls), 1);
  assert.equal(await page.locator('video').getAttribute('autoplay'), '');
  assert.equal(await page.locator('video').getAttribute('preload'), 'auto');
  await page.evaluate(() => {
    window.deliverSettings({ enabled: true, mode: 'autoplay', schemaVersion: 2 });
  });
  assert.equal(await page.evaluate(() => window.startupResult), 'playing');
  assert.equal(await page.evaluate(() => window.nativePlayCalls), 1);
  assert.equal(await page.locator('video').getAttribute('autoplay'), '');
  assert.equal(await page.locator('video').getAttribute('preload'), 'auto');
});

test('una regla tardía detiene autoplay existente y conserva la reproducción manual posterior', async () => {
  await page.goto('about:blank');
  await page.setContent(`<div class="player"><video src="data:audio/wav;base64,${wav.toString('base64')}" muted loop controls></video><button>Play</button></div>`);
  await page.addScriptTag({ path: path.join(root, 'main-world.js') });
  await page.evaluate(() => {
    const channel = new MessageChannel();
    window.configurationPort = channel.port1;
    window.postMessage({ type: '__sinAutoplayCLBridge__' }, '*', [channel.port2]);
    document.querySelector('button').onclick = () => {
      window.manualResult = document.querySelector('video').play().then(() => 'playing', e => e.name);
    };
  });
  assert.equal(await page.locator('video').evaluate(media => media.play().then(() => 'playing')), 'playing');
  await page.evaluate(() => window.configurationPort.postMessage({ type: 'configuration', active: true }));
  await page.waitForFunction(() => document.querySelector('video').paused);
  assert.equal(await page.locator('video').evaluate(media => media.play().catch(e => e.name)), 'NotAllowedError');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  assert.equal(await page.evaluate(() => window.manualResult), 'playing');
});

test('idioma nativo, textos accesibles, validaciones y vistas estrechas', async () => {
  await configure({ ...allowedDefaults, migrationNotice: true,
    'siteRule:example.com': { action: 'block', includeSubdomains: true },
    'siteRule:video.example.com': { action: 'allow', includeSubdomains: false }
  });
  const popup = await openPopup('https://news.example.com/article');
  const options = await openOptions();
  // Literal anchors catch accidentally swapped or untranslated catalogs.
  assert.equal(await options.locator('h1').textContent(), catalogLocale === 'es' ? 'Gestionar sitios' : 'Manage sites');
  assert.equal(await popup.locator('#toggleHost').textContent(), catalogLocale === 'es' ? 'Permitir autoplay aquí' : 'Allow autoplay on this site');
  for (const tab of [popup, options]) {
    assert.equal(await tab.locator('html').getAttribute('lang'), catalogLocale);
    assert.equal(await tab.evaluate(() => chrome.runtime.getManifest().description), ui('extensionDescription'));
    // Initial labels with dynamic values are checked separately below.
    const staticText = await tab.locator('[data-i18n]').evaluateAll(elements => elements
      .filter(el => !['host', 'toggleHost', 'preview', 'empty'].includes(el.id) && !el.hasAttribute('data-filter'))
      .map(el => [el.dataset.i18n, el.textContent]));
    for (const [key, value] of staticText) assert.equal(value, ui(key), key);
    const attributes = await tab.locator('[data-i18n-aria-label], [data-i18n-placeholder]').evaluateAll(elements =>
      elements.flatMap(el => ['aria-label', 'placeholder'].filter(attr => el.hasAttribute(`data-i18n-${attr}`))
        .map(attr => [el.getAttribute(`data-i18n-${attr}`), el.getAttribute(attr)])));
    for (const [key, value] of attributes) assert.equal(value, ui(key), key);
    assert.doesNotMatch(await tab.locator('body').innerText(), /__MSG_|\$host\$|\$count\$|undefined/);
  }
  assert.equal(await options.title(), ui('optionsTitle'));
  assert.equal(await options.locator('[data-filter="all"]').textContent(), ui('filterAllCount', '2'));
  const exception = options.locator('tr[data-host="video.example.com"]');
  assert.equal(await exception.getByRole('checkbox').getAttribute('aria-label'), ui('includeHostSubdomains', 'video.example.com'));
  await exception.getByRole('button', { name: ui('deleteInheritedBlock', 'video.example.com'), exact: true }).click();
  await options.waitForFunction(() => !document.querySelector('tr[data-host="video.example.com"]'));
  assert.equal(await options.locator('#feedback').textContent(), ui('deletedInheritedBlock', 'video.example.com'));
  for (const [input, key] of [['not a domain', 'errorInvalidUrl'], ['ftp://example.com', 'errorUnsupportedUrl'], ['*.example.com', 'errorInvalidDomain']]) {
    await options.locator('#siteUrl').fill(input);
    assert.equal(await options.locator('#preview').textContent(), ui(key));
    await options.getByRole('button', { name: ui('saveSite'), exact: true }).click();
    assert.equal(await options.locator('#error').textContent(), ui(key));
  }
  for (const [host, operation] of [['new.example.com', 'Save'], ['example.com', 'Update']]) {
    await options.locator('#siteUrl').fill(host);
    for (const action of ['block', 'allow']) {
      await options.locator('#siteAction').selectOption(action);
      for (const include of [false, true]) {
        await options.locator('#includeSubdomains').setChecked(include);
        const key = `preview${operation}${include ? 'Subdomains' : 'Exact'}${action === 'block' ? 'Block' : 'Allow'}`;
        assert.equal(await options.locator('#preview').textContent(), ui(key, host));
      }
    }
  }
  await options.locator('#siteUrl').fill('');
  await options.evaluate(() => { document.querySelector('#error').textContent = ''; });
  await popup.setViewportSize({ width: 360, height: 900 });
  await options.setViewportSize({ width: 1000, height: 1000 });
  if (process.env.CAPTURE_UI === '1') {
    const { mkdir } = require('node:fs/promises');
    const folder = path.join(root, 'output/playwright', browserLocale);
    await mkdir(folder, { recursive: true });
    await popup.locator('body').screenshot({ path: path.join(folder, 'popup.png') });
    await options.screenshot({ path: path.join(folder, 'options.png'), fullPage: true });
  }
  await options.setViewportSize({ width: 360, height: 900 });
  for (const tab of [popup, options]) {
    assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      'Translations must not cause page-wide horizontal overflow');
  }
  if (process.env.CAPTURE_UI === '1') {
    await options.screenshot({ path: path.join(root, 'output/playwright', browserLocale, 'options-narrow.png'), fullPage: true });
  }
});

test('errores de lectura y del worker se traducen sin mostrar códigos internos', async () => {
  const options = await openOptions();
  await options.evaluate(() => {
    window.originalSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = () => window.originalSendMessage({
      type: 'siteSettings', operation: 'updatePreferences', preferences: { enabled: 'invalid' }
    });
  });
  await options.locator('#siteUrl').fill('new.example.com');
  await options.getByRole('button', { name: ui('saveSite'), exact: true }).click();
  await options.waitForFunction(() => !!document.querySelector('#error').textContent);
  assert.equal(await options.locator('#error').textContent(), ui('saveError', ui('errorInvalidPreferences')));
  assert.equal(await options.locator('#feedback').textContent(), '');
  assert.doesNotMatch(await options.locator('#error').textContent(), /INVALID_PREFERENCES/);
  for (const [tab, key] of [[options, 'optionsReadError'], [await openPopup(), 'popupReadError']]) {
    await tab.evaluate(async () => {
      chrome.storage.sync.get = async () => { throw new Error('Read failed'); };
      await refresh();
    });
    assert.equal(await tab.locator('#error').textContent(), ui(key));
  }
});
