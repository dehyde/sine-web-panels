import assert from "node:assert/strict";
import { test } from "node:test";
import { createChromeWindow } from "./helpers/chrome-window.mjs";

const PREFS = {
  enabled: "sine.web-panels.enabled",
  collapsed: "sine.web-panels.collapsed",
  width: "sine.web-panels.width",
  items: "sine.web-panels.items",
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

  app.setRootAttribute("inFullscreen", "true");

  assert.ok(app.root().hasAttribute("fullscreen"));
  assert.equal(app.browser.getAttribute("sine-web-panels-side"), null);
  assert.equal(app.appContent.style.has("margin-inline-end"), false);

  app.setRootAttribute("inFullscreen", null);

  assert.equal(app.root().hasAttribute("fullscreen"), false);
  assert.ok(
    app.browser.style.getPropertyValue("--sine-web-panels-reserved-inline-size"),
    "and puts it back afterwards"
  );
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
  app.setRootAttribute("inFullscreen", "true");

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
    ["Back", "Forward", "Reload", "Home (reset this panel)"]
  );
  assert.equal(nav.querySelector(".sine-web-panels-nav-back").disabled, true, "no history yet");
  assert.equal(nav.querySelector(".sine-web-panels-nav-forward").disabled, true);
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
  assert.equal(nav.querySelector(".sine-web-panels-nav-back").disabled, false);
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
