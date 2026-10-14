# Sin Autoplay CL

It really bothers me how many websites disregard their users and autoplay videos without asking, especially news sites and media outlets. Opening an article shouldn't mean having a video start playing on its own.

Sin Autoplay CL is simply a tool to help users stay in control of what they watch on the internet. You decide when a video plays.

## What it does

Sin Autoplay CL is a Manifest V3 browser extension that blocks automatic video and audio playback while allowing you to start playback manually. It runs on websites covered by the extension's permissions, including embedded players in iframes.

From the extension's popup, you can:

- Turn autoplay blocking on or off.
- Keep players visible or hide them entirely.
- Allow playback on a particular site. Site exceptions also cover subdomains and embedded players on that site.

In blocking mode, use the player's Play button or native media controls to start playback. Enter and Space also work with accessible controls. Permission stays with the same media through pauses and playback retries; changing the source requires another interaction.

Turning blocking on pauses automatic playback already in progress and preserves playback you started manually. Turning it off restores the `autoplay` and `preload` attributes changed by the extension.

## Installation

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this repository's folder.
3. Open or reload the pages where you want to use the extension.

After updating the code, reload the extension and any open tabs so they receive the updated scripts.

## Limitations

Hiding or pausing a player does not guarantee that the website stops downloading media. Some custom players may need changes to how the extension recognizes their controls.

The code running in the page's `MAIN` world shares its environment with the website. The extension prevents the bypasses covered by its tests, but it is not a security boundary against a page that modifies other native APIs.

## Running the tests

Requirements: Node.js 20 or later and Playwright's Chromium.

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

You can also use an existing Chromium installation:

```sh
CHROMIUM_EXECUTABLE="/path/to/chromium" npm test
```

The tests load the extension into a temporary browser profile, serve silent PCM media from a local server, and use real mouse and keyboard input. Browser autoplay restrictions are disabled during testing so that blocking can be attributed to the extension. A separate test simulates a delayed storage read to check startup behavior.

Coverage includes HTML and JavaScript autoplay, synthetic events, manual and native controls, playback retries, source changes, audio, site exceptions in iframes, Shadow DOM, visibility modes, and configuration changes.

## Project structure

- `content.js` reads `chrome.storage.sync` in the isolated world and updates the attributes used by the CSS.
- `main-world.js` intercepts playback APIs and observes media elements. It receives preferences through a `MessagePort` transferred at startup and consumed before the page's listeners receive it. Changing the `<html>` attributes does not change the blocking state.
- `content.css` contains the rules for hiding players.
- `popup.js` and `popup.html` manage preferences.
- `tests/autoplay.test.cjs` contains the regression tests.
