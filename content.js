// Mundo aislado: la configuración es privada. Los atributos solo controlan el CSS.
(() => {
  let cfg = SitePolicy.read();
  let ready = false;
  const channel = new MessageChannel();
  const port = channel.port1;
  const topHost = (() => {
    try {
      const origins = location.ancestorOrigins;
      if (origins?.length) return new URL(origins[origins.length - 1]).hostname;
    } catch {}
    return location.hostname;
  })();
  const isActive = () => SitePolicy.isBlocked(topHost, cfg);
  const render = () => {
    const html = document.documentElement;
    if (!html) return;
    const state = isActive() ? 'on' : 'off';
    const mode = cfg.mode === 'hide' ? 'hide' : 'autoplay';
    if (html.getAttribute('data-sinautoplay') !== state) html.setAttribute('data-sinautoplay', state);
    if (html.getAttribute('data-sinautoplay-mode') !== mode) html.setAttribute('data-sinautoplay-mode', mode);
  };
  const publish = () => {
    render();
    if (ready && port) port.postMessage({ type: 'configuration', active: isActive() });
  };
  // El receptor MAIN se registra en document_start y consume el primer mensaje.
  window.postMessage({ type: '__sinAutoplayCLBridge__' }, '*', [channel.port2]);

  // Reparar atributos alterados por la página sin cambiar la configuración privada.
  new MutationObserver(render).observe(document, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['data-sinautoplay', 'data-sinautoplay-mode']
  });
  render();
  let revision = 0;
  const load = () => {
    const current = ++revision;
    chrome.storage.sync.get(null, (value) => {
      if (current !== revision) return;
      cfg = SitePolicy.read(chrome.runtime.lastError ? {} : value);
      ready = true;
      publish();
    });
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && Object.keys(changes).some(SitePolicy.isSettingsKey)) load();
  });
  load();
})();
