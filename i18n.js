// Only extension UI pages depend on Chrome's message catalog.
(() => {
  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions);
  const errorKeys = Object.freeze({
    INVALID_URL: 'errorInvalidUrl',
    UNSUPPORTED_URL: 'errorUnsupportedUrl',
    INVALID_DOMAIN: 'errorInvalidDomain',
    INVALID_RULE: 'errorInvalidRule',
    INVALID_PREFERENCES: 'errorInvalidPreferences',
    INVALID_OPERATION: 'errorInvalidOperation',
    SAVE_FAILED: 'errorSaveFailed'
  });
  const errorMessage = (error) => {
    if (Object.hasOwn(errorKeys, error?.code)) return t(errorKeys[error.code]);
    return error?.message ? t('errorUnexpectedDetails', error.message) : t('errorUnexpected');
  };
  const localize = () => {
    // The catalog language can differ from the browser language when falling back.
    document.documentElement.lang = t('uiLanguage');
    for (const element of document.querySelectorAll('[data-i18n]')) {
      element.textContent = t(element.dataset.i18n);
    }
    for (const attribute of ['aria-label', 'placeholder']) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
  };
  globalThis.SiteI18n = Object.freeze({ t, errorMessage });
  localize();
})();
