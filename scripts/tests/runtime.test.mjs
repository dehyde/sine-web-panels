import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.Services = {
  scriptSecurityManager: {
    getSystemPrincipal() {
      return "system-principal";
    },
  },
};

const { WebPanelsRuntime } = await import("../web-panels-runtime.uc.mjs");

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.classList = new Set();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  closest(selector) {
    return selector === ".browserSidebarContainer" ? this : null;
  }
}

class FakeTab extends FakeElement {
  constructor(url) {
    super();
    this.url = url;
    this.linkedBrowser = new FakeElement();
    this.id = `tab-${Math.random().toString(16).slice(2)}`;
    this.closing = false;
  }
}

function createWindow() {
  const tabs = [];
  const hiddenTabs = [];
  const removedTabs = [];
  const calls = [];
  // Keyed by tab, the way SessionStore's custom values are.
  const sessionValues = new Map();

  return {
    calls,
    tabs,
    hiddenTabs,
    removedTabs,
    sessionValues,
    SessionStore: {
      setCustomTabValue(tab, key, value) {
        sessionValues.set(tab, { ...(sessionValues.get(tab) ?? {}), [key]: value });
      },
      getCustomTabValue(tab, key) {
        return sessionValues.get(tab)?.[key] ?? "";
      },
    },
    gBrowser: {
      tabs,
      selectedTab: null,
      addTrustedTab(url, options) {
        calls.push({ name: "addTrustedTab", url, options });
        const tab = new FakeTab(url);
        tabs.push(tab);
        return tab;
      },
      hideTab(tab, reason) {
        // Zen's hideTab returns early on the selected tab, silently. Model it,
        // or a test goes green while the browser does nothing at all.
        if (tab === this.selectedTab || tab.closing || tab.hidden) {
          return;
        }
        tab.hidden = true;
        hiddenTabs.push({ tab, reason });
      },
      removeTab(tab, options) {
        tab.closing = true;
        removedTabs.push({ tab, options });
        const index = tabs.indexOf(tab);
        if (index !== -1) {
          tabs.splice(index, 1);
        }
      },
    },
  };
}

// What a restart leaves behind: the tab and its session value survive, every
// attribute we stamped on the element does not.
function restartWindow(windowRef) {
  for (const tab of windowRef.tabs) {
    tab.attributes.clear();
    tab.owner = undefined;
    tab.hidden = false;
  }
  windowRef.hiddenTabs.length = 0;
  windowRef.calls.length = 0;
}

test("ensurePanelTab creates a trusted hidden tab with panel metadata", () => {
  const windowRef = createWindow();
  const runtime = new WebPanelsRuntime(windowRef);
  const parentTab = new FakeTab("https://parent.example/");
  parentTab.id = "parent-1";

  const tab = runtime.ensurePanelTab(
    { id: "panel-1", url: "https://calendar.example/" },
    parentTab
  );

  assert.equal(windowRef.calls.length, 1);
  assert.equal(windowRef.calls[0].name, "addTrustedTab");
  assert.equal(windowRef.calls[0].url, "https://calendar.example/");
  assert.equal(windowRef.calls[0].options.inBackground, true);
  assert.equal(windowRef.calls[0].options.skipAnimation, true);
  assert.equal(windowRef.calls[0].options.skipBackgroundNotify, true);
  assert.equal(windowRef.calls[0].options.triggeringPrincipal, "system-principal");
  assert.equal(tab.getAttribute("sine-web-panel-tab"), "true");
  assert.equal(tab.getAttribute("sine-web-panel-id"), "panel-1");
  assert.equal(tab.getAttribute("sine-web-panel-parent-id"), "parent-1");
  assert.equal(windowRef.hiddenTabs.length, 1);
  assert.equal(windowRef.hiddenTabs[0].tab, tab);
  assert.equal(windowRef.hiddenTabs[0].reason, "sine-web-panels");
});

test("ensurePanelTab reuses existing tabs and refreshes parent metadata", () => {
  const windowRef = createWindow();
  const runtime = new WebPanelsRuntime(windowRef);
  const firstParent = new FakeTab("https://first.example/");
  firstParent.id = "first-parent";
  const secondParent = new FakeTab("https://second.example/");
  secondParent.id = "second-parent";

  const firstTab = runtime.ensurePanelTab(
    { id: "panel-1", url: "https://calendar.example/" },
    firstParent
  );
  const reusedTab = runtime.ensurePanelTab(
    { id: "panel-1", url: "https://calendar.example/" },
    secondParent
  );

  assert.equal(reusedTab, firstTab);
  assert.equal(windowRef.calls.length, 1);
  assert.equal(reusedTab.getAttribute("sine-web-panel-parent-id"), "second-parent");
  assert.equal(runtime.get("panel-1").parentTab, secondParent);
});

