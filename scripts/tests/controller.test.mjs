import assert from "node:assert/strict";
import { test } from "node:test";
import { createChromeWindow } from "./helpers/chrome-window.mjs";

const PREFS = {
  enabled: "sine.web-panels.enabled",
  collapsed: "sine.web-panels.collapsed",
  width: "sine.web-panels.width",
  items: "sine.web-panels.items",
  navigationOrder: "sine.web-panels.navigation-order",
};

// The controller reads globalThis.Services at import time, and createChromeWindow
// installs it, so the harness has to exist before the module is pulled in.
createChromeWindow();
const { SineWebPanels } = await import("../web-panels.uc.mjs");

// A real KeyboardEvent always carries every modifier as a boolean, and
// shortcutMatches compares them strictly — so a partial event does not just
// fail to match, it fails for the wrong reason.
function keydown(code, modifiers = {}) {
  return {
    code,
    key: "",
    repeat: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  };
}

function mount(options = {}) {
  const harness = createChromeWindow({
    prefs: { [PREFS.enabled]: true, ...options.prefs },
    viewportWidth: options.viewportWidth,
  });
  const controller = new SineWebPanels(harness.window);
  controller.init();

  return {
    ...harness,
    controller,
    el: id => harness.document.getElementById(`sine-web-panels-${id}`),
    root: () => harness.document.getElementById("sine-web-panels-root"),
  };
}

test("mounting builds the rail and reserves a strip of window for it", () => {
  const app = mount();

  assert.ok(app.el("rail"), "the rail exists");
  assert.ok(app.el("toggle"), "with the collapse toggle on it");
  assert.equal(app.root().getAttribute("side"), "right");
  assert.equal(app.browser.getAttribute("sine-web-panels-side"), "right");
  assert.ok(
    app.browser.style.getPropertyValue("--sine-web-panels-reserved-inline-size"),
    "the content is inset by the rail's width"
  );
  assert.ok(app.appContent.style.has("margin-inline-end"), "on the rail's side");

  app.controller.destroy();
  assert.equal(app.root(), null, "and unloading leaves nothing behind");
});

test("the rail keeps its fixed separator directly after the collapse toggle", () => {
  const app = mount();
  const rail = app.el("rail");
  const separator = app.el("rail-separator");

  assert.equal(rail.children[0], app.el("toggle"), "the collapse control stays first");
  assert.equal(separator.getAttribute("role"), "separator");
  assert.equal(rail.children[1], separator, "the separator cannot move into a panel's saved order");
  assert.equal(separator.dataset.itemId, undefined, "it is not a saved or draggable rail item");
});

test("a width stored from a wider window is clamped on the way in", () => {
  // The regression: mount used to apply the stored width raw, so it overflowed
  // until the first resize event happened to move it.
  const app = mount({ prefs: { [PREFS.width]: "2009" }, viewportWidth: 1200 });

  const applied = Number.parseInt(
    app.document.documentElement.style.getPropertyValue("--sine-web-panels-width"),
    10
  );

  assert.ok(applied < 2009, "clamped");
  assert.ok(applied <= 1200, "to the page, not the window");
  assert.equal(
    app.prefs.getStringPref(PREFS.width),
    "2009",
    "but the stored width is left alone — clamping is for display only"
  );
});

test("collapsing hands the reserved strip back and puts the hover edge up", () => {
  const app = mount();
  assert.equal(app.el("edge").hidden, true, "no edge while the rail is docked");

  app.el("toggle").dispatch("click");

  assert.ok(app.root().hasAttribute("collapsed"));
  assert.equal(app.el("edge").hidden, false, "the edge is now the way back");
  assert.equal(
    app.browser.getAttribute("sine-web-panels-side"),
    null,
    "the reserved strip is released"
  );
  assert.equal(app.appContent.style.has("margin-inline-end"), false);

  app.el("toggle").dispatch("click");

  assert.equal(app.root().hasAttribute("collapsed"), false);
  assert.ok(app.browser.style.getPropertyValue("--sine-web-panels-reserved-inline-size"));
});

test("collapsing is remembered for the next window, not broadcast to this one", () => {
  const app = mount();

  app.el("toggle").dispatch("click");
  assert.equal(app.prefs.getBoolPref(PREFS.collapsed), true, "written for next time");

  // What another window's toggle looks like from in here: the pref moves under
  // us. This window must not follow it.
  app.prefs.setBoolPref(PREFS.collapsed, false);
  assert.ok(app.root().hasAttribute("collapsed"), "still collapsed");
});

test("a new window opens the way the rail was last left", () => {
  const app = mount({ prefs: { [PREFS.collapsed]: true } });

  assert.ok(app.root().hasAttribute("collapsed"));
  assert.equal(app.el("edge").hidden, false);
});

test("the edge peeks the rail back in, and lets it go again", () => {
  const app = mount({ prefs: { [PREFS.collapsed]: true } });

  app.el("edge").dispatch("pointerenter");
  assert.ok(app.root().hasAttribute("peeking"));

  app.el("rail").dispatch("pointerleave");
  assert.ok(app.root().hasAttribute("peeking"), "not the instant the pointer leaves");

  app.advance(400);
  assert.equal(app.root().hasAttribute("peeking"), false, "but shortly after");
});

test("the peek is held open while a menu is up, so the rail cannot slide away", () => {
  const app = mount({ prefs: { [PREFS.collapsed]: true } });

  app.el("edge").dispatch("pointerenter");
  app.el("menu").hidden = false;
  app.el("rail").dispatch("pointerleave");

  app.advance(400);
  assert.ok(app.root().hasAttribute("peeking"), "held");

  app.el("menu").hidden = true;
  app.advance(400);
  assert.equal(app.root().hasAttribute("peeking"), false, "released");
});

