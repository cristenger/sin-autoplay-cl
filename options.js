const $ = (id) => document.getElementById(id);
let cfg = SitePolicy.read();
let filter = 'all';
let busy = false;
let loaded = false;
let revision = 0;

const preview = () => {
  const input = $('siteUrl').value;
  if (!input.trim()) {
    $('preview').textContent = 'Las reglas se aplican al dominio completo, en HTTP y HTTPS y en todos los puertos.';
    return;
  }
  try {
    const rule = SitePolicy.createRule(input, $('siteAction').value, $('includeSubdomains').checked);
    const exists = cfg.rules.some(item => item.host === rule.host);
    $('preview').textContent = `${exists ? 'Actualizará' : 'Guardará'} ${rule.host}${rule.includeSubdomains ? ' y sus subdominios' : ' (solo este dominio)'}. Autoplay ${rule.action === 'block' ? 'bloqueado' : 'permitido'}.`;
  } catch (error) { $('preview').textContent = error.message; }
};
const actionButton = (label, title, action) => {
  const button = document.createElement('button');
  button.textContent = label;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', action);
  return button;
};
const render = () => {
  if (busy || !loaded) {
    for (const control of document.querySelectorAll('input, select, button')) control.disabled = true;
    return;
  }
  $('enabled').checked = cfg.enabled;
  $('mode').value = cfg.mode;
  $('pausedNotice').hidden = cfg.enabled;
  $('migrationNotice').hidden = !cfg.migrationNotice;
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    const count = cfg.rules.filter(rule => button.dataset.filter === 'all' || rule.action === button.dataset.filter).length;
    const label = { all: 'Todos', block: 'Bloqueados', allow: 'Permitidos' }[button.dataset.filter];
    button.textContent = `${label} (${count})`;
  }
  const search = $('search').value.trim().toLowerCase();
  const visible = cfg.rules.filter(rule => (filter === 'all' || rule.action === filter) && rule.host.includes(search));
  $('rules').replaceChildren();
  for (const rule of visible) {
    const row = document.createElement('tr');
    row.dataset.host = rule.host;
    const hostCell = document.createElement('td');
    hostCell.className = 'host'; hostCell.textContent = rule.host;
    const stateCell = document.createElement('td');
    stateCell.textContent = rule.action === 'block' ? 'Bloqueado' : 'Permitido';
    const scopeCell = document.createElement('td');
    const scopeLabel = document.createElement('label'); scopeLabel.className = 'check';
    const scope = document.createElement('input'); scope.type = 'checkbox'; scope.checked = rule.includeSubdomains;
    scope.setAttribute('aria-label', `Incluir subdominios de ${rule.host}`);
    scope.addEventListener('change', () => {
      const updated = { ...rule, includeSubdomains: scope.checked };
      run(() => SiteSettings.setRule(updated), 'Alcance actualizado.');
    });
    scopeLabel.append(scope, ' Subdominios'); scopeCell.append(scopeLabel);
    const actionsCell = document.createElement('td');
    const actions = document.createElement('div'); actions.className = 'actions';
    const next = rule.action === 'block' ? 'allow' : 'block';
    actions.append(actionButton(next === 'allow' ? 'Permitir' : 'Bloquear', `${next === 'allow' ? 'Permitir' : 'Bloquear'} ${rule.host}`,
      () => run(() => SiteSettings.setRule({ ...rule, action: next }), 'Regla actualizada.')));
    const inherited = SitePolicy.match(rule.host, cfg.rules.filter(item => item.host !== rule.host));
    const result = inherited?.action === 'block' ? 'bloqueado por la regla superior' : 'permitido';
    actions.append(actionButton('Eliminar', `Eliminar ${rule.host}; quedará ${result}`,
      () => run(() => SiteSettings.removeRule(rule.host), `${rule.host}: regla eliminada; autoplay ${result}.`)));
    actionsCell.append(actions);
    row.append(hostCell, stateCell, scopeCell, actionsCell);
    $('rules').append(row);
  }
  $('empty').hidden = visible.length !== 0;
  $('empty').textContent = cfg.rules.length ? 'No hay sitios que coincidan con este filtro.'
    : 'No hay reglas guardadas. Todos los sitios están permitidos.';
  for (const control of document.querySelectorAll('input, select, button')) control.disabled = busy;
  preview();
};
const refresh = async () => {
  const current = ++revision;
  try {
    const value = await SiteSettings.read();
    if (current !== revision) return;
    cfg = value; loaded = true; render();
  } catch { $('error').textContent = 'No se pudieron leer las reglas. Recarga el panel.'; }
};
const run = async (task, feedback) => {
  if (busy) return;
  busy = true; $('error').textContent = ''; $('feedback').textContent = ''; render();
  try {
    await task(); await refresh(); $('feedback').textContent = feedback;
  } catch (error) { $('error').textContent = `No se pudo guardar: ${error.message}`; }
  finally { busy = false; render(); }
};
$('siteForm').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const rule = SitePolicy.createRule($('siteUrl').value, $('siteAction').value, $('includeSubdomains').checked);
    run(() => SiteSettings.setRule(rule), `${rule.host}: autoplay ${rule.action === 'block' ? 'bloqueado' : 'permitido'}.`);
  } catch (error) { $('error').textContent = error.message; }
});
for (const id of ['siteUrl', 'siteAction', 'includeSubdomains']) $(id).addEventListener('input', preview);
$('search').addEventListener('input', render);
for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
}
$('enabled').addEventListener('change', (event) => {
  const enabled = event.target.checked;
  run(() => SiteSettings.updatePreferences({ enabled }), enabled ? 'Bloqueo reactivado.' : 'Bloqueo en pausa.');
});
$('mode').addEventListener('change', (event) => {
  const mode = event.target.value;
  run(() => SiteSettings.updatePreferences({ mode }), 'Modo actualizado.');
});
$('dismissNotice').addEventListener('click', () => run(() => SiteSettings.dismissNotice(), ''));
SiteSettings.subscribe(refresh);
render();
refresh();
