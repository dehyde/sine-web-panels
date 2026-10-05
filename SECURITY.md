# Security

This document describes how Web Panels is built and what that does and does not protect against. Its purpose is to let you judge the mod for yourself. It is not a claim that the mod is "secure".

It covers the code on `main` from the commit that added this file. The measurements in it were taken on Zen 1.22.3b and 1.23b (Gecko 157) on Windows 11, between 2026-10-02 and 2026-10-05.

## Reporting a vulnerability

Please do not put vulnerability details in a public issue. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). If that option is not available, open an issue that only asks for a private contact, and one of the maintainers will reach you. The maintainers are Tom Bar-Gal (@dehyde, author and UX) and Diego Rueda (@akunito, technical maintainer). This is a volunteer project; expect an answer within one to two weeks.

## Threat model

Web Panels is a Sine mod. Like every Sine JavaScript mod, its scripts run in the browser's privileged chrome window (`chrome://browser/content/browser.xhtml`) with full chrome privileges, so a bug in the mod is a bug in the browser.

The property the mod aims for is this: **a web page shown in a panel must not gain anything it would not have as an ordinary tab.** That means no extra privilege, no way to run code in the parent process, and no way to make the browser load something an ordinary page could not.

Out of scope:
- a compromised Sine installation;
- another privileged mod;
- a tampered profile (`prefs.js`, `sessionstore`);
- a compromised content process, which can already send any IPC message.

## Why Zen removed native web panels, and what that has to do with this mod

Zen 1.11b removed its built-in web panels. According to Zen's release notes, the removal was "due to security concerns and difficulties in maintaining it", in the same release that "increased security by following Mozilla's new guidelines for parent process event handling". When this mod was first submitted to the Sine store ([sineorg/store#1037](https://github.com/sineorg/store/pull/1037)), the reviewers asked whether it addressed those concerns. They did not name a specific one, so this section does.