test("fullscreen takes the rail off the screen and gives its strip back", () => {
  const app = mount();

  app.setRootAttribute("inDOMFullscreen", "true");

  assert.ok(app.root().hasAttribute("fullscreen"));
  assert.equal(app.browser.getAttribute("sine-web-panels-side"), null);
  assert.equal(app.appContent.style.has("margin-inline-end"), false);

  app.setRootAttribute("inDOMFullscreen", null);

  assert.equal(app.root().hasAttribute("fullscreen"), false);
  assert.ok(
    app.browser.style.getPropertyValue("--sine-web-panels-reserved-inline-size"),
    "and puts it back afterwards"
  );
});

test("native window fullscreen keeps the rail and its reserved strip", () => {
  const app = mount();

  // Zen sets inFullscreen for native macOS/F11 fullscreen too. The rail is
  // still browser chrome there, so it must remain available.
  app.setRootAttribute("inFullscreen", "true");

  assert.equal(app.root().hasAttribute("fullscreen"), false, "the rail stays rendered");
  assert.equal(app.browser.getAttribute("sine-web-panels-side"), "right");
  assert.ok(app.appContent.style.has("margin-inline-end"), "its strip stays reserved");
});

test("the rail moves when Zen's sidebar changes side", () => {
  const app = mount();
  assert.equal(app.root().getAttribute("side"), "right");
  assert.ok(app.appContent.style.has("margin-inline-end"));

  app.setRootAttribute("zen-right-side", "true");

  assert.equal(app.root().getAttribute("side"), "left", "opposite Zen's sidebar");
  assert.equal(app.browser.getAttribute("sine-web-panels-side"), "left");
  assert.ok(app.appContent.style.has("margin-inline-start"), "the strip swaps sides");
  assert.equal(app.appContent.style.has("margin-inline-end"), false, "and vacates the old one");
});

test("the configured shortcut toggles the rail", () => {
  const app = mount();

  app.document.dispatch("keydown", keydown("KeyB", { ctrlKey: true, altKey: true }));
  assert.ok(app.root().hasAttribute("collapsed"));

  app.document.dispatch("keydown", keydown("KeyB", { ctrlKey: true, altKey: true }));
  assert.equal(app.root().hasAttribute("collapsed"), false);
});

test("the shortcut is dormant in fullscreen", () => {
  const app = mount();
  app.setRootAttribute("inDOMFullscreen", "true");

  app.document.dispatch("keydown", keydown("KeyB", { ctrlKey: true, altKey: true }));

  assert.equal(
    app.prefs.getBoolPref(PREFS.collapsed, false),
    false,
    "no invisible rail toggling behind a fullscreen video"
  );
});

test("a custom handle colour is applied, and clearing it hands back to the theme", () => {
  const app = mount({ prefs: { "sine.web-panels.resizer-color": "#3b82f6" } });
  const root = app.document.documentElement;

  assert.equal(root.style.getPropertyValue("--sine-web-panels-accent"), "#3b82f6");

  app.prefs.setStringPref("sine.web-panels.resizer-color", "");
  assert.equal(
    root.style.has("--sine-web-panels-accent"),
    false,
    "removed, so the stylesheet's chain wins again"
  );
});

test("a colour that could escape the declaration never reaches the DOM", () => {
  const app = mount();

  app.prefs.setStringPref("sine.web-panels.resizer-color", "red; background: url(x)");

  assert.equal(app.document.documentElement.style.has("--sine-web-panels-accent"), false);
});

// --------------------------------------------------------------------------
// The window must never rest on a panel's backing tab. Two ways it got there:
// restoring a session saved with a panel open, and picking the panel's own
// site out of the address bar — UrlbarProviderOpenTabs does not filter hidden
// tabs, so backings are offered as switch-to-tab candidates. Once there, the
// page fills the window with no panel around it and no panel will open at all.
// --------------------------------------------------------------------------

// The harness's selectedTab fires TabSelect on assignment, as the browser's
// does, so selecting a tab below is the whole gesture.

test("selecting a panel's backing tab hands the window straight back", () => {
  const app = mount();
  const ordinary = app.addTab();
  const backing = app.addTab({ panelId: "panel-1", hidden: true });

  app.window.gBrowser.selectedTab = backing;

  assert.equal(
    app.window.gBrowser.selectedTab,
    ordinary,
    "the window cannot be left displaying a backing tab"
  );
});

test("an ordinary tab is left selected", () => {
  const app = mount();
  const first = app.addTab();
  const second = app.addTab();

  app.window.gBrowser.selectedTab = second;

  assert.equal(app.window.gBrowser.selectedTab, second, "no meddling");
  assert.notEqual(app.window.gBrowser.selectedTab, first);
});

test("the recovery holds when the backing is the tab a search landed on", () => {
  // Same invariant from the other entrance: no restart involved, the address
  // bar simply offered a hidden backing as a switch-to-tab candidate.
  const app = mount();
  app.addTab();
  const backing = app.addTab({ panelId: "panel-1", hidden: true });

  app.window.gBrowser.selectedTab = backing;
  // And again, in case the first correction is itself re-overridden — session
  // restore re-selects its own idea of the selected tab after we have run.
  app.window.gBrowser.selectedTab = backing;

  assert.notEqual(app.window.gBrowser.selectedTab, backing);
});

