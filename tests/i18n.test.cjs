const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const policy = require('../site-policy.js');
const root = resolve(__dirname, '..');
const read = file => readFileSync(resolve(root, file), 'utf8');
const en = JSON.parse(read('_locales/en/messages.json'));
const locales = readdirSync(resolve(root, '_locales'));

for (const locale of locales) {
  test(`${locale}: complete catalog, valid placeholders and HTML language`, () => {
    const catalog = JSON.parse(read(`_locales/${locale}/messages.json`));
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort());
    assert.equal(catalog.uiLanguage.message, locale.replace('_', '-'));
    for (const [key, entry] of Object.entries(catalog)) {
      assert.ok(entry.message.trim(), `${key} must not be empty`);
      assert.ok(entry.description?.trim(), `${key} needs translator context`);
      assert.deepEqual(entry.placeholders, en[key].placeholders, `${key}: placeholder contract`);
      const used = [...entry.message.matchAll(/\$([a-z]+)\$/g)].map(match => match[1]);
      assert.deepEqual([...new Set(used)].sort(), Object.keys(entry.placeholders || {}).sort(), key);
      assert.equal(entry.message.replace(/\$[a-z]+\$/g, '').includes('$'), false, key);
    }
  });
}

test('static UI and manifest message references exist in the default catalog', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.default_locale, 'en');
  for (const file of ['popup.html', 'options.html', 'manifest.json']) {
    const source = read(file);
    const keys = [...source.matchAll(/data-i18n(?:-aria-label|-placeholder)?="([A-Za-z]+)"|__MSG_(\w+)__/g)];
    assert.ok(keys.length, file);
    for (const match of keys) assert.ok(en[match[1] || match[2]], `${file}: ${match[0]}`);
  }
});

// This small catalog adapter exercises error mapping without giving the policy a
// browser dependency. Browser tests separately verify Chrome's actual catalogs.
for (const locale of ['en', 'es']) {
  test(`${locale}: policy errors and unknown failures become readable UI text`, () => {
    const catalog = JSON.parse(read(`_locales/${locale}/messages.json`));
    const scope = vm.createContext({ document: { documentElement: {}, querySelectorAll: () => [] },
      chrome: { i18n: { getMessage(key, value) {
        return catalog[key]?.message.replace(/\$[a-z]+\$/g, () => value) || '';
      } } } });
    vm.runInContext(read('i18n.js'), scope);
    for (const [input, code, key] of [
      ['', 'INVALID_URL', 'errorInvalidUrl'],
      ['ftp://example.com', 'UNSUPPORTED_URL', 'errorUnsupportedUrl'],
      ['*.example.com', 'INVALID_DOMAIN', 'errorInvalidDomain']
    ]) {
      assert.throws(() => policy.normalizeHost(input), error => {
        assert.equal(error.code, code);
        assert.equal(scope.SiteI18n.errorMessage(error), catalog[key].message);
        return true;
      });
    }
    assert.equal(scope.SiteI18n.errorMessage({ code: 'SAVE_FAILED' }), catalog.errorSaveFailed.message);
    assert.equal(scope.SiteI18n.errorMessage(null), catalog.errorUnexpected.message);
    assert.equal(scope.SiteI18n.errorMessage({ message: 'QUOTA_BYTES exceeded' }),
      catalog.errorUnexpectedDetails.message.replace('$details$', 'QUOTA_BYTES exceeded'));
    assert.equal(scope.SiteI18n.errorMessage({ code: 'toString' }), catalog.errorUnexpected.message);
  });
}

test('settings preserves worker error codes and handles missing replies', async () => {
  const scope = vm.createContext({ chrome: { runtime: {
    sendMessage: async () => ({ ok: false, code: 'INVALID_PREFERENCES', error: 'INVALID_PREFERENCES' })
  } } });
  vm.runInContext(read('settings.js'), scope);
  await assert.rejects(scope.SiteSettings.updatePreferences({ enabled: 'bad' }), { code: 'INVALID_PREFERENCES' });
  scope.chrome.runtime.sendMessage = async () => undefined;
  await assert.rejects(scope.SiteSettings.dismissNotice(), { code: 'SAVE_FAILED' });
});
