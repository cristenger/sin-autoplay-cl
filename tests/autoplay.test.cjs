const { test: nodeTest, before, after, beforeEach, afterEach } = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const defaults = { enabled: true, mode: 'autoplay', allowHosts: [] };
let server, context, origin, page, settingsPage, extensionId;
let pageErrors;

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
  context = await chromium.launchPersistentContext('', {
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
      '--autoplay-policy=no-user-gesture-required']
  });
  context.setDefaultTimeout(5000);
  const bootstrap = await context.newPage();
  const session = await context.newCDPSession(bootstrap);
  const worlds = [];
  session.on('Runtime.executionContextCreated', ({ context }) => worlds.push(context));
  await session.send('Runtime.enable');
  await bootstrap.goto(origin);
  await bootstrap.waitForFunction(() => document.documentElement.dataset.sinautoplay === 'on');
  const world = worlds.find(world => world.origin.startsWith('chrome-extension://'));
  assert.ok(world, 'Debe existir el mundo aislado de la extensión');
  extensionId = (await session.send('Runtime.evaluate', {
    contextId: world.id, expression: 'chrome.runtime.id', returnByValue: true
  })).result.value;
  settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await bootstrap.close();
});
after(async () => {
  await context?.close();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
});

async function configure(settings) {
  await settingsPage.evaluate(settings => chrome.storage.sync.set(settings), settings);
  if (page && !page.isClosed() && page.url().startsWith(origin)) {
    // Esperar entrega de storage y MessagePort sin depender de pausas fijas.
    await page.waitForFunction(enabled =>
      document.documentElement.dataset.sinautoplay === (enabled ? 'on' : 'off'),
    settings.enabled !== false && !(settings.allowHosts || []).includes('127.0.0.1'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
}
async function open(query = '') {
  await page.goto(`${origin}/${query}`);
  await page.locator('#play').waitFor();
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
  await page?.close();
  assert.deepEqual(pageErrors, [], 'La página no debe generar errores JavaScript');
});

test('bloquea play() automático y el autoplay del parser', async () => {
  await open('?autoplay&earlyPlay');
  assert.equal(await page.evaluate(() => window.earlyResult), 'NotAllowedError');
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
  await page.waitForFunction(() => document.querySelector('video').readyState >= 1);
  await page.locator('video').hover();
  // Los controles nativos de Chromium tienen una animación de aparición.
  await page.waitForTimeout(250);
  await page.locator('video').click({ position: { x: 20, y: 160 } });
  await page.waitForFunction(() => !document.querySelector('video').paused);
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
  await configure({ ...defaults, allowHosts: ['127.0.0.1'] });
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
  await page.bringToFront();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // Una pestaña de prueba del popup no aporta activeTab; probar render con un sitio explícito.
  await popup.evaluate(() => { host = 'example.com'; render(); });
  assert.equal(await popup.locator('#hostStatus').textContent(), 'Extensión desactivada');
  await popup.close();
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

test('storage tardío restaura atributos y permite la llamada original en un sitio desactivado', async () => {
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
  await page.addScriptTag({ path: path.join(root, 'content.js') });
  await page.evaluate(() => {
    window.startupResult = document.querySelector('video').play().then(() => 'playing', error => error.name);
  });
  assert.equal(await page.evaluate(() => window.nativePlayCalls), 0);
  await page.evaluate(() => {
    window.deliverSettings({ enabled: false, mode: 'autoplay', allowHosts: [] });
  });
  assert.equal(await page.evaluate(() => window.startupResult), 'playing');
  assert.equal(await page.evaluate(() => window.nativePlayCalls), 1);
  assert.equal(await page.locator('video').getAttribute('autoplay'), '');
  assert.equal(await page.locator('video').getAttribute('preload'), 'auto');
});