test("correcting the selection cannot set off another correction", () => {
  // The regression this pins: the guard used to open the panel it had just
  // taken the selection from. #openSurface selects that panel's tab on
  // purpose, and #activeId is only set after it returns, so the TabSelect
  // that fired looked like another stray backing — and round it went. Zen
  // crawled and every panel stopped working.
  const app = mount();
  const ordinary = app.addTab();
  const backing = app.addTab({ panelId: "panel-1", hidden: true });

  let selections = 0;
  const gBrowser = app.window.gBrowser;
  let current = backing;
  // Counting every assignment is the point here, so the harness's own
  // accessor is replaced by one that also keeps score.
  Object.defineProperty(gBrowser, "selectedTab", {
    configurable: true,
    get: () => current,
    set(tab) {
      current = tab;
      selections += 1;
      assert.ok(selections < 10, "the guard is looping");
      gBrowser.tabContainer.dispatch("TabSelect", { target: tab });
    },
  });

  gBrowser.tabContainer.dispatch("TabSelect", { target: backing });

  assert.equal(gBrowser.selectedTab, ordinary);
  assert.ok(selections <= 2, `settled in ${selections} selection(s)`);
});

// --------------------------------------------------------------------------
// Opening a panel selects its backing tab on purpose — that is how extensions
// resolve the panel's site. The guard above must recognise that as the
// controller's own doing, or it undoes every panel the moment it opens: the
// TabSelect it fires arrives before #activeId is assigned, so to the guard the
// backing looked stray, and the window was handed to the first ordinary tab
// instead. Every panel "opened" whatever tab happened to be first in the strip.
// --------------------------------------------------------------------------

function mountWithPanels(urls) {
  const items = urls.map((url, index) => ({ type: "panel", id: `panel-${index + 1}`, url }));
  const app = mount({ prefs: { [PREFS.items]: JSON.stringify(items) } });
  const ordinary = app.addTab({ url: "https://plane.example/", select: true });
  return { app, ordinary, items };
}

function railButton(app, id) {
  return app.root().querySelector(`[data-item-id="${id}"]`);
}

test("opening a panel from the rail leaves it open, on its own tab", () => {
  const { app, ordinary } = mountWithPanels(["https://mail.example/"]);

  railButton(app, "panel-1").dispatch("click");

  const selected = app.window.gBrowser.selectedTab;
  assert.equal(app.root().getAttribute("open"), "true", "the panel is open");
  assert.equal(app.root().getAttribute("active"), "panel-1");
  assert.equal(selected.getAttribute("sine-web-panel-id"), "panel-1", "its backing holds the selection");
  assert.notEqual(selected, ordinary, "the window was not handed back to the first ordinary tab");
  assert.ok(
    selected.linkedPanel.classList.contains("sine-web-panels-overlay"),
    "and its container is the overlay"
  );
});

test("the underlying tab is marked for viewport transparency without adding a scrim", () => {
  const { app, ordinary } = mountWithPanels(["https://mail.example/"]);

  railButton(app, "panel-1").dispatch("click");

  assert.ok(
    ordinary.linkedPanel.classList.contains("sine-web-panels-parent-background"),
    "the background tab receives the transparency hook"
  );
  assert.equal(Boolean(app.el("backdrop")), false, "no black overlay is mounted in Zen chrome or the page frame");

  railButton(app, "panel-1").dispatch("click");
  app.advance(100);

  assert.equal(ordinary.linkedPanel.classList.contains("sine-web-panels-parent-background"), false);
});

test("only the page behind is dimmed — never the panel, not even after switching panels", () => {
  const { app, ordinary } = mountWithPanels(["https://mail.example/", "https://plane.example/app"]);
  // Compare labels, never the tab objects: a failing deepEqual on fake tabs
  // serialises the whole circular fake DOM and ran WSL out of memory
  // (2026-10-02).
  const label = tab => tab.getAttribute("sine-web-panel-id") ?? "ordinary";
  const dimmed = () =>
    [...app.window.gBrowser.tabs]
      .filter(tab => tab.linkedPanel.classList.contains("sine-web-panels-parent-background"))
      .map(label);

  railButton(app, "panel-1").dispatch("click");
  assert.deepEqual(dimmed(), [label(ordinary)], "exactly one dimmed container: the parent tab's");

  railButton(app, "panel-2").dispatch("click");
  app.advance(100);
  assert.deepEqual(dimmed(), [label(ordinary)], "the switch neither dims a panel nor drops the parent's dimming");
  assert.equal(
    app.window.gBrowser.selectedTab.linkedPanel.classList.contains("sine-web-panels-parent-background"),
    false,
    "the visible panel is drawn at full opacity"
  );
});

test("switching panels moves the selection to the new panel's tab", () => {
  const { app, ordinary } = mountWithPanels(["https://mail.example/", "https://plane.example/app"]);

  railButton(app, "panel-1").dispatch("click");
  railButton(app, "panel-2").dispatch("click");

  const selected = app.window.gBrowser.selectedTab;
  assert.equal(app.root().getAttribute("active"), "panel-2");
  assert.equal(selected.getAttribute("sine-web-panel-id"), "panel-2");
  assert.notEqual(selected, ordinary);
});

test("closing a panel hands the window back to the tab it opened over", () => {
  const { app, ordinary } = mountWithPanels(["https://mail.example/"]);

  railButton(app, "panel-1").dispatch("click");
  railButton(app, "panel-1").dispatch("click");
  app.advance(100);

  assert.equal(app.root().hasAttribute("open"), false);
  assert.equal(app.window.gBrowser.selectedTab, ordinary);
});

