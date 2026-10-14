// Corre en el "mundo" de la página (world: MAIN), antes que cualquier script del sitio.
// Intercepta HTMLMediaElement.play() y la propiedad `autoplay` para que ningún
// reproductor (video.js, rudo.video, jwplayer, hls.js, etc.) pueda arrancar solo.
// Rechazamos con NotAllowedError: es exactamente lo que devuelve Chrome cuando
// bloquea autoplay, así que los reproductores lo manejan bien (muestran el botón Play).
(() => {
  const FLAG = '__sinAutoplayCL__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const html = document.documentElement;
  // content.js escribe este atributo según la configuración del usuario.
  const isActive = () => html.getAttribute('data-sinautoplay') !== 'off';

  // ---- Detección de gesto del usuario ---------------------------------------
  // Permitimos reproducir si el usuario interactuó hace poco con algo que esté
  // dentro del reproductor del video. Un click en "aceptar cookies" o en un
  // titular no cuenta, así los sitios no pueden "robar" el gesto.
  const GESTURE_WINDOW_MS = 3000;
  let lastGestureAt = 0;
  let lastGestureTarget = null;

  const onGesture = (ev) => {
    lastGestureAt = Date.now();
    lastGestureTarget = ev.target instanceof Node ? ev.target : null;
  };
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
    window.addEventListener(type, onGesture, { capture: true, passive: true });
  }

  const PLAYER_SELECTOR = [
    '.video-js', '[class*="vjs-"]', '[class*="player"]', '[id*="player"]',
    '[class*="video"]', '[id*="video"]', '.jwplayer', '[class*="rudo"]',
    '[id*="rudo"]', '[class*="mediastream"]', 'figure', 'article'
  ].join(',');

  const playerOf = (media) => {
    const p = media.closest(PLAYER_SELECTOR);
    if (p) return p;
    // Fallback: dos niveles hacia arriba.
    return media.parentElement?.parentElement ?? media.parentElement ?? media;
  };

  const userAllowed = (media) => {
    if (Date.now() - lastGestureAt > GESTURE_WINDOW_MS) return false;
    if (!lastGestureTarget) return false;
    // Dentro de un iframe (rudo.video, youtube) el click llega al propio frame.
    try {
      return playerOf(media).contains(lastGestureTarget) || media.contains(lastGestureTarget);
    } catch {
      return false;
    }
  };

  // ---- Intercepción de play() -----------------------------------------------
  const nativePlay = HTMLMediaElement.prototype.play;
  const nativePause = HTMLMediaElement.prototype.pause;

  const block = (media) => {
    try { nativePause.call(media); } catch {}
    try { media.setAttribute('data-sinautoplay-blocked', ''); } catch {}
    return Promise.reject(new DOMException(
      'play() bloqueado por Sin Autoplay CL: el usuario no inició la reproducción.',
      'NotAllowedError'
    ));
  };

  HTMLMediaElement.prototype.play = function play() {
    if (isActive() && !userAllowed(this)) return block(this);
    try { this.removeAttribute('data-sinautoplay-blocked'); } catch {}
    return nativePlay.apply(this, arguments);
  };

  // ---- Neutralizar la propiedad/atributo `autoplay` ---------------------------
  const autoplayDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'autoplay');
  if (autoplayDesc?.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'autoplay', {
      configurable: true,
      enumerable: autoplayDesc.enumerable,
      get() { return isActive() ? false : autoplayDesc.get.call(this); },
      set(v) { if (!isActive()) autoplayDesc.set.call(this, v); }
    });
  }

  // setAttribute('autoplay', ...) también.
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function setAttribute(name, value) {
    if (isActive() && this instanceof HTMLMediaElement && String(name).toLowerCase() === 'autoplay') {
      return;
    }
    return nativeSetAttribute.call(this, name, value);
  };

  // ---- Red de seguridad: si algo logra arrancar sin gesto, lo pausamos --------
  document.addEventListener('play', (ev) => {
    const media = ev.target;
    if (!(media instanceof HTMLMediaElement)) return;
    if (isActive() && !userAllowed(media)) {
      try { nativePause.call(media); } catch {}
      media.setAttribute('data-sinautoplay-blocked', '');
    }
  }, true);
})();
