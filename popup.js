const DEFAULTS = { enabled: true, mode: 'autoplay', allowHosts: [] };

const $ = (id) => document.getElementById(id);
let cfg = { ...DEFAULTS };
let host = null;

const hostMatches = (h, pattern) => h === pattern || h.endsWith('.' + pattern);
const isAllowed = () => !!host && cfg.allowHosts.some((p) => hostMatches(host, p));

const render = () => {
  $('enabled').checked = cfg.enabled !== false;
  $('mode').value = cfg.mode === 'hide' ? 'hide' : 'autoplay';
  $('host').textContent = host ?? 'Sin sitio';
  $('toggleHost').disabled = !host;
  if (host) {
    const allowed = isAllowed();
    $('hostStatus').textContent = cfg.enabled === false
      ? 'Extensión desactivada'
      : allowed ? 'Videos permitidos en este sitio' : 'Autoplay bloqueado en este sitio';
    $('toggleHost').textContent = allowed ? 'Bloquear aquí' : 'Permitir aquí';
  } else {
    $('hostStatus').textContent = '';
  }
};

const save = () => chrome.storage.sync.set(cfg);

const init = async () => {
  cfg = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  if (!Array.isArray(cfg.allowHosts)) cfg.allowHosts = [];
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab?.url ?? '');
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
  } catch {}
  render();
};

$('enabled').addEventListener('change', (e) => { cfg.enabled = e.target.checked; save(); render(); });
$('mode').addEventListener('change', (e) => { cfg.mode = e.target.value; save(); render(); });
$('toggleHost').addEventListener('click', () => {
  if (!host) return;
  if (isAllowed()) {
    cfg.allowHosts = cfg.allowHosts.filter((p) => !hostMatches(host, p));
  } else {
    // Guardamos sin "www." para que cubra subdominios del mismo medio.
    cfg.allowHosts = [...cfg.allowHosts, host.replace(/^www\./, '')];
  }
  save();
  render();
});

init();