test("a stray backing is still corrected while another panel is open", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  const stray = app.addTab({ panelId: "panel-9", hidden: true });

  railButton(app, "panel-1").dispatch("click");
  app.window.gBrowser.selectedTab = stray;

  assert.notEqual(app.window.gBrowser.selectedTab, stray);
});

// --------------------------------------------------------------------------
// The navigation controls live in the panel's frame and act on its browser.
// --------------------------------------------------------------------------

function navOf(app) {
  return app.window.gBrowser.selectedTab.linkedPanel.querySelector(".sine-web-panels-nav");
}

test("opening a panel mounts back, forward, reload and home beside it", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);

  railButton(app, "panel-1").dispatch("click");

  const nav = navOf(app);
  assert.ok(nav, "the controls are in the panel frame");
  assert.equal(nav.getAttribute("aria-orientation"), "vertical");
  assert.deepEqual(
    [...nav.querySelectorAll(".sine-web-panels-nav-button")].map(button => button.getAttribute("aria-label")),
    ["Back", "Forward", "Reload", "Home (reset this panel)", "Open in Split View"]
  );
  assert.equal(nav.querySelector(".sine-web-panels-nav-back").hidden, true, "no history yet");
  assert.equal(nav.querySelector(".sine-web-panels-nav-forward").hidden, true);
});

test("pin becomes available after an eligible panel surface opens", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  installSplitView(app);

  railButton(app, "panel-1").dispatch("click");

  assert.equal(
    navOf(app).querySelector(".sine-web-panels-nav-pin").hidden,
    false,
    "the native split action appears once the panel knows its parent tab"
  );
});

test("navigation order defaults to history first and updates from its setting", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  railButton(app, "panel-1").dispatch("click");

  const nav = navOf(app);
  assert.deepEqual(
    [...nav.querySelectorAll(".sine-web-panels-nav-button")].map(button => button.getAttribute("aria-label")),
    ["Back", "Forward", "Reload", "Home (reset this panel)", "Open in Split View"],
    "the existing order remains the default"
  );

  app.prefs.setStringPref(PREFS.navigationOrder, "home-first");

  assert.deepEqual(
    [...nav.querySelectorAll(".sine-web-panels-nav-button")].map(button => button.getAttribute("aria-label")),
    ["Home (reset this panel)", "Reload", "Back", "Forward", "Open in Split View"],
    "the alternative puts reset and refresh before history"
  );
});

test("panel navigation buttons opt out of Zen's global squircle shape", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);

  railButton(app, "panel-1").dispatch("click");

  for (const button of navOf(app).querySelectorAll(".sine-web-panels-nav-button")) {
    assert.ok(
      button.classList.contains("no-squircles"),
      "Zen's Glance controls stay circular even when the global squircle preference is on"
    );
  }
});

function installSplitView(app, { maxTabs = 4, groupTabs = [], splitResult = "success" } = {}) {
  const calls = [];
  const group = { tabs: [...groupTabs] };
  app.window.gZenViewSplitter = {
    MAX_TABS: maxTabs,
    _data: groupTabs.length ? [group] : [],
    splitTabs(tabs, layout, initialIndex) {
      calls.push({ tabs, layout, initialIndex });
      if (splitResult === "failure") {
        return undefined;
      }
      for (const tab of tabs) {
        if (!group.tabs.includes(tab)) {
          group.tabs.push(tab);
          tab.splitView = true;
        }
      }
      if (!this._data.length) {
        this._data.push(group);
      }
      app.window.gBrowser.selectedTab = tabs[initialIndex];
      return group;
    },
  };
  return { calls, group };
}

test("pin opens the panel's current location in a native split view, then closes the panel", () => {
  const { app, ordinary } = mountWithPanels(["https://mail.example/"]);
  const split = installSplitView(app);

  railButton(app, "panel-1").dispatch("click");
  app.window.gBrowser.selectedTab.linkedBrowser.currentURI.spec = "https://mail.example/inbox/42";
  navOf(app).querySelector(".sine-web-panels-nav-pin").dispatch("click");

  assert.equal(split.calls.length, 1, "Zen receives one split request");
  assert.equal(split.calls[0].layout, "vsep", "the split opens left-to-right");
  assert.equal(split.calls[0].initialIndex, 1, "the new right-hand tab is selected");
  assert.equal(split.calls[0].tabs[0], ordinary, "the existing page stays on the left");
  assert.equal(split.calls[0].tabs[1].linkedBrowser.currentURI.spec, "https://mail.example/inbox/42");
  assert.equal(app.root().hasAttribute("open"), false, "the Web Panel closes after the native split succeeds");
});

// --------------------------------------------------------------------------
// No load the mod starts may use the system principal (security audit
// 2026-10-02): with it, a redirect to file:/about:/chrome: is not checked.
// Principals are compared by kind and origin, never as objects.
// --------------------------------------------------------------------------

const principalOf = load => `${load.principal?.kind}:${load.principal?.origin}`;

test("panel creation, Split View and Home load as the site itself, never as the system", () => {
  const { app } = mountWithPanels(["https://mail.example/inbox"]);
  installSplitView(app);
  const gBrowser = app.window.gBrowser;

  railButton(app, "panel-1").dispatch("click");
  const browser = gBrowser.selectedTab.linkedBrowser;
  browser.currentURI.spec = "https://mail.example/thread/7";
  navOf(app).querySelector(".sine-web-panels-nav-pin").dispatch("click");
  assert.deepEqual(
    gBrowser.loads.map(load => `${load.via} ${principalOf(load)}`),
    ["addTab content:https://mail.example", "addTab content:https://mail.example"],
    "the panel tab and the split tab"
  );

  railButton(app, "panel-1").dispatch("click");
  let homePrincipal = null;
  gBrowser.selectedTab.linkedBrowser.loadURI = (_uri, options) => (homePrincipal = options.triggeringPrincipal);
  navOf(app).querySelector(".sine-web-panels-nav-home").dispatch("click");
  assert.equal(`${homePrincipal?.kind}:${homePrincipal?.origin}`, "content:https://mail.example");
});

