importScripts('site-policy.js');

let pending = Promise.resolve();
const enqueue = (task) => {
  const result = pending.then(task);
  pending = result.catch(() => {});
  return result;
};
const migrate = async () => {
  const stored = await chrome.storage.sync.get(null);
  if (stored.schemaVersion === SitePolicy.SCHEMA_VERSION) return;
  const migrated = { schemaVersion: SitePolicy.SCHEMA_VERSION };
  const existingInstall = ['allowHosts', 'enabled', 'mode'].some(key => Object.hasOwn(stored, key));
  if (existingInstall) migrated.migrationNotice = true;
  for (const rule of SitePolicy.read(stored).rules) {
    const key = SitePolicy.ruleKey(rule.host);
    if (!Object.hasOwn(stored, key)) migrated[key] = { action: rule.action, includeSubdomains: rule.includeSubdomains };
  }
  await chrome.storage.sync.set(migrated);
  await chrome.storage.sync.remove('allowHosts');
};
chrome.runtime.onInstalled.addListener(() => {
  enqueue(migrate).catch(error => console.error('No se pudo migrar la configuración:', error));
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'siteSettings') return;
  enqueue(async () => {
    await migrate();
    switch (message.operation) {
      case 'setRule': {
        const rule = SitePolicy.createRule(message.rule?.host, message.rule?.action, message.rule?.includeSubdomains);
        await chrome.storage.sync.set({ [SitePolicy.ruleKey(rule.host)]: {
          action: rule.action, includeSubdomains: rule.includeSubdomains
        } });
        break;
      }
      case 'removeRule':
        await chrome.storage.sync.remove(SitePolicy.ruleKey(message.host));
        break;
      case 'updatePreferences': {
        const patch = message.preferences;
        if (!patch || Object.keys(patch).some(key => !['enabled', 'mode'].includes(key)) ||
            ('enabled' in patch && typeof patch.enabled !== 'boolean') ||
            ('mode' in patch && !['autoplay', 'hide'].includes(patch.mode))) {
          throw Object.assign(new Error('INVALID_PREFERENCES'), { code: 'INVALID_PREFERENCES' });
        }
        await chrome.storage.sync.set(patch);
        break;
      }
      case 'dismissNotice':
        await chrome.storage.sync.set({ migrationNotice: false });
        break;
      default:
        throw Object.assign(new Error('INVALID_OPERATION'), { code: 'INVALID_OPERATION' });
    }
  }).then(() => respond({ ok: true }), error => respond({ ok: false, code: error.code, error: error.message }));
  return true;
});
