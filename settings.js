// Lecturas locales y escrituras serializadas por el service worker.
(() => {
  const read = async () => SitePolicy.read(await chrome.storage.sync.get(null));
  const write = async (operation, payload = {}) => {
    const response = await chrome.runtime.sendMessage({ type: 'siteSettings', operation, ...payload });
    if (!response?.ok) {
      throw Object.assign(new Error(response?.error || 'SAVE_FAILED'), {
        code: response?.code || (response?.error ? undefined : 'SAVE_FAILED')
      });
    }
  };
  const subscribe = (listener) => {
    const onChanged = (changes, area) => {
      if (area === 'sync' && Object.keys(changes).some(SitePolicy.isSettingsKey)) listener();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  };
  globalThis.SiteSettings = Object.freeze({
    read, subscribe,
    setRule: (rule) => write('setRule', { rule }),
    removeRule: (host) => write('removeRule', { host }),
    updatePreferences: (preferences) => write('updatePreferences', { preferences }),
    dismissNotice: () => write('dismissNotice')
  });
})();