test("the finder's search row asks the default engine and opens the result as that site", async () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  const opened = [];
  app.window.openWebLinkIn = (url, where, params) => opened.push(`${where} ${url} ${params.triggeringPrincipal?.kind}`);
  const previous = globalThis.Services.search;
  globalThis.Services.search = {
    getDefault: async () => ({
      getSubmission: query => ({ uri: { spec: `https://search.example/?q=${encodeURIComponent(query)}` } }),
    }),
  };
  try {
    app.document.dispatch("keydown", keydown("KeyP", { ctrlKey: true, altKey: true }));
    const input = app.document.querySelector("#sine-web-panels-finder input");
    input.value = "javascript:alert(1)";
    input.dispatch("input");
    app.document.getElementById("sine-web-panels-finder").dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, ["tab https://search.example/?q=javascript%3Aalert(1) content"], "typed text is a search, never a URL to load");
  } finally {
    globalThis.Services.search = previous;
  }
});

// --------------------------------------------------------------------------
// A restored panel tab comes back wherever the session saved it. The mod only
// remembers same-origin URLs, so a cross-origin page from the session (an
// auth provider, a followed link) is sent back to the panel's own site once.
// --------------------------------------------------------------------------

function restoredPanelAt(url) {
  const { app } = mountWithPanels(["https://mail.example/inbox"]);
  const tab = app.addTab({ url });
  app.window.SessionStore.setCustomTabValue(tab, "sineWebPanelBacking", "panel-1");
  const loads = [];
  tab.linkedBrowser.loadURI = (uri, options) =>
    loads.push(`${uri.spec} ${options.triggeringPrincipal?.kind}:${options.triggeringPrincipal?.origin}`);
  app.notify("sessionstore-windows-restored");
  return { app, tab, browser: tab.linkedBrowser, loads };
}

test("a panel restored on another site's page is sent back to its own site", () => {
  const { tab, loads } = restoredPanelAt("https://accounts.example/login");

  assert.equal(tab.getAttribute("sine-web-panel-id"), "panel-1", "adopted as the panel's backing");
  assert.deepEqual(loads, ["https://mail.example/inbox content:https://mail.example"]);
});

test("a lazily restored panel is checked when its page first arrives, and only then", () => {
  const { app, browser, loads } = restoredPanelAt("about:blank");
  assert.deepEqual(loads, [], "nothing to judge on a blank page");

  browser.currentURI.spec = "https://phish.example/";
  progress(app, browser).commit();
  assert.deepEqual(loads, ["https://mail.example/inbox content:https://mail.example"]);

  browser.currentURI.spec = "https://docs.example/shared";
  progress(app, browser).commit();
  assert.equal(loads.length, 1, "after the first check, where the user goes is the user's business");
});

test("a panel restored on its own site is left where it was", () => {
  const { loads } = restoredPanelAt("https://mail.example/thread/7");

  assert.deepEqual(loads, []);
});

// --------------------------------------------------------------------------
// Remembered titles keep only the site name: the full tab title is personal
// data (Gmail's carries the account address) and nothing shows more than the
// site name anyway.
// --------------------------------------------------------------------------

const TITLES_PREF = "sine.web-panels.last-titles";
const storedTitles = app => JSON.parse(app.prefs.getStringPref(TITLES_PREF, "{}"));

test("titles stored by older versions are reduced to the site name at startup", () => {
  const items = [{ type: "panel", id: "panel-1", url: "https://mail.example/" }];
  const app = mount({
    prefs: {
      [PREFS.items]: JSON.stringify(items),
      [TITLES_PREF]: JSON.stringify({ "panel-1": "Inbox (1,140) - someone@gmail.com - Gmail" }),
    },
  });

  assert.deepEqual(storedTitles(app), { "panel-1": "Gmail" });
});

test("a panel's title is remembered as its site name, never the full tab title", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  railButton(app, "panel-1").dispatch("click");
  const tab = app.window.gBrowser.selectedTab;

  tab.label = "(3) Inbox - someone@gmail.com - Gmail";
  app.window.gBrowser.tabContainer.dispatch("TabAttrModified", { target: tab });

  assert.equal(storedTitles(app)["panel-1"], "Gmail");
  assert.equal(JSON.stringify(storedTitles(app)).includes("@"), false, "no address at rest");
});

test("disabling and re-enabling the mod brings the tabs progress listener back, once", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  const listeners = () => app.window.gBrowser.progressListeners.length;
  assert.equal(listeners(), 1);

  app.prefs.setBoolPref(PREFS.enabled, false);
  assert.equal(listeners(), 0);
  app.prefs.setBoolPref(PREFS.enabled, true);
  assert.equal(listeners(), 1, "without it, URL memory and the Escape script re-injection stop");
  app.prefs.setBoolPref(PREFS.enabled, true);
  assert.equal(listeners(), 1, "never twice");
});

