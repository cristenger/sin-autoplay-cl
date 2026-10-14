// Se ejecuta en MAIN, en document_start, antes de los scripts de la página.
(() => {
  const nativePlay = HTMLMediaElement.prototype.play;
  const nativePause = HTMLMediaElement.prototype.pause;
  const nativeSetAttribute = Element.prototype.setAttribute;
  const nativeRemoveAttribute = Element.prototype.removeAttribute;
  const nativeToggleAttribute = Element.prototype.toggleAttribute;
  const autoplayDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'autoplay');
  let active = true;
  let ready = false;
  let resolveReady;
  const configurationReady = new Promise((resolve) => { resolveReady = resolve; });
  const authorized = new WeakMap();
  const changedMedia = new Map();
  const GESTURE_WINDOW_MS = 3000;
  const PLAYER_SELECTOR = [
    '.video-js', '.jwplayer', '.jw-wrapper', '.player', '.video-player',
    '.rudo-player', '[id^="rudo-video"]', '.plyr', '.mejs-container',
    '.html5-video-player', '[data-player]', '[class*="mediastream"]'
  ].join(',');
  let lastGesture = null;
  let lastInput = null;

  const sourceOf = (media) => ({
    src: media.getAttribute('src'),
    object: media.srcObject,
    sources: [...media.querySelectorAll('source')].map((source) =>
      `${source.getAttribute('src')}\n${source.getAttribute('type')}`).join('\n')
  });
  const sameSource = (a, b) => a && a.src === b.src && a.object === b.object && a.sources === b.sources;
  const playerOf = (media) => media.parentElement?.closest(PLAYER_SELECTOR);

  const gestureMatches = (media, gesture) => {
    if (gesture.path.includes(media)) return true;
    const target = gesture.path.find((node) => node instanceof Element);
    if (!target) return false;
    const control = target.closest('button, [role="button"], input, [role="slider"], .vjs-control, .vjs-big-play-button, .jw-icon');
    if (!control) return false;
    const controlledIds = (control.getAttribute('aria-controls') || '').split(/\s+/);
    if (media.id && controlledIds.includes(media.id)) return true;
    const player = playerOf(media);
    if (player) {
      return control.closest(PLAYER_SELECTOR) === player &&
        player.querySelectorAll('video, audio').length === 1;
    }
    // Reproductores sencillos sin clases conocidas: botón explícito junto al medio.
    const label = `${control.getAttribute('aria-label') || ''} ${control.textContent || ''}`;
    return /\b(play|reproducir|reanudar|iniciar)\b/i.test(label) &&
      control.parentElement === media.parentElement &&
      media.parentElement?.querySelectorAll('video, audio').length === 1;
  };

  const userAllowed = (media) => {
    const source = sourceOf(media);
    const previous = authorized.get(media);
    if (sameSource(previous?.source, source)) return true;
    if (previous) {
      authorized.delete(media);
      if (!lastGesture || lastGesture.at <= previous.at) {
        lastGesture = null;
        return false;
      }
    }
    if (!lastGesture || performance.now() - lastGesture.at > GESTURE_WINDOW_MS ||
        !gestureMatches(media, lastGesture)) return false;
    authorized.set(media, { source, at: lastGesture.at });
    lastGesture = null;
    return true;
  };
  const onGesture = (event) => {
    if (!event.isTrusted) return;
    if (event.type === 'keydown' && !['Enter', ' ', 'Spacebar'].includes(event.key)) return;
    if (['pointerdown', 'mousedown', 'click'].includes(event.type) && event.button !== 0) return;
    const at = performance.now();
    const path = event.composedPath();
    // El click de un mismo pointerdown/keydown no concede una segunda autorización.
    if (event.type === 'click' && lastInput?.target === path[0] && at - lastInput.at < 1000) return;
    if (event.type !== 'click') lastInput = { at, target: path[0] };
    lastGesture = { at, path };
  };
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click']) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }

  const pauseBlocked = (media) => {
    nativePause.call(media);
    nativeSetAttribute.call(media, 'data-sinautoplay-blocked', '');
  };
  const play = (media, args) => {
    const allowed = userAllowed(media);
    if (active && !allowed) {
      pauseBlocked(media);
      return Promise.reject(new DOMException(
        'El usuario no inició la reproducción.', 'NotAllowedError'));
    }
    nativeRemoveAttribute.call(media, 'data-sinautoplay-blocked');
    return nativePlay.apply(media, args);
  };
  HTMLMediaElement.prototype.play = function playWithPermission(...args) {
    if (ready) return play(this, args);
    // Conservar la intención mientras llega storage, sin rechazar sitios permitidos.
    userAllowed(this);
    return configurationReady.then(() => play(this, args));
  };

  const suppressAutoplay = (media, value) => {
    let original = changedMedia.get(media);
    if (!original) {
      original = { autoplay: value, preload: media.getAttribute('preload') };
      changedMedia.set(media, original);
      nativeSetAttribute.call(media, 'preload', 'none');
    }
    original.autoplay = value;
    nativeRemoveAttribute.call(media, 'autoplay');
  };
  const restore = (media, original) => {
    if (media.getAttribute('preload') === 'none') {
      if (original.preload === null) nativeRemoveAttribute.call(media, 'preload');
      else nativeSetAttribute.call(media, 'preload', original.preload);
    }
    if (original.autoplay !== null) nativeSetAttribute.call(media, 'autoplay', original.autoplay);
    nativeRemoveAttribute.call(media, 'data-sinautoplay-blocked');
    changedMedia.delete(media);
  };
  const cancelAutoplay = (media) => {
    const original = changedMedia.get(media);
    if (original) original.autoplay = null;
    nativeRemoveAttribute.call(media, 'autoplay');
  };
  if (autoplayDesc?.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'autoplay', {
      configurable: true,
      enumerable: autoplayDesc.enumerable,
      get() { return active ? false : autoplayDesc.get.call(this); },
      set(value) {
        if (!active) autoplayDesc.set.call(this, value);
        else if (value) suppressAutoplay(this, '');
        else cancelAutoplay(this);
      }
    });
  }
  Element.prototype.setAttribute = function setAttribute(name, value) {
    if (active && this instanceof HTMLMediaElement && String(name).toLowerCase() === 'autoplay') {
      suppressAutoplay(this, String(value));
      return;
    }
    return nativeSetAttribute.call(this, name, value);
  };
  Element.prototype.removeAttribute = function removeAttribute(name) {
    if (this instanceof HTMLMediaElement && String(name).toLowerCase() === 'autoplay') {
      cancelAutoplay(this);
      return;
    }
    return nativeRemoveAttribute.call(this, name);
  };
  Element.prototype.toggleAttribute = function toggleAttribute(name, force) {
    if (active && this instanceof HTMLMediaElement && String(name).toLowerCase() === 'autoplay') {
      const original = changedMedia.get(this);
      const requested = arguments.length < 2 ? !(original && original.autoplay !== null) : Boolean(force);
      if (requested) suppressAutoplay(this, '');
      else cancelAutoplay(this);
      return false;
    }
    return nativeToggleAttribute.apply(this, arguments);
  };

  const tracked = new WeakSet();
  const shadowRoots = new WeakMap();
  const inspectMedia = (media) => {
    if (!(media instanceof HTMLMediaElement)) return;
    if (!tracked.has(media)) {
      tracked.add(media);
      // Escucha directa: play no cruza el límite de Shadow DOM.
      media.addEventListener('play', () => {
        const allowed = userAllowed(media);
        if (active && !allowed) pauseBlocked(media);
      }, true);
    }
    if (!active) {
      nativeRemoveAttribute.call(media, 'data-sinautoplay-blocked');
      return;
    }
    if (!media.isConnected) return;
    if (media.hasAttribute('autoplay')) suppressAutoplay(media, media.getAttribute('autoplay'));
    if (!media.paused && !userAllowed(media)) pauseBlocked(media);
  };
  const observers = new WeakSet();
  const scan = (root) => {
    if (root instanceof HTMLMediaElement) inspectMedia(root);
    if (root instanceof Element) {
      const shadow = shadowRoots.get(root) || root.shadowRoot;
      if (shadow) observe(shadow);
    }
    root.querySelectorAll?.('video, audio').forEach(inspectMedia);
    root.querySelectorAll?.('*').forEach((element) => {
      const shadow = shadowRoots.get(element) || element.shadowRoot;
      if (shadow) observe(shadow);
    });
  };
  const observe = (root) => {
    if (observers.has(root)) { scan(root); return; }
    observers.add(root);
    if (root instanceof ShadowRoot) {
      for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click']) {
        root.addEventListener(type, onGesture, { capture: true, passive: true });
      }
    }
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') inspectMedia(mutation.target);
        else mutation.addedNodes.forEach((node) => { if (node.nodeType === 1) scan(node); });
      }
      for (const [media, original] of changedMedia) {
        if (!media.isConnected) restore(media, original);
      }
    }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['autoplay'] });
    scan(root);
  };
  const nativeAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(options) {
    const root = nativeAttachShadow.call(this, options);
    shadowRoots.set(this, root);
    observe(root);
    return root;
  };
  observe(document);

  // El mensaje inicial se encola desde el mundo aislado antes de los scripts del sitio.
  // Este listener, registrado antes que los de la página, consume el puerto transferido.
  const connect = (event) => {
    if (event.source !== window || event.data?.type !== '__sinAutoplayCLBridge__' ||
        event.ports.length !== 1) return;
    event.stopImmediatePropagation();
    window.removeEventListener('message', connect, true);
    const port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type !== 'configuration' || typeof data.active !== 'boolean') return;
      active = data.active;
      if (!active) {
        for (const [media, original] of changedMedia) restore(media, original);
      }
      scan(document);
      if (!ready) {
        ready = true;
        resolveReady();
      }
    };
  };
  window.addEventListener('message', connect, true);
})();
