// Mundo aislado: lee la configuración, la publica en <html> para main-world.js
// y limpia atributos autoplay en el DOM a medida que aparecen.
(() => {
  const html = document.documentElement;
  const DEFAULTS = { enabled: true, mode: 'autoplay', allowHosts: [] };

  // Host "visible" de la página. En un iframe (rudo.video) usamos el origen del
  // documento de más arriba, que es el que el usuario ve en la barra.
  const topHost = (() => {
    try {
      const origins = location.ancestorOrigins;
      if (origins && origins.length) return new URL(origins[origins.length - 1]).hostname;
    } catch {}
    return location.hostname;
  })();

  const hostMatches = (host, pattern) =>
    host === pattern || host.endsWith('.' + pattern);

  const apply = (cfg) => {
    const allowed = (cfg.allowHosts || []).some((h) => hostMatches(topHost, h));
    const active = cfg.enabled !== false && !allowed;
    html.setAttribute('data-sinautoplay', active ? 'on' : 'off');
    html.setAttribute('data-sinautoplay-mode', cfg.mode === 'hide' ? 'hide' : 'autoplay');
  };

  // Estado inicial optimista (bloquear) hasta que llegue storage, para no
  // dejar una ventana en la que el sitio pueda arrancar el video.
  apply(DEFAULTS);

  chrome.storage.sync.get(DEFAULTS, apply);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    chrome.storage.sync.get(DEFAULTS, apply);
  });

  // ---- Limpieza de atributos en el DOM ---------------------------------------
  const isActive = () => html.getAttribute('data-sinautoplay') !== 'off';

  const clean = (el) => {
    if (!(el instanceof HTMLMediaElement)) return;
    if (el.hasAttribute('autoplay')) {
      el.removeAttribute('autoplay');
      // Si venía con autoplay, no precargar: ahorra datos.
      if (!el.hasAttribute('data-sinautoplay-preload')) {
        el.setAttribute('data-sinautoplay-preload', el.getAttribute('preload') ?? '');
        el.setAttribute('preload', 'none');
      }
    }
  };

  const sweep = (root) => {
    if (!isActive()) return;
    if (root instanceof HTMLMediaElement) clean(root);
    if (root.querySelectorAll) root.querySelectorAll('video, audio').forEach(clean);
  };

  const observer = new MutationObserver((mutations) => {
    if (!isActive()) return;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        clean(m.target);
      } else {
        m.addedNodes.forEach((n) => { if (n.nodeType === 1) sweep(n); });
      }
    }
  });

  observer.observe(html, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['autoplay']
  });

  if (document.readyState !== 'loading') sweep(html);
  else document.addEventListener('DOMContentLoaded', () => sweep(html), { once: true });
})();