test("on builds without Services.search the finder finds the engine through its module", async () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  const opened = [];
  app.window.openWebLinkIn = (url, where, params) => opened.push(`${url} ${params.triggeringPrincipal?.kind}`);
  const previousSearch = globalThis.Services.search;
  const previousChromeUtils = globalThis.ChromeUtils;
  delete globalThis.Services.search; // measured: undefined on Zen 1.23b / Gecko 157
  globalThis.ChromeUtils = {
    importESModule: url => {
      assert.equal(url, "moz-src:///toolkit/components/search/SearchService.sys.mjs");
      return {
        SearchService: {
          getDefault: async () => ({ getSubmission: q => ({ uri: { spec: `https://www.google.com/search?q=${encodeURIComponent(q)}` } }) }),
        },
      };
    },
  };
  try {
    app.document.dispatch("keydown", keydown("KeyP", { ctrlKey: true, altKey: true }));
    const input = app.document.querySelector("#sine-web-panels-finder input");
    input.value = "zen sine mods";
    input.dispatch("input");
    app.document.getElementById("sine-web-panels-finder").dispatch("keydown", { key: "Enter", preventDefault() {}, stopPropagation() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, ["https://www.google.com/search?q=zen%20sine%20mods content"]);
  } finally {
    globalThis.Services.search = previousSearch;
    globalThis.ChromeUtils = previousChromeUtils;
  }
});

test("pin appends to the right of an existing split group until its fourth pane", () => {
  const { app, ordinary } = mountWithPanels(["https://mail.example/"]);
  const second = app.addTab({ url: "https://second.example/" });
  const third = app.addTab({ url: "https://third.example/" });
  ordinary.splitView = true;
  second.splitView = true;
  third.splitView = true;
  const split = installSplitView(app, { groupTabs: [ordinary, second, third] });

  railButton(app, "panel-1").dispatch("click");
  navOf(app).querySelector(".sine-web-panels-nav-pin").dispatch("click");

  assert.equal(split.calls.length, 1);
  assert.deepEqual(split.group.tabs.slice(0, 3), [ordinary, second, third]);
  assert.equal(split.group.tabs.length, 4, "the new page is appended as the fourth pane");
});

test("pin is unavailable when the parent tab already has four split panes", () => {
  const { app, ordinary } = mountWithPanels(["https://mail.example/"]);
  const second = app.addTab({ url: "https://second.example/" });
  const third = app.addTab({ url: "https://third.example/" });
  const fourth = app.addTab({ url: "https://fourth.example/" });
  for (const tab of [ordinary, second, third, fourth]) {
    tab.splitView = true;
  }
  const split = installSplitView(app, { groupTabs: [ordinary, second, third, fourth] });

  railButton(app, "panel-1").dispatch("click");
  const pin = navOf(app).querySelector(".sine-web-panels-nav-pin");
  assert.equal(pin.hidden, true, "the button is hidden rather than replacing an existing pane");
  pin.dispatch("click");
  assert.equal(split.calls.length, 0, "a stale click cannot create a fifth pane");
});

test("pin leaves the panel open and removes the temporary tab when Zen declines the split", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  const split = installSplitView(app, { splitResult: "failure" });

  railButton(app, "panel-1").dispatch("click");
  const tabCountBeforePin = app.window.gBrowser.tabs.length;
  navOf(app).querySelector(".sine-web-panels-nav-pin").dispatch("click");

  assert.equal(split.calls.length, 1);
  assert.equal(app.root().getAttribute("open"), "true", "the panel stays available after a failed native action");
  assert.equal(app.window.gBrowser.tabs.length, tabCountBeforePin, "the unused ordinary tab is rolled back");
});

test("back and forward follow the panel browser's history", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  railButton(app, "panel-1").dispatch("click");

  const browser = app.window.gBrowser.selectedTab.linkedBrowser;
  const calls = [];
  browser.canGoBack = true;
  browser.goBack = () => calls.push("back");
  browser.goForward = () => calls.push("forward");

  const nav = navOf(app);
  nav.querySelector(".sine-web-panels-nav-forward").dispatch("click");
  assert.deepEqual(calls, [], "forward is a no-op with nothing ahead");

  // The buttons re-read the state after every click, so the enabled state
  // catches up with the browser's without a separate event.
  nav.querySelector(".sine-web-panels-nav-back").dispatch("click");
  assert.deepEqual(calls, ["back"]);
  assert.equal(nav.querySelector(".sine-web-panels-nav-back").hidden, false);
});

test("the Backquote shortcut advances panels across keyboard layouts, skips separators, and wraps", () => {
  const app = mount({
    prefs: {
      [PREFS.items]: JSON.stringify([
        { type: "panel", id: "panel-1", url: "https://mail.example/" },
        { type: "separator", id: "separator-1" },
        { type: "panel", id: "panel-2", url: "https://chat.example/" },
      ]),
    },
  });
  app.addTab({ url: "https://plane.example/", select: true });

  app.document.dispatch("keydown", keydown("Backquote", {
    ctrlKey: true,
    altKey: true,
    key: "~",
  }));
  assert.equal(app.root().getAttribute("active"), "panel-1", "none open starts at the first panel");

  app.document.dispatch("keydown", keydown("Backquote", {
    ctrlKey: true,
    altKey: true,
    key: "`",
  }));
  assert.equal(app.root().getAttribute("active"), "panel-2", "the same physical key advances on another layout");

  app.document.dispatch("keydown", keydown("Backquote", {
    ctrlKey: true,
    altKey: true,
    key: "§",
  }));
  assert.equal(app.root().getAttribute("active"), "panel-1", "the last panel wraps to the first");
});

