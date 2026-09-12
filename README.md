# Web Panels for Sine

Web Panels is a Sine mod that adds a temporary web-app panel rail to Zen Browser.

The saved Zen Browser implementation is only a reference. This repository is a standalone Sine mod using `theme.json`, `userChrome.css`, and userChromeJS modules.

Version `0.4.0` is Zen-only. It uses Zen-managed hidden tabs and Zen browser container overlay behavior so panel pages run through normal `gBrowser`/`linkedBrowser` plumbing. That is intentional: it should let browser extensions interact with panel pages the same way they interact with normal tabs.

![Web Panels preview](assets/preview.svg)

## Features

- Persistent web panel URLs stored in `sine.web-panels.items`.
- Favicon rail with a bottom `+` button.
- URL-only Add popup with validation for `http` and `https`; Edit (right-click a panel) adds an optional name, for when two accounts on one site would otherwise look the same.
- Tab context-menu action to add the clicked web tab to Web Panels.
- Floating panel surface that opens above the page without resizing it.
- Managed hidden-tab runtime for extension-compatible panel pages.
- Collapse the rail to a hover edge: a toggle at the top of the rail, the same
  shortcut modifier + `B`, or `Hide the rail` in the rail context menu. Hidden,
  it gives its strip of window back and slides in over the page while the
  pointer rests at that window edge.
- Outside-click and Escape dismissal.
- Resizable panel with a `320px` minimum width.
- Panel context menu: open in new tab, edit, move, unload, delete.
- Empty rail context menu: add spacer, new web panel.
- Spacer items with move/delete context menu.
- Drag reorder across panels and spacers.
- Unread count badge from title prefixes such as `(3) Inbox` or `[3] Inbox`.
- Panel tabs are reclaimed after a browser restart rather than coming back as
  ordinary tabs, using a session-store marker that survives one.
- Clean Sine unload handling for DOM, listeners, and live managed panel tabs.

## Install

1. Install Sine for your browser.
2. Open Sine Mods in browser settings.
3. Add this repository as a custom/unpublished mod.
4. Enable unsafe JavaScript if Sine requires it for local, non-store mods.
5. Restart the browser if Sine does not hot-load chrome scripts.

The mod is currently Zen-only. Other Firefox-family browsers would need a separate runtime path because this build depends on Zen's browser container/deck behavior.

## Preferences

- `sine.web-panels.enabled`: enables or disables the rail.
- `sine.web-panels.resizer-color`: colour of the resize handle, as any CSS
  colour. Empty follows the browser theme, which is both the default and the
  way back — clearing the field restores it.
- `sine.web-panels.collapsed`: how the rail was last left. Collapsing is
  per-window; this only seeds new windows and the next session. Not the same as
  disabling the rail — collapsed, every panel stays loaded.
- `sine.web-panels.width`: remembered floating panel width. Set by dragging the
  panel's edge; not exposed as a settings field, since the edge is the better
  control.
- `sine.web-panels.items`: JSON list of panel and separator items.

## Tests

```bash
node --test scripts/tests/*.mjs
```

`scripts/tests/helpers/chrome-window.mjs` is a fake chrome window — DOM, prefs,
observers, `gBrowser` and a hand-pumped clock — complete enough to mount the
real controller against. The tests drive the actual class through it rather
than asserting on the source text, so a rename does not fail them and a broken
behaviour does not pass them.

## Validate

Run the static package checks before publishing:

```bash
node scripts/validate-package.mjs
git diff --check
```

Manual browser checks:

- Install through Sine as a custom mod.
- Confirm the rail appears and reserves viewport space.
- Add a URL with the `+` button.
- Right-click a web tab and choose `Add to Web Panels`.
- Open, close, resize, unload, reorder, and delete panels.
- Verify an extension that affects normal tabs also affects the same URL when opened as a web panel.
- Use `Unload Web Panel`, reopen it, and confirm a fresh managed tab loads again.
- Disable the mod and confirm the rail, panel browsers, and listeners unload.

## Store Submission

The Sine store submission homepage is:

```text
https://github.com/dehyde/sine-web-panels
```

Store-origin installs should be able to run the included chrome JavaScript without requiring the local unsafe-JS toggle.

## License

This project is licensed under the [Mozilla Public License, version 2.0](LICENSE).