test("unload removes the managed tab and clears runtime state", () => {
  const windowRef = createWindow();
  const runtime = new WebPanelsRuntime(windowRef);
  const tab = runtime.ensurePanelTab({ id: "panel-1", url: "https://calendar.example/" });

  runtime.unload("panel-1");

  assert.equal(windowRef.removedTabs.length, 1);
  assert.equal(windowRef.removedTabs[0].tab, tab);
  assert.deepEqual(windowRef.removedTabs[0].options, {
    animate: false,
    skipPermitUnload: true,
    skipSessionStore: true,
  });
  assert.equal(runtime.get("panel-1"), null);
});

test("unloadMissing keeps existing panel ids and removes stale panel tabs", () => {
  const windowRef = createWindow();
  const runtime = new WebPanelsRuntime(windowRef);
  const keptTab = runtime.ensurePanelTab({ id: "panel-keep", url: "https://keep.example/" });
  const removedTab = runtime.ensurePanelTab({ id: "panel-remove", url: "https://remove.example/" });

  runtime.unloadMissing(["panel-keep"]);

  assert.equal(runtime.get("panel-keep").tab, keptTab);
  assert.equal(runtime.get("panel-remove"), null);
  assert.equal(windowRef.removedTabs.length, 1);
  assert.equal(windowRef.removedTabs[0].tab, removedTab);
});

test("noteTabClosed clears the stored tab without deleting the panel record", () => {
  const windowRef = createWindow();
  const runtime = new WebPanelsRuntime(windowRef);
  runtime.ensurePanelTab({ id: "panel-1", url: "https://calendar.example/" });

  runtime.noteTabClosed("panel-1");

  assert.equal(runtime.get("panel-1").tab, undefined);
});

// --------------------------------------------------------------------------
// Session restore. The bug these pin: panels came back as ordinary tabs after
// a restart, and opening the panel then made a second tab beside the stranded
// one. Attributes do not survive a restart; a session value does.
// --------------------------------------------------------------------------

test("a panel tab is marked so it can be recognised after a restart", () => {
  const windowRef = createWindow();
  const runtime = new WebPanelsRuntime(windowRef);

  const tab = runtime.ensurePanelTab({ id: "panel-1", url: "https://calendar.example/" });

  assert.equal(
    windowRef.SessionStore.getCustomTabValue(tab, "sineWebPanelBacking"),
    "panel-1"
  );
});

test("a restored panel tab is reclaimed rather than left in the tab strip", () => {
  const windowRef = createWindow();
  const item = { id: "panel-1", url: "https://calendar.example/" };
  const tab = new WebPanelsRuntime(windowRef).ensurePanelTab(item);
  restartWindow(windowRef);

  // A fresh runtime, the way a restarted window gets one.
  const runtime = new WebPanelsRuntime(windowRef);
  const { adopted, swept } = runtime.adoptRestoredTabs([item]);

  assert.deepEqual(adopted, ["panel-1"]);
  assert.deepEqual(swept, []);
  assert.equal(windowRef.removedTabs.length, 0, "adoption keeps the tab");
  assert.equal(tab.getAttribute("sine-web-panel-tab"), "true", "marks reapplied");
  assert.equal(windowRef.hiddenTabs.at(-1)?.tab, tab, "hidden again");
  assert.equal(runtime.get("panel-1")?.tab, tab, "registered as the backing");
});

test("after adoption the panel opens the tab it already had", () => {
  const windowRef = createWindow();
  const item = { id: "panel-1", url: "https://calendar.example/" };
  const original = new WebPanelsRuntime(windowRef).ensurePanelTab(item);
  restartWindow(windowRef);

  const runtime = new WebPanelsRuntime(windowRef);
  runtime.adoptRestoredTabs([item]);
  const reopened = runtime.ensurePanelTab(item);

  assert.equal(reopened, original, "no second tab");
  assert.equal(windowRef.calls.length, 0, "nothing was created");
  assert.equal(windowRef.tabs.length, 1);
});