The guidelines Zen refers to are Mozilla's parent-process script hardening, tracked as [meta bug 1935985](https://bugzilla.mozilla.org/show_bug.cgi?id=1935985) ("Enforce strict script-security in the parent process"). It puts a Content Security Policy on `browser.xhtml` that forbids inline scripts and inline event-handler attributes (`on…="…"`), and moves the browser's own UI to `addEventListener`. The motivating case was a Pwn2Own sandbox escape ([bug 1782102](https://bugzilla.mozilla.org/show_bug.cgi?id=1782102)): a compromised content process got the parent to run `tab.setAttribute(name, data[name])` with an attacker-chosen `name="onoverflow"`, turning attacker data into script running in the parent.

Two common misreadings, stated plainly because a reviewer can check them:
- **This is not about web content being rendered inside browser chrome.** Zen's native panels were remote content in their own process too. The concern is chrome-side code that turns data into script: inline handlers, runtime `on…` attributes, string-built markup.
- **There is no CVE or security advisory for Zen's web panels.** The removal was a hardening and maintenance decision.

So the relevant questions for any web-panels mod are:
1. Does its chrome-side code turn data into script?
2. Does it route page content anywhere other than Firefox's normal, sandboxed tab pipeline?
3. Does it load anything with more privilege than the page needs?

The sections below answer them.

## How the mod is built

**Panels are ordinary tabs.** Each panel is a normal `gBrowser` tab:
- created with `gBrowser.addTab`;
- hidden from the tab strip with `gBrowser.hideTab`;
- displayed by moving Zen's `deck-selected` class onto that tab's own `.browserSidebarContainer`.

The mod never creates a `<browser>` element of its own, never makes one non-remote, and never puts web content into the chrome document. A panel's page therefore runs exactly where an ordinary tab's page runs. That is also why extensions and password managers work inside panels.

Measured on Zen 1.22.3b with a Gmail panel: the panel's browser was `remoteType = "webIsolated=https://google.com"` (Fission's site-isolated process) and `contentPrincipal.origin = "https://mail.google.com"`.

**No data becomes script in chrome.**
- The chrome-side code contains no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `new Function`, `createContextualFragment`, `DOMParser`, `loadSubScript`, inline `on…` attributes or `oncommand`.
- All UI is built with `createElement`, `setAttribute` and `textContent`. Page-derived strings (titles, URLs) only ever go into `textContent` or attribute values.
- Every attribute goes through one helper, `setElementAttributes`, which refuses any `on…` name outright. Callers pass literal names today; the guard keeps it that way and has its own test.
- Menu items and buttons use `addEventListener`.

**Nothing is loaded with the system principal.** Every page load the mod starts uses the destination site's own content principal, built by `loadPrincipalFor(url)`:
- panel creation;
- Home;
- the Split View pin;
- Open in New Tab;
- returning a restored panel to its site;
- the finder's search.

`loadPrincipalFor` returns nothing for anything but `http:`/`https:`, so `javascript:`, `data:`, `file:`, `about:`, `chrome:`, `view-source:`, `blob:` and `moz-extension:` URLs cannot be loaded at all. The loads use `addTab` and `openWebLinkIn`, never their `Trusted` twins.

Earlier versions used the system principal. In our measurement, Zen 1.23b already refused an HTTP redirect from a panel's site to `file:`, `about:`, `chrome:`, `view-source:` or `data:` with either principal, so this was not an exploitable hole there. The change is least privilege: it does not rely on those other checks staying in place.

**URLs.**
- Panel URLs are normalised and allow-listed to http(s) before they are stored or loaded.
- The finder builds search URLs with the default search engine; typed text is never loaded as a URL.
- A panel only remembers a page as "where it was" if it is on the panel's own origin. A panel restored from the session on another site's page (an auth provider, a followed link) is sent back to its own site once, on its first real page load.

**Permission prompts, fullscreen and the URL bar use Firefox's own UI.** While a panel is open, its tab is `gBrowser.selectedTab`. That means:
- Camera, microphone, location and notification prompts from the panel appear in the URL bar, attributed to the panel's site.
- Only the open panel can enter DOM fullscreen, with Firefox's own warning.
- A closed panel's prompts wait, queued by Firefox, until that panel is opened.

The mod does not reimplement any of this.

**The Escape frame script.** To let a page close its own preview with Escape before Escape closes the panel, the mod loads one small frame script (`scripts/web-panels-escape-frame.js`) into panel browsers only, never into ordinary tabs.
- It runs privileged in the panel's content process and reads the page only through Xray wrappers: one hit test at the viewport centre, and whether `[role=dialog]` / `aria-modal` / `<dialog open>` elements are visible.
- It sends four booleans and counts.
- Chrome reads one of them, `consumed === true`, and only to decide whether to close the panel, and only while an Escape that chrome itself saw is pending for the open panel's browser.
- A page cannot call into it or forge its message.
- If the script is missing or fails, chrome closes the panel after 400 ms as it always did.

It is a frame script and not a `JSWindowActor` because, measured on Zen 1.22.3b, actors registered at runtime never attach to web content.

**What is stored.** All state is stored in `sine.web-panels.*` prefs:
- the panel list (http(s) URLs and names you chose);
- width, shortcut modifier, navigation order, resizer colour (validated before it becomes CSS), and the collapsed flag;
- per panel, the last same-origin URL and the site name of the last title.

No credentials, cookies or form data are stored. Titles are stored as the site name only ("Gmail"), never the full tab title, which for Gmail includes the account address.

## What this does not cover

Read this part before relying on the mod:

- **Full chrome privileges.** As with every Sine mod, the code runs with full chrome privileges. Review it, or trust whoever did.
- **Trust indicators are split while a panel is open.** The URL bar, identity block, padlock and permission prompts describe the panel, while the tab strip still highlights the page behind it. Typing in the URL bar navigates the panel, and Ctrl+W closes the panel's tab.
- **The page behind keeps running as if visible.** Its timers are not throttled and autoplay is allowed.
- **Panels have no tab-strip presence.** A panel playing audio shows no audio indicator. Camera and microphone use still show Firefox's global sharing indicator.
- **Closed panels wait to prompt.** Permission prompts from a closed panel appear only when you next open it.
- **Last-visited URLs** are kept per panel in `prefs.js`, readable in `about:config`. They are the same URLs Firefox's session store keeps for every tab, but they can contain identifiers.
- **Favicons.** A panel's favicon falls back to fetching `/favicon.ico` from the panel's configured host, decoded in the parent process like Firefox's own favicons.
- **Escape in out-of-process iframes.** If you press Escape inside a cross-origin iframe in a panel, the frame script does not see it, and the panel closes after 400 ms.
- **Deprecated API.** Frame scripts (message managers) are a deprecated Firefox API. If they are removed, Escape handling falls back to the timeout; nothing else depends on them.
- **Zen internals.** The mod drives undocumented Zen internals (`deck-selected`, `gZenViewSplitter`, `hideTab`). A Zen update can change them without notice. We re-check them on each Zen release, but the failure mode of a change is broken behaviour, and we cannot promise it will never be a security-relevant one.
- **Not fuzzed.** Nothing here has been fuzzed or tested against a hostile page. The analysis is code reading, an independent review, the Firefox sources, and the measurements quoted above.

## Checking it yourself

- **Tests:** `node --test scripts/tests/*.mjs` runs the suite. `scripts/tests/security.test.mjs` covers:
  - the URL allow-list for loads;
  - the private-window origin attributes;
  - the `on…` attribute refusal;
  - a source check that no shipped script asks for `getSystemPrincipal`, `addTrustedTab` or `openTrustedLinkIn`.
- **Dangerous sinks:** `grep -nE "innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|DOMParser|loadSubScript|oncommand|getSystemPrincipal" scripts/*.mjs scripts/*.js` should print only comments.
- **Process and principal:** with a panel open, the Browser Toolbox shows its `<browser>` with a `webIsolated=` remote type and the site's own `contentPrincipal`. So does `about:processes`.
