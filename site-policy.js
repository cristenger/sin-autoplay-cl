// Política compartida por el popup, las opciones y el mundo aislado.
(() => {
  const RULE_PREFIX = 'siteRule:';
  const SCHEMA_VERSION = 2;
  const DEFAULTS = Object.freeze({ enabled: true, mode: 'autoplay' });
  const failure = (code) => Object.assign(new Error(code), { code });

  const normalizeHost = (input) => {
    if (typeof input !== 'string' || !input.trim() || /\s/.test(input.trim())) {
      throw failure('INVALID_URL');
    }
    const text = input.trim();
    let url;
    try {
      url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      throw failure('INVALID_URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw failure('UNSUPPORTED_URL');
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const ipv6 = host.startsWith('[') && host.endsWith(']');
    if (!host || host.length > 253 || (!ipv6 && !host.split('.').every(label =>
      /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)))) {
      throw failure('INVALID_DOMAIN');
    }
    return host;
  };
  const ruleKey = (host) => RULE_PREFIX + normalizeHost(host);
  const createRule = (input, action, includeSubdomains = false) => {
    if (!['allow', 'block'].includes(action) || typeof includeSubdomains !== 'boolean') {
      throw failure('INVALID_RULE');
    }
    return { host: normalizeHost(input), action, includeSubdomains };
  };
  const read = (stored = {}) => {
    const rules = new Map();
    // Las excepciones antiguas mantienen su alcance; nunca se infieren bloqueos.
    if (stored.schemaVersion !== SCHEMA_VERSION && Array.isArray(stored.allowHosts)) {
      for (const host of stored.allowHosts) {
        try {
          const rule = createRule(host, 'allow', true);
          rules.set(rule.host, rule);
        } catch { /* Ignorar preferencias antiguas dañadas. */ }
      }
    }
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(RULE_PREFIX)) continue;
      try {
        const rule = createRule(key.slice(RULE_PREFIX.length), value.action, value.includeSubdomains);
        if (key === RULE_PREFIX + rule.host) rules.set(rule.host, rule);
      } catch { /* Una entrada inválida no debe bloquear otros sitios. */ }
    }
    return {
      enabled: stored.enabled !== false,
      mode: stored.mode === 'hide' ? 'hide' : 'autoplay',
      migrationNotice: stored.migrationNotice === true,
      rules: [...rules.values()].sort((a, b) => a.host.localeCompare(b.host))
    };
  };
  const match = (host, rules) => {
    let normalized;
    try { normalized = normalizeHost(host); } catch { return null; }
    let best = null;
    for (const rule of rules) {
      if ((normalized === rule.host || (rule.includeSubdomains && normalized.endsWith('.' + rule.host))) &&
          (!best || rule.host.length > best.host.length)) best = rule;
    }
    return best;
  };
  const isBlocked = (host, config) => config.enabled && match(host, config.rules)?.action === 'block';
  const isSettingsKey = (key) => ['enabled', 'mode', 'schemaVersion', 'migrationNotice', 'allowHosts'].includes(key) || key.startsWith(RULE_PREFIX);
  const api = { DEFAULTS, RULE_PREFIX, SCHEMA_VERSION, normalizeHost, ruleKey, createRule, read, match, isBlocked, isSettingsKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.SitePolicy = Object.freeze(api);
})();