test("home reloads the panel's configured URL and forgets where it drifted to", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  app.prefs.setStringPref("sine.web-panels.last-urls", JSON.stringify({ "panel-1": "https://mail.example/thread/7" }));
  railButton(app, "panel-1").dispatch("click");

  const browser = app.window.gBrowser.selectedTab.linkedBrowser;
  const loads = [];
  browser.loadURI = uri => loads.push(uri.spec);

  navOf(app).querySelector(".sine-web-panels-nav-home").dispatch("click");

  assert.deepEqual(loads, ["https://mail.example/"]);
  assert.equal(JSON.parse(app.prefs.getStringPref("sine.web-panels.last-urls"))["panel-1"], undefined);
});

test("home hides history controls while it resets the panel", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  railButton(app, "panel-1").dispatch("click");

  const browser = app.window.gBrowser.selectedTab.linkedBrowser;
  browser.canGoBack = true;
  browser.canGoForward = true;
  browser.loadURI = () => {};

  navOf(app).querySelector(".sine-web-panels-nav-home").dispatch("click");

  assert.equal(navOf(app).querySelector(".sine-web-panels-nav-back").hidden, true);
  assert.equal(navOf(app).querySelector(".sine-web-panels-nav-forward").hidden, true);
});

// A remote <browser> never fires `load` in the parent, so the reset has to
// be driven by the tabs progress listener, the way Zen delivers it.
const STATE_STOP_WINDOW = 0x10 | 0x80000;

function progress(app, browser) {
  const listeners = app.window.gBrowser.progressListeners;
  return {
    commit({ isTopLevel = true } = {}) {
      listeners.forEach(l => l.onLocationChange?.(browser, { isTopLevel }, null, browser.currentURI, 0));
    },
    stop() {
      listeners.forEach(l => l.onStateChange?.(browser, { isTopLevel: true }, null, STATE_STOP_WINDOW, 0));
    },
  };
}

test("history controls come back once the user navigates away from the reset page", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  railButton(app, "panel-1").dispatch("click");

  const browser = app.window.gBrowser.selectedTab.linkedBrowser;
  browser.canGoBack = true;
  browser.canGoForward = false;
  browser.loadURI = () => {};
  const back = () => navOf(app).querySelector(".sine-web-panels-nav-back");
  const wire = progress(app, browser);

  navOf(app).querySelector(".sine-web-panels-nav-home").dispatch("click");
  wire.commit();
  wire.stop();
  assert.equal(back().hidden, true, "still hidden on the freshly reset page");

  wire.commit({ isTopLevel: false });
  assert.equal(back().hidden, true, "an iframe loading inside the reset page is not the user navigating");

  wire.commit();
  assert.equal(back().hidden, false, "the next navigation brings Back back");
});

test("a stop from the request Home aborted does not end the reset early", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  railButton(app, "panel-1").dispatch("click");

  const browser = app.window.gBrowser.selectedTab.linkedBrowser;
  browser.canGoBack = true;
  browser.loadURI = () => {};
  const back = () => navOf(app).querySelector(".sine-web-panels-nav-back");
  const wire = progress(app, browser);

  navOf(app).querySelector(".sine-web-panels-nav-home").dispatch("click");
  wire.stop();
  wire.commit();
  assert.equal(back().hidden, true, "the reset page itself committing must not reveal Back");
});

test("reload refreshes the page the panel is on, without resetting it", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  app.prefs.setStringPref("sine.web-panels.last-urls", JSON.stringify({ "panel-1": "https://mail.example/thread/7" }));
  railButton(app, "panel-1").dispatch("click");

  const browser = app.window.gBrowser.selectedTab.linkedBrowser;
  let reloads = 0;
  browser.reload = () => (reloads += 1);
  browser.loadURI = () => assert.fail("reload must not navigate");

  navOf(app).querySelector(".sine-web-panels-nav-reload").dispatch("click");

  assert.equal(reloads, 1);
  assert.equal(
    JSON.parse(app.prefs.getStringPref("sine.web-panels.last-urls"))["panel-1"],
    "https://mail.example/thread/7",
    "where the panel was is kept"
  );
});

// --------------------------------------------------------------------------
// Escape typed into a panel's page belongs to the page first: Gmail's
// attachment preview closes on it. Chrome sees the key before the page does,
// so the panel waits for the escape frame script's verdict.
// --------------------------------------------------------------------------

const ESCAPE_MESSAGE = "SineWebPanels:Escape";

function openPanelWithPage(urls = ["https://mail.example/"]) {
  const { app } = mountWithPanels(urls);
  railButton(app, "panel-1").dispatch("click");
  const browser = app.window.gBrowser.selectedTab.linkedBrowser;
  const isOpen = () => app.root().getAttribute("open") === "true";
  const escapeInPage = () => app.document.dispatch("keydown", { key: "Escape", target: browser });
  const verdict = consumed =>
    app.window.messageManager.deliver(ESCAPE_MESSAGE, browser, { consumed });
  return { app, browser, isOpen, escapeInPage, verdict };
}

test("Escape that closes the page's own preview leaves the panel open; the next one closes it", () => {
  const { isOpen, escapeInPage, verdict } = openPanelWithPage();

  escapeInPage();
  assert.equal(isOpen(), true, "chrome must not act before the page has answered");
  verdict(true);
  assert.equal(isOpen(), true, "the page used Escape to close its preview");

  escapeInPage();
  verdict(false);
  assert.equal(isOpen(), false, "nothing left in the page to close: the panel goes");
});

test("only a strict consumed === true from the page keeps the panel open", () => {
  const { app, browser, isOpen, escapeInPage } = openPanelWithPage();

  escapeInPage();
  app.window.messageManager.deliver(ESCAPE_MESSAGE, browser, { consumed: "yes" });
  assert.equal(isOpen(), false, "a content process does not get to be vague");
});

