const { chromium } = require('playwright');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const browserLocale = process.env.TEST_LOCALE || 'en';
if (!/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(browserLocale)) throw new Error('Invalid TEST_LOCALE');
const catalogLocale = browserLocale.split('-')[0] === 'es' ? 'es' : 'en';

async function launchBrowser(root) {
  const folder = await mkdtemp(join(tmpdir(), 'sin-autoplay-test-'));
  const cleanup = () => rm(folder, { recursive: true, force: true });
  const executable = process.env.CHROMIUM_EXECUTABLE || chromium.executablePath();
  const options = {
    executablePath: executable,
    headless: true,
    locale: browserLocale,
    env: { ...process.env, LANGUAGE: browserLocale },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
      `--lang=${browserLocale}`, '--autoplay-policy=no-user-gesture-required']
  };
  // On macOS, --lang and Playwright's locale do not select the extension catalog.
  // Set AppleLanguages for this process only; never change the user's preferences.
  if (process.platform === 'darwin') {
    const launcher = join(folder, 'chromium-locale.sh');
    await writeFile(launcher,
      '#!/bin/sh\nexec "$CHROMIUM_LAUNCH_EXECUTABLE" -AppleLanguages "($TEST_LOCALE)" "$@"\n',
      { mode: 0o700 });
    options.executablePath = launcher;
    options.env.CHROMIUM_LAUNCH_EXECUTABLE = executable;
    options.env.TEST_LOCALE = browserLocale;
    // Chromium treats the AppleLanguages value as a startup target; headless
    // accepts only one, so omit Playwright's additional about:blank target.
    options.ignoreDefaultArgs = ['about:blank'];
  }
  try {
    return { context: await chromium.launchPersistentContext(join(folder, 'profile'), options), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
module.exports = { launchBrowser, browserLocale, catalogLocale };