test("a marked tab whose panel is gone from the rail is swept", () => {
  const windowRef = createWindow();
  const deleted = { id: "panel-deleted", url: "https://gone.example/" };
  const tab = new WebPanelsRuntime(windowRef).ensurePanelTab(deleted);
  restartWindow(windowRef);

  const runtime = new WebPanelsRuntime(windowRef);
  const { adopted, swept } = runtime.adoptRestoredTabs([]);

  assert.deepEqual(adopted, []);
  assert.deepEqual(swept, ["panel-deleted"]);
  assert.equal(windowRef.removedTabs[0]?.tab, tab);
  assert.equal(windowRef.removedTabs[0]?.options.skipSessionStore, true);
});

test("ordinary tabs are never touched", () => {
  const windowRef = createWindow();
  const ordinary = new FakeTab("https://news.example/");
  windowRef.tabs.push(ordinary);

  const runtime = new WebPanelsRuntime(windowRef);
  const { adopted, swept } = runtime.adoptRestoredTabs([
    { id: "panel-1", url: "https://calendar.example/" },
  ]);

  assert.deepEqual(adopted, []);
  assert.deepEqual(swept, []);
  assert.equal(windowRef.removedTabs.length, 0);
  assert.equal(windowRef.hiddenTabs.length, 0);
  assert.equal(windowRef.tabs.length, 1);
});

test("a duplicate backing is swept rather than replacing the live tab", () => {
  const windowRef = createWindow();
  const item = { id: "panel-1", url: "https://calendar.example/" };
  const runtime = new WebPanelsRuntime(windowRef);
  const live = runtime.ensurePanelTab(item);

  // A second tab claiming the same panel — a restored one the runtime never
  // adopted, next to a tab it already opened this session.
  const stale = new FakeTab("https://calendar.example/");
  windowRef.SessionStore.setCustomTabValue(stale, "sineWebPanelBacking", "panel-1");
  windowRef.tabs.push(stale);

  const { adopted, swept } = runtime.adoptRestoredTabs([item]);

  assert.deepEqual(swept, ["panel-1"]);
  assert.deepEqual(adopted, ["panel-1"], "the live one is still claimed");
  assert.equal(windowRef.removedTabs[0]?.tab, stale);
  assert.equal(runtime.get("panel-1")?.tab, live, "the live tab is kept");
});

// --------------------------------------------------------------------------
// The selected tab. Opening a panel selects its tab, so that is the state the
// session is saved in — and Zen's hideTab returns early on the selected tab,
// silently. Adopting one without moving the selection first leaves the window
// displaying a panel backing as an ordinary tab, with every panel then unable
// to open because there is no visible tab to anchor the overlay to.
// --------------------------------------------------------------------------

test("a restored panel tab that holds the selection gives it up before hiding", () => {
  const windowRef = createWindow();
  const ordinary = new FakeTab("https://news.example/");
  windowRef.tabs.push(ordinary);

  const item = { id: "panel-1", url: "https://mail.example/" };
  const panelTab = new WebPanelsRuntime(windowRef).ensurePanelTab(item);
  restartWindow(windowRef);
  // Session restore brings it back selected, because that is how it was saved.
  windowRef.gBrowser.selectedTab = panelTab;

  const runtime = new WebPanelsRuntime(windowRef);
  const { adopted } = runtime.adoptRestoredTabs([item]);

  assert.deepEqual(adopted, ["panel-1"]);
  assert.equal(windowRef.gBrowser.selectedTab, ordinary, "selection handed over");
  assert.equal(panelTab.hidden, true, "and the hide actually took");
});

test("the last tab in a window is left visible rather than stranding it", () => {
  const windowRef = createWindow();
  const item = { id: "panel-1", url: "https://mail.example/" };
  const panelTab = new WebPanelsRuntime(windowRef).ensurePanelTab(item);
  restartWindow(windowRef);
  windowRef.gBrowser.selectedTab = panelTab;

  const runtime = new WebPanelsRuntime(windowRef);
  const { adopted, swept } = runtime.adoptRestoredTabs([item]);

  assert.deepEqual(adopted, [], "not claimed");
  assert.deepEqual(swept, [], "and certainly not deleted");
  assert.equal(panelTab.hidden, false, "a window must not sit on a hidden tab");
  assert.equal(windowRef.gBrowser.selectedTab, panelTab);
});