test("with no answer from the page the panel still closes, after the bounded wait", () => {
  const { app, isOpen, escapeInPage } = openPanelWithPage();

  escapeInPage();
  app.advance(399);
  assert.equal(isOpen(), true, "still waiting for the page");
  app.advance(1);
  assert.equal(isOpen(), false, "a page without the frame script behaves as before");
});

test("a late verdict after the timeout changes nothing", () => {
  const { app, isOpen, escapeInPage, verdict } = openPanelWithPage();

  escapeInPage();
  app.advance(400);
  assert.equal(isOpen(), false);
  app.advance(100);
  // Reopening must not be closed by the stale answer to the old key.
  railButton(app, "panel-1").dispatch("click");
  assert.equal(isOpen(), true);
  verdict(false);
  assert.equal(isOpen(), true);
});

test("Escape with focus in chrome closes the panel at once, without waiting", () => {
  const { app, isOpen } = openPanelWithPage();

  app.document.dispatch("keydown", { key: "Escape", target: app.root() });
  assert.equal(isOpen(), false);
});

test("a verdict from another browser is ignored", () => {
  const { app, isOpen, escapeInPage } = openPanelWithPage();
  const other = app.addTab({ url: "https://other.example/" }).linkedBrowser;

  escapeInPage();
  app.window.messageManager.deliver(ESCAPE_MESSAGE, other, { consumed: false });
  assert.equal(isOpen(), true, "only the open panel's page decides");
});

test("switching panels drops a pending Escape", () => {
  const { app, isOpen, escapeInPage } = openPanelWithPage(["https://mail.example/", "https://plane.example/"]);

  escapeInPage();
  railButton(app, "panel-2").dispatch("click");
  app.advance(400);
  assert.equal(isOpen(), true, "the timer of the old panel's Escape must not close the new one");
});

test("the escape frame script goes into panel browsers only, once per frame loader", () => {
  const { app, browser, escapeInPage } = openPanelWithPage();
  const scripts = () => browser.messageManager.frameScripts.filter(url => url.endsWith("web-panels-escape-frame.js")).length;

  assert.equal(scripts(), 1, "loaded when the panel opens");
  railButton(app, "panel-1").dispatch("click");
  app.advance(100);
  railButton(app, "panel-1").dispatch("click");
  assert.equal(scripts(), 1, "reopening on the same frame loader does not load it twice");

  // A cross-process navigation gives the browser a new frame loader.
  browser.frameLoader = {};
  progress(app, browser).commit();
  assert.equal(scripts(), 2, "the new process gets the script on its first commit");

  const ordinary = app.window.gBrowser.tabs.find(tab => !tab.getAttribute("sine-web-panel-id"));
  assert.equal(ordinary.linkedBrowser.messageManager.frameScripts.length, 0, "ordinary tabs never get it");
  escapeInPage();
});

// --------------------------------------------------------------------------
// Add is one field and one click; the name lives in Edit.
// --------------------------------------------------------------------------

function editorOf(app) {
  const editor = app.document.getElementById("sine-web-panels-editor");
  return {
    editor,
    url: editor.querySelector("#sine-web-panels-url-input"),
    name: editor.querySelector("#sine-web-panels-name-input"),
    submit: editor.querySelector("#sine-web-panels-editor-submit"),
    form: editor.querySelector("#sine-web-panels-editor-content"),
  };
}

function items(app) {
  return JSON.parse(app.prefs.getStringPref("sine.web-panels.items"));
}

test("Add asks for the URL and nothing else", () => {
  const app = mount();
  app.addTab({ url: "https://calendar.example/", select: true });

  app.el("add-button").dispatch("click");

  const { editor, url, name, submit } = editorOf(app);
  assert.equal(editor.hidden, false);
  assert.equal(editor.getAttribute("mode"), "add");
  assert.equal(name.hidden, true, "no name field on Add");
  assert.equal(submit.textContent, "Add");
  assert.equal(url.value, "https://calendar.example/", "prefilled from the current tab");
});

test("a panel added from the popup carries no name, even after an Edit left one behind", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);
  const { editor, url, name, form } = editorOf(app);

  railButton(app, "panel-1").dispatch("contextmenu");
  const edit = [...app.document.querySelectorAll(".sine-web-panels-menu-item")].find(
    button => button.textContent === "Edit Web Panel"
  );
  edit.dispatch("click");
  name.value = "Work";
  form.dispatch("submit");

  app.el("add-button").dispatch("click");
  url.value = "https://calendar.example/";
  form.dispatch("submit");

  const added = items(app).find(item => item.url === "https://calendar.example/");
  assert.ok(added, "the panel was added");
  assert.equal(added.name, undefined);
  assert.equal(editor.hidden, true, "the popup closed");
});

test("Edit shows the URL and the name together, and saves both", () => {
  const { app } = mountWithPanels(["https://mail.example/"]);

  railButton(app, "panel-1").dispatch("contextmenu");
  const edit = [...app.document.querySelectorAll(".sine-web-panels-menu-item")].find(
    button => button.textContent === "Edit Web Panel"
  );
  assert.ok(edit, "the context menu offers Edit");
  edit.dispatch("click");

  const { editor, url, name, submit, form } = editorOf(app);
  assert.equal(editor.getAttribute("mode"), "edit");
  assert.equal(name.hidden, false, "the name field is there");
  assert.equal(url.value, "https://mail.example/");
  assert.equal(submit.textContent, "Save");

  name.value = "Personal";
  url.value = "https://mail.example/u/1/";
  form.dispatch("submit");

  const [saved] = items(app);
  assert.equal(saved.name, "Personal");
  assert.equal(saved.url, "https://mail.example/u/1/");
});
