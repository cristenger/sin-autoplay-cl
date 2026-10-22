const { t, errorMessage } = SiteI18n;
const $ = (id) => document.getElementById(id);
let cfg = SitePolicy.read();
let host = null;
let busy = false;
let loaded = false;
let revision = 0;

const render = () => {
  // No revertir el control que acaba de cambiar mientras se confirma el guardado.
  if (busy || !loaded) {
    for (const control of document.querySelectorAll('input, select, button')) control.disabled = true;
    return;
  }
  $('enabled').checked = cfg.enabled;
  $('mode').value = cfg.mode;
  $('host').textContent = host || t('unsupportedPage');
  const rule = host && SitePolicy.match(host, cfg.rules);
  const blocked = rule?.action === 'block';
  $('hostStatus').textContent = !host ? t('openHttpSite')
    : !cfg.enabled ? t('blockingPaused')
      : blocked ? t('autoplayBlocked') : t('autoplayAllowed');
  $('ruleSource').textContent = !host ? '' : rule
    ? t(rule.includeSubdomains ? 'ruleSubdomains' : 'ruleExact', rule.host)
    : t('defaultAllowed');
  $('toggleHost').textContent = blocked ? t('allowHere') : t('blockHere');
  $('includeSubdomains').checked = cfg.rules.find(item => item.host === host)?.includeSubdomains || false;
  $('migrationNotice').hidden = !cfg.migrationNotice;
  for (const control of document.querySelectorAll('input, select, button')) control.disabled = busy;
  $('toggleHost').disabled = busy || !host;
  $('includeSubdomains').disabled = busy || !host;
};
const refresh = async () => {
  const current = ++revision;
  try {
    const value = await SiteSettings.read();
    if (current !== revision) return;
    cfg = value;
    loaded = true;
    render();
  } catch {
    $('error').textContent = t('popupReadError');
  }
};
const run = async (task) => {
  if (busy) return;
  busy = true;
  $('error').textContent = '';
  render();
  try { await task(); await refresh(); }
  catch (error) { $('error').textContent = t('saveError', errorMessage(error)); }
  finally { busy = false; render(); }
};
const init = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || '');
    if (['http:', 'https:'].includes(url.protocol)) host = SitePolicy.normalizeHost(url.href);
  } catch { /* Las páginas internas no admiten reglas. */ }
  await refresh();
};

$('enabled').addEventListener('change', (event) => {
  const enabled = event.target.checked;
  run(() => SiteSettings.updatePreferences({ enabled }));
});
$('mode').addEventListener('change', (event) => {
  const mode = event.target.value;
  run(() => SiteSettings.updatePreferences({ mode }));
});
$('toggleHost').addEventListener('click', () => {
  if (!host) return;
  const action = SitePolicy.match(host, cfg.rules)?.action === 'block' ? 'allow' : 'block';
  const rule = SitePolicy.createRule(host, action, $('includeSubdomains').checked);
  run(() => SiteSettings.setRule(rule));
});
$('manageSites').addEventListener('click', () => {
  chrome.runtime.openOptionsPage().catch(() => { $('error').textContent = t('openOptionsError'); });
});
$('dismissNotice').addEventListener('click', () => run(() => SiteSettings.dismissNotice()));
SiteSettings.subscribe(refresh);
render();
init();
