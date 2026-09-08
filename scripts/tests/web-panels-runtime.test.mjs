import assert from "node:assert/strict";
import test from "node:test";

const { WebPanelsRuntime } = await import("../web-panels-runtime.uc.mjs");
const {
  WebPanelsStore,
  normalizeWebPanelUrl,
} = await import("../web-panels-store.uc.mjs");

const PANEL_TAB_ATTRIBUTE = "sine-web-panel-tab";
const PANEL_ID_ATTRIBUTE = "sine-web-panel-id";
const ACTIVE_BROWSER_ATTRIBUTE = "sine-web-panel-active";
const ACTIVE_CONTAINER_CLASS = "sine-web-panel-native-overlay";

function createClassList() {
  const values = new Set();
  return {
    add(...names) {
      for (const name of names) {
        values.add(name);
      }
    },
    contains(name) {
      return values.has(name);
    },
    remove(...names) {
      for (const name of names) {
        values.delete(name);
      }
    },
    toArray() {
      return [...values];
    },
  };
}

function createStyle() {
  const values = new Map();
  return {
    getPropertyValue(name) {
      return values.get(name) ?? "";
    },
    removeProperty(name) {
      values.delete(name);
    },
    setProperty(name, value) {
      values.set(name, String(value));
    },
  };
}

function createEventTarget() {
  const listeners = new Map();
  let dispatchDepth = 0;
  return {
    addEventListener(type, listener, options = {}) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
      options.signal?.addEventListener?.("abort", () => entries.delete(listener), {
        once: true,
      });
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, target, detail = null) {
      dispatchDepth += 1;
      try {
        for (const listener of listeners.get(type) ?? []) {
          listener({ type, target, detail });
        }
      } finally {
        dispatchDepth -= 1;
      }
    },
    get dispatchDepth() {
      return dispatchDepth;
    },
    listenerCount() {
      return [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0);
    },
  };
}

function createAttributeTarget(tagName) {
  const events = createEventTarget();
  return {
    addEventListener: events.addEventListener,
    dispatch: events.dispatch,
    listenerCount: events.listenerCount,
    removeEventListener: events.removeEventListener,
    tagName,
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return this.attributes.has(name);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    toggleAttribute(name, force) {
      if (force) {
        this.setAttribute(name, "");
        return true;
      }
      this.removeAttribute(name);
      return false;
    },
  };
}

function createEnvironment({
  activationReadinessFailures = 0,
  failCreation = false,
  failHide = false,
  failPresentation = false,
  malformedCreation = false,
  selectDuringCreation = false,
  selectDuringSessionRestore = false,
  selectedTabOwner = null,
  startupOrphanCount = 0,
} = {}) {
  const addedTabs = [];
  const createdPrincipals = [];
  const createdUris = [];
  const hiddenTabs = [];
  const removedTabs = [];
  const serializedPrincipals = [];
  const selectionChangesDuringDispatch = [];
  const sessionStateReads = [];
  const sessionStateWrites = [];
  const sessionStates = new WeakMap();
  const tabContainer = createEventTarget();
  const browserToTab = new Map();
  const root = createAttributeTarget("div");
  root.style = createStyle();
  const surfaceEvents = [];
  const surfaceRect = { top: 7, left: 101, width: 410, height: 786 };
  const surfaceTranslation = { x: 0, y: 0 };
  const nativeContainerRect = { top: 3, left: 31, width: 500, height: 794 };
  const surfaceShell = createAttributeTarget("div");
  const surface = {
    closest(selector) {
      if (selector === "#sine-web-panels-root") {
        return root;
      }
      return selector === "#sine-web-panels-shell" ? surfaceShell : null;
    },
    dispatchEvent(event) {
      surfaceEvents.push(event);
      return true;
    },
    getBoundingClientRect() {
      return {
        ...surfaceRect,
        top: surfaceRect.top + surfaceTranslation.y,
        left: surfaceRect.left + surfaceTranslation.x,
      };
    },
  };

  const selectedBrowser = createAttributeTarget("browser");
  const selectedTab = {
    ...createAttributeTarget("tab"),
    closing: false,
    hidden: false,
    linkedBrowser: selectedBrowser,
    owner: selectedTabOwner,
    selected: true,
  };
  selectedBrowser.closest = () => null;

  const gBrowser = {
    selectedBrowser,
    selectedTab,
    tabContainer,
    tabs: [selectedTab],
    get visibleTabs() {
      return this.tabs.filter(tab => !tab.hidden && tab.visible !== false && !tab.closing);
    },
    addWebTab(url, options) {
      if (failCreation) {
        return null;
      }

      if (this.selectedTab.owner) {
        this.selectedTab.owner = null;
      }

      const containerClassList = createClassList();
      if (failPresentation) {
        const add = containerClassList.add;
        containerClassList.add = (...names) => {
          if (names.includes(ACTIVE_CONTAINER_CLASS)) {
            throw new Error("Synthetic native presentation failure.");
          }
          add(...names);
        };
      }
      const browserContainer = {
        ...createAttributeTarget("div"),
        classList: containerClassList,
        style: createStyle(),
        getBoundingClientRect() {
          return { ...nativeContainerRect };
        },
      };
      let activationAttempts = 0;
      let docShellIsActive = false;
      let renderLayers = false;
      const browser = {
        ...createAttributeTarget("browser"),
        contentTitle: "",
        currentURI: { spec: url },
        loadURICalls: [],
        reloadCount: 0,
        zenModeActive: false,
        closest(selector) {
          return selector === ".browserSidebarContainer"
            ? browserContainer
            : null;
        },
        loadURI(...args) {
          this.loadURICalls.push(args);
        },
        reload() {
          this.reloadCount += 1;
          const tab = browserToTab.get(this);
          tab?.removeAttribute("pending");
          const restoredState = tab ? sessionStates.get(tab) : null;
          const restoredUrl = restoredState?.entries?.[0]?.url;
          if (restoredUrl) {
            this.currentURI = { spec: restoredUrl };
          }
        },
      };
      Object.defineProperties(browser, {
        activationAttempts: {
          get() {
            return activationAttempts;
          },
        },
        docShellIsActive: {
          get() {
            return docShellIsActive;
          },
          set(value) {
            if (!value) {
              docShellIsActive = Boolean(this.zenModeActive);
              return;
            }
            activationAttempts += 1;
            docShellIsActive = activationAttempts > activationReadinessFailures;
          },
        },
        renderLayers: {
          get() {
            return renderLayers;
          },
          set(value) {
            renderLayers = Boolean(
              value && activationAttempts > activationReadinessFailures
            );
          },
        },
      });
      const tab = {
        ...createAttributeTarget("tab"),
        closing: false,
        hidden: false,
        linkedBrowser: malformedCreation ? null : browser,
        owner: selectedTab,
        selected: false,
        sessionValues: new Map(),
      };
      browserToTab.set(browser, tab);
      sessionStates.set(tab, {
        entries: [{ url }],
        index: 1,
      });
      this.tabs.push(tab);
      addedTabs.push({ options: { ...options }, tab, url });
      tabContainer.dispatch("TabOpen", tab);
      if (selectDuringCreation) {
        this.selectedTab = tab;
      }
      return tab;
    },
    getTabForBrowser(browser) {
      return browserToTab.get(browser) ?? null;
    },
    hideTab(tab, source) {
      hiddenTabs.push({ source, tab });
      if (failHide || tab.hidden || tab.selected || tab.closing) {
        return;
      }
      tab.hidden = true;
      tab.setAttribute("hidden", "true");
      tabContainer.dispatch("TabHide", tab);
      if (source) {
        tab.sessionValues.set("hiddenBy", source);
      }
    },
    showTab(tab) {
      if (!tab.hidden) {
        return;
      }
      tab.hidden = false;
      tab.removeAttribute("hidden");
      tabContainer.dispatch("TabShow", tab);
      tab.sessionValues.delete("hiddenBy");
    },
    removeTab(tab, options) {
      if (!tab || tab.closing) {
        return;
      }
      removedTabs.push({
        options: { ...options },
        selectedBeforeRemoval: this.selectedTab,
        tab,
      });
      tab.closing = true;
      tabContainer.dispatch("TabClose", tab);
      this.tabs = this.tabs.filter(candidate => candidate !== tab);
      if (tab.linkedBrowser) {
        browserToTab.delete(tab.linkedBrowser);
      }
    },
  };
  let currentSelectedTab = selectedTab;
  Object.defineProperty(gBrowser, "selectedTab", {
    configurable: true,
    get() {
      return currentSelectedTab;
    },
    set(tab) {
      if (tabContainer.dispatchDepth > 0) {
        selectionChangesDuringDispatch.push(tab);
      }
      if (currentSelectedTab) {
        currentSelectedTab.selected = false;
      }
      currentSelectedTab = tab;
      if (currentSelectedTab) {
        currentSelectedTab.selected = true;
      }
      this.selectedBrowser = tab?.linkedBrowser ?? null;
    },
  });

  function addUserTab({
    owner = null,
    select = true,
    url = "https://user-tab.example/",
  } = {}) {
    const browser = {
      ...createAttributeTarget("browser"),
      currentURI: { spec: url },
      docShellIsActive: true,
      renderLayers: true,
      zenModeActive: true,
    };
    const tab = {
      ...createAttributeTarget("tab"),
      closing: false,
      hidden: false,
      linkedBrowser: browser,
      owner,
      selected: false,
      sessionValues: new Map(),
    };
    browser.closest = () => null;
    browserToTab.set(browser, tab);
    gBrowser.tabs.push(tab);
    tabContainer.dispatch("TabOpen", tab);
    if (select) {
      gBrowser.selectedTab = tab;
      tabContainer.dispatch("TabSelect", tab);
    }
    return { browser, tab };
  }

  const startupOrphans = [];
  for (let index = 0; index < startupOrphanCount; index += 1) {
    const orphanBrowser = createAttributeTarget("browser");
    const orphan = {
      ...createAttributeTarget("tab"),
      closing: false,
      hidden: true,
      linkedBrowser: orphanBrowser,
      owner: null,
      selected: false,
      sessionValues: new Map([
        index === 0
          ? ["sineWebPanelBacking", `orphan-${index}`]
          : ["hiddenBy", "sine-web-panels"],
      ]),
      undiscardable: true,
    };
    browserToTab.set(orphanBrowser, orphan);
    gBrowser.tabs.push(orphan);
    startupOrphans.push(orphan);
  }

  class FakeResizeObserver {
    static instances = [];

    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      this.observed = [];
      FakeResizeObserver.instances.push(this);
    }

    disconnect() {
      this.disconnected = true;
    }

    observe(target) {
      this.observed.push(target);
    }

    unobserve(target) {
      this.observed = this.observed.filter(candidate => candidate !== target);
    }

    flush() {
      this.callback();
    }
  }

  class FakeMutationObserver extends FakeResizeObserver {}

  class FakeDOMMatrixReadOnly {
    constructor(transform) {
      const values = String(transform)
        .match(/^matrix\(([^)]+)\)$/)?.[1]
        ?.split(",")
        .map(value => Number.parseFloat(value.trim()));
      if (!values || values.length !== 6 || values.some(Number.isNaN)) {
        throw new Error("Unsupported synthetic transform.");
      }
      this.m41 = values[4];
      this.m42 = values[5];
    }
  }

  const scheduledTimers = new Map();
  const scheduledMicrotasks = [];
  let nextTimerId = 1;
  const windowEvents = createEventTarget();
  const windowRef = {
    AbortController,
    CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail ?? null;
      }
    },
    DOMMatrixReadOnly: FakeDOMMatrixReadOnly,
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    ChromeUtils: {
      importESModule(specifier) {
        assert.equal(specifier, "resource://gre/modules/E10SUtils.sys.mjs");
        return {
          E10SUtils: {
            serializePrincipal(principal) {
              serializedPrincipals.push(principal);
              return `serialized:${principal.uri.spec}`;
            },
          },
        };
      },
    },
    Services: {
      io: {
        newURI(url) {
          const uri = { spec: String(url) };
          createdUris.push(uri);
          return uri;
        },
      },
      scriptSecurityManager: {
        createContentPrincipal(uri, originAttributes) {
          const principal = { originAttributes, uri };
          createdPrincipals.push(principal);
          return principal;
        },
      },
    },
    SessionStore: {
      getTabState(tab) {
        sessionStateReads.push(tab);
        const state = sessionStates.get(tab);
        return state === undefined ? "" : JSON.stringify(state);
      },
      getCustomTabValue(tab, key) {
        return tab.sessionValues?.get(key) ?? "";
      },
      setTabState(tab, state) {
        const savedState = structuredClone(state);
        sessionStateWrites.push({ state: savedState, tab });
        sessionStates.set(tab, savedState);
        tab.setAttribute("pending", "true");
        if (selectDuringSessionRestore) {
          tab.hidden = false;
          tab.removeAttribute("hidden");
          tab.sessionValues?.delete("hiddenBy");
          gBrowser.selectedTab = tab;
        }
      },
      setCustomTabValue(tab, key, value) {
        tab.sessionValues ??= new Map();
        tab.sessionValues.set(key, String(value));
      },
    },
    addEventListener: windowEvents.addEventListener,
    document: {},
    gBrowser,
    getComputedStyle(target) {
      return {
        transform: target === surfaceShell
          ? `matrix(1, 0, 0, 1, ${surfaceTranslation.x}, ${surfaceTranslation.y})`
          : "none",
      };
    },
    removeEventListener() {},
    queueMicrotask(callback) {
      scheduledMicrotasks.push(callback);
    },
    setTimeout(callback) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      scheduledTimers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(timerId) {
      scheduledTimers.delete(timerId);
    },
  };

  const runtime = new WebPanelsRuntime(windowRef, surface);
  const flushTimers = (limit = 1_000) => {
    let flushed = 0;
    while (scheduledTimers.size) {
      if (flushed >= limit) {
        throw new Error(`Timer flush exceeded the ${limit} callback safety limit.`);
      }
      const [timerId, callback] = scheduledTimers.entries().next().value;
      scheduledTimers.delete(timerId);
      callback();
      flushed += 1;
    }
    return flushed;
  };
  const flushMicrotasks = (limit = 1_000) => {
    let flushed = 0;
    while (scheduledMicrotasks.length) {
      if (flushed >= limit) {
        throw new Error(`Microtask flush exceeded the ${limit} callback safety limit.`);
      }
      scheduledMicrotasks.shift()();
      flushed += 1;
    }
    return flushed;
  };
  return {
    addUserTab,
    addedTabs,
    browserToTab,
    createdPrincipals,
    createdUris,
    flushMicrotasks,
    flushTimers,
    gBrowser,
    hiddenTabs,
    removedTabs,
    serializedPrincipals,
    nativeContainerRect,
    resizeObserver: FakeResizeObserver.instances.at(-1),
    root,
    runtime,
    selectedBrowser,
    selectedTab,
    surface,
    surfaceEvents,
    surfaceRect,
    surfaceShell,
    surfaceTranslation,
    scheduledTimers,
    scheduledMicrotasks,
    selectionChangesDuringDispatch,
    sessionStateReads,
    sessionStateWrites,
    sessionStates,
    startupOrphans,
    tabContainer,
    windowEvents,
    windowRef,
  };
}

function captureConsoleErrors(callback) {
  const original = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    return { errors, result: callback() };
  } finally {
    console.error = original;
  }
}

function panel(id, url = `https://${id}.example/`) {
  return { id, url };
}

test("replacePanel restores the complete persisted panel snapshot", () => {
  const previousServices = globalThis.Services;
  const prefValues = new Map();
  globalThis.Services = {
    prefs: {
      getStringPref(name, fallback) {
        return prefValues.get(name) ?? fallback;
      },
      setStringPref(name, value) {
        prefValues.set(name, String(value));
      },
    },
  };

  try {
    const store = new WebPanelsStore();
    const original = {
      type: "panel",
      id: "custom-title",
      title: "My Social Feed",
      url: "https://social.example/home",
    };
    store.items = [original];
    store.updatePanel(original.id, "https://social.example/deep/thread");

    assert.deepEqual(store.replacePanel(original), original);
    assert.deepEqual(store.items, [original]);
  } finally {
    if (previousServices === undefined) {
      delete globalThis.Services;
    } else {
      globalThis.Services = previousServices;
    }
  }
});

test("creates one genuine hidden background tab without changing the selected tab", () => {
  const environment = createEnvironment();
  const beforeTabs = [...environment.gBrowser.tabs];

  const browser = environment.runtime.attach(panel("calendar"));
  const backingTab = environment.gBrowser.getTabForBrowser(browser);

  assert.ok(browser);
  assert.ok(backingTab);
  assert.equal(environment.addedTabs.length, 1);
  assert.equal(environment.addedTabs[0].url, "https://calendar.example/");
  assert.deepEqual(environment.addedTabs[0].options, {
    createLazyBrowser: false,
    inBackground: true,
    ownerTab: null,
    relatedToCurrent: false,
    skipAnimation: true,
    skipBackgroundNotify: true,
    skipRoute: true,
    userContextId: 0,
  });
  assert.equal(backingTab.getAttribute(PANEL_TAB_ATTRIBUTE), "true");
  assert.equal(backingTab.getAttribute(PANEL_ID_ATTRIBUTE), "calendar");
  assert.equal(backingTab.owner, null);
  assert.equal(backingTab.hidden, true);
  assert.equal(backingTab.undiscardable, true);
  assert.equal(backingTab.sessionValues.get("sineWebPanelBacking"), "calendar");
  assert.equal(backingTab.sessionValues.get("hiddenBy"), "sine-web-panels");
  assert.equal(environment.hiddenTabs.length, 1);
  assert.equal(environment.hiddenTabs[0].source, "sine-web-panels");
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.gBrowser.selectedBrowser, environment.selectedBrowser);
  assert.deepEqual(environment.gBrowser.visibleTabs, beforeTabs);
  environment.flushMicrotasks();
  assert.equal(backingTab.closing, false);
});

test("preserves the selected tab's owner relationship", () => {
  const parent = { id: "parent-tab" };
  const environment = createEnvironment({ selectedTabOwner: parent });

  environment.runtime.attach(panel("calendar"));

  assert.equal(environment.selectedTab.owner, parent);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
});

test("routes extension replies back to the exact originating panel browser", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("facebook", "https://www.facebook.com/"));

  const senderTab = environment.gBrowser.getTabForBrowser(browser);
  const tabId = environment.gBrowser.tabs.indexOf(senderTab) + 1;
  const resolvedTab = environment.gBrowser.tabs[tabId - 1];
  const tabsSendMessageTarget = resolvedTab.linkedBrowser;

  assert.equal(senderTab.linkedBrowser, browser);
  assert.equal(tabsSendMessageTarget, browser);
});

test("reuses the same tab, browser, and page state across close and reopen", () => {
  const environment = createEnvironment();
  const item = panel("linkedin", "https://www.linkedin.com/feed/");

  const firstBrowser = environment.runtime.attach(item);
  const firstTab = environment.gBrowser.getTabForBrowser(firstBrowser);
  firstBrowser.retainedPageState = {
    formValue: "draft",
    loadCount: 1,
    scrollY: 480,
  };
  const reopenedBrowser = environment.runtime.attach(item);

  assert.equal(reopenedBrowser, firstBrowser);
  assert.equal(environment.gBrowser.getTabForBrowser(reopenedBrowser), firstTab);
  assert.equal(environment.addedTabs.length, 1);
  assert.deepEqual(reopenedBrowser.retainedPageState, {
    formValue: "draft",
    loadCount: 1,
    scrollY: 480,
  });
});

test("switches active native containers without recreating either panel", () => {
  const environment = createEnvironment();
  const facebookBrowser = environment.runtime.attach(
    panel("facebook", "https://www.facebook.com/")
  );
  const facebookContainer = facebookBrowser.closest(".browserSidebarContainer");
  const linkedinBrowser = environment.runtime.attach(
    panel("linkedin", "https://www.linkedin.com/feed/")
  );
  const linkedinContainer = linkedinBrowser.closest(".browserSidebarContainer");

  assert.equal(facebookBrowser.getAttribute(ACTIVE_BROWSER_ATTRIBUTE), null);
  assert.equal(linkedinBrowser.getAttribute(ACTIVE_BROWSER_ATTRIBUTE), "");
  assert.equal(facebookContainer.classList.contains(ACTIVE_CONTAINER_CLASS), false);
  assert.equal(linkedinContainer.classList.contains(ACTIVE_CONTAINER_CLASS), true);
  assert.equal(facebookContainer.classList.contains("deck-selected"), false);
  assert.equal(linkedinContainer.classList.contains("deck-selected"), false);
  assert.equal(facebookBrowser.zenModeActive, false);
  assert.equal(facebookBrowser.docShellIsActive, false);
  assert.equal(facebookBrowser.renderLayers, false);
  assert.equal(linkedinBrowser.zenModeActive, true);
  assert.equal(linkedinBrowser.docShellIsActive, true);
  assert.equal(linkedinBrowser.renderLayers, true);

  const reopenedFacebook = environment.runtime.attach(
    panel("facebook", "https://www.facebook.com/")
  );

  assert.equal(reopenedFacebook, facebookBrowser);
  assert.equal(environment.addedTabs.length, 2);
  assert.equal(facebookContainer.classList.contains(ACTIVE_CONTAINER_CLASS), true);
  assert.equal(linkedinContainer.classList.contains(ACTIVE_CONTAINER_CLASS), false);
  assert.equal(facebookContainer.classList.contains("deck-selected"), false);
  assert.equal(linkedinContainer.classList.contains("deck-selected"), false);
  assert.equal(facebookBrowser.zenModeActive, true);
  assert.equal(facebookBrowser.docShellIsActive, true);
  assert.equal(facebookBrowser.renderLayers, true);
  assert.equal(linkedinBrowser.zenModeActive, false);
  assert.equal(linkedinBrowser.docShellIsActive, false);
  assert.equal(linkedinBrowser.renderLayers, false);
  assert.equal(environment.gBrowser.visibleTabs.length, 1);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
});

test("detach deactivates presentation and keeps the loaded backing tab reusable", () => {
  const environment = createEnvironment();
  const item = panel("facebook");
  const browser = environment.runtime.attach(item);
  const tab = environment.gBrowser.getTabForBrowser(browser);
  const container = browser.closest(".browserSidebarContainer");

  assert.equal(browser.zenModeActive, true);
  assert.equal(browser.docShellIsActive, true);
  assert.equal(browser.renderLayers, true);
  environment.runtime.detach();

  assert.equal(container.classList.contains(ACTIVE_CONTAINER_CLASS), false);
  assert.equal(browser.getAttribute(ACTIVE_BROWSER_ATTRIBUTE), null);
  assert.equal(browser.zenModeActive, false);
  assert.equal(browser.docShellIsActive, false);
  assert.equal(browser.renderLayers, false);
  assert.equal(environment.runtime.getBrowser("facebook"), browser);
  assert.equal(tab.closing, false);
  assert.equal(tab.undiscardable, true);
  assert.equal(environment.addedTabs.length, 1);

  assert.equal(environment.runtime.attach(item), browser);
  assert.equal(browser.zenModeActive, true);
  assert.equal(browser.docShellIsActive, true);
  assert.equal(browser.renderLayers, true);
  assert.equal(environment.addedTabs.length, 1);
});

test("repeated foreground tab handoffs leave every user tab visible and renderable", () => {
  const environment = createEnvironment();
  const items = [panel("facebook"), panel("keep")];
  const backingBrowsers = new Map();
  const userTabs = [];

  for (let index = 0; index < 30; index += 1) {
    const item = items[index % items.length];
    const browser = environment.runtime.attach(item);
    backingBrowsers.set(item.id, browser);
    const { browser: userBrowser, tab: userTab } = environment.addUserTab({
      url: `https://user-tab.example/${index}`,
    });
    userTabs.push(userTab);

    environment.runtime.detach();
    environment.flushMicrotasks();

    assert.equal(environment.gBrowser.selectedTab, userTab);
    assert.equal(userTab.hidden, false);
    assert.equal(userTab.closing, false);
    assert.equal(userTab.getAttribute(PANEL_TAB_ATTRIBUTE), null);
    assert.equal(userTab.getAttribute(PANEL_ID_ATTRIBUTE), null);
    assert.equal(userTab.sessionValues.has("sineWebPanelBacking"), false);
    assert.equal(userTab.sessionValues.has("hiddenBy"), false);
    assert.equal(userBrowser.zenModeActive, true);
    assert.equal(userBrowser.docShellIsActive, true);
    assert.equal(userBrowser.renderLayers, true);
    assert.equal(browser.zenModeActive, false);
    assert.equal(browser.docShellIsActive, false);
    assert.equal(browser.renderLayers, false);
    assert.equal(
      browser
        .closest(".browserSidebarContainer")
        .classList.contains("deck-selected"),
      false
    );
  }

  assert.equal(environment.addedTabs.length, 2);
  assert.equal(environment.removedTabs.length, 0);
  assert.equal(
    environment.gBrowser.visibleTabs.filter(tab => userTabs.includes(tab)).length,
    30
  );
  for (const item of items) {
    assert.equal(environment.runtime.attach(item), backingBrowsers.get(item.id));
    environment.runtime.detach();
  }
  assert.equal(environment.addedTabs.length, 2);
});

test("panel overlays never participate in Zen native deck selection", () => {
  const environment = createEnvironment();
  const item = panel("facebook");
  const initialUserContainer = {
    classList: createClassList(),
  };
  initialUserContainer.classList.add("deck-selected");
  const nativeDeckChildren = [initialUserContainer];
  let panelContainer = null;

  for (let index = 0; index < 12; index += 1) {
    const browser = environment.runtime.attach(item);
    panelContainer = browser.closest(".browserSidebarContainer");
    if (!nativeDeckChildren.includes(panelContainer)) {
      nativeDeckChildren.splice(1, 0, panelContainer);
    }

    assert.equal(
      panelContainer.classList.contains(ACTIVE_CONTAINER_CLASS),
      true
    );
    assert.equal(panelContainer.classList.contains("deck-selected"), false);

    const nextUserContainer = {
      classList: createClassList(),
    };
    nativeDeckChildren.push(nextUserContainer);
    nativeDeckChildren
      .find(container => container.classList.contains("deck-selected"))
      ?.classList.remove("deck-selected");
    nextUserContainer.classList.add("deck-selected");

    assert.deepEqual(
      nativeDeckChildren.filter(container =>
        container.classList.contains("deck-selected")
      ),
      [nextUserContainer]
    );

    environment.runtime.detach();
    assert.equal(
      panelContainer.classList.contains(ACTIVE_CONTAINER_CLASS),
      false
    );
    assert.equal(panelContainer.classList.contains("deck-selected"), false);
  }

  assert.equal(environment.addedTabs.length, 1);
});

test("keeps native overlay geometry aligned to the existing panel surface", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("calendar"));
  const container = browser.closest(".browserSidebarContainer");

  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-top"), "4px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-left"), "70px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-width"), "410px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-height"), "786px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-clip-top"), "4px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-clip-right"), "20px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-clip-bottom"), "4px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-clip-left"), "70px");
  assert.equal(environment.root.style.getPropertyValue("--sine-web-panel-surface-top"), "7px");
  assert.equal(environment.root.style.getPropertyValue("--sine-web-panel-surface-right"), "511px");
  assert.equal(environment.root.style.getPropertyValue("--sine-web-panel-surface-bottom"), "793px");
  assert.equal(environment.root.style.getPropertyValue("--sine-web-panel-surface-left"), "101px");
  assert.deepEqual(environment.resizeObserver.observed, [environment.surface, container]);
});

test("updates native overlay geometry after panel and window resizing", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("calendar"));
  const container = browser.closest(".browserSidebarContainer");

  Object.assign(environment.surfaceRect, {
    top: 11,
    left: 83,
    width: 512,
    height: 702,
  });
  environment.resizeObserver.flush();

  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-top"), "8px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-left"), "52px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-width"), "512px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-height"), "702px");

  environment.surfaceRect.width = 640;
  environment.windowEvents.dispatch("resize", environment);
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-width"), "640px");

  environment.nativeContainerRect.left = 49;
  environment.resizeObserver.flush();
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-left"), "34px");
});

test("removes the shell animation translation from native overlay geometry", () => {
  const environment = createEnvironment();
  environment.surfaceTranslation.x = 12;
  environment.surfaceTranslation.y = -4;

  const browser = environment.runtime.attach(panel("calendar"));
  const container = browser.closest(".browserSidebarContainer");

  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-top"), "4px");
  assert.equal(container.style.getPropertyValue("--sine-web-panel-native-left"), "70px");
});

test("retries native browser activation until the compositor is ready", () => {
  const environment = createEnvironment({ activationReadinessFailures: 2 });
  const browser = environment.runtime.attach(panel("linkedin"));

  assert.equal(browser.activationAttempts, 1);
  assert.equal(browser.docShellIsActive, false);
  assert.equal(browser.renderLayers, false);
  assert.equal(environment.scheduledTimers.size, 1);

  assert.equal(environment.flushTimers(), 2);
  assert.equal(browser.activationAttempts, 3);
  assert.equal(browser.docShellIsActive, true);
  assert.equal(browser.renderLayers, true);
  assert.equal(environment.scheduledTimers.size, 0);
});

test("invalidates a panel that never becomes render-ready instead of leaving it stuck", () => {
  const environment = createEnvironment({
    activationReadinessFailures: Number.POSITIVE_INFINITY,
  });
  const browser = environment.runtime.attach(panel("stuck"));
  const tab = environment.gBrowser.getTabForBrowser(browser);

  const { errors, result: flushed } = captureConsoleErrors(() =>
    environment.flushTimers()
  );

  assert.equal(flushed, 99);
  assert.equal(browser.activationAttempts, 100);
  assert.equal(environment.runtime.getBrowser("stuck"), null);
  assert.equal(tab.closing, true);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
  assert.equal(environment.surfaceEvents.length, 1);
  assert.deepEqual(environment.surfaceEvents[0].detail, {
    panelId: "stuck",
    reason: "activation-timeout",
  });
  assert.equal(errors.length, 1);
});

test("survives repeated switching without visible tabs, selection changes, or recreation", () => {
  const environment = createEnvironment();
  const items = [panel("a"), panel("b"), panel("c")];

  for (let index = 0; index < 300; index += 1) {
    environment.runtime.attach(items[index % items.length]);
    assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
    assert.deepEqual(environment.gBrowser.visibleTabs, [environment.selectedTab]);
  }

  assert.equal(environment.addedTabs.length, items.length);
  assert.equal(environment.gBrowser.tabs.length, items.length + 1);
});

test("fails closed and creates no tab for invalid or unsupported panel URLs", () => {
  const environment = createEnvironment();
  const unsafeUrls = [
    "",
    " \t\n ",
    "javascript:alert(1)",
    " JaVaScRiPt:alert(1) ",
    "java\nscript:alert(1)",
    "javascript%3Aalert(1)",
    "%6A%61%76%61%73%63%72%69%70%74:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///tmp/private.txt",
    "about:config",
    "chrome://browser/content/browser.xhtml",
    "resource://gre/modules/Services.sys.mjs",
    "moz-extension://extension-id/panel.html",
    "view-source:https://example.com/",
    "blob:https://example.com/opaque-id",
    "ftp://example.com/",
    "https://[",
    "http://",
    "http://exa mple.invalid/",
  ];

  assert.equal(environment.runtime.attach(null), null);
  assert.equal(environment.runtime.attach({ id: "missing-url" }), null);
  for (const [index, unsafeUrl] of unsafeUrls.entries()) {
    assert.equal(
      normalizeWebPanelUrl(unsafeUrl),
      null,
      `${unsafeUrl} must not normalize as a panel URL`
    );
    assert.equal(
      environment.runtime.attach({ id: `unsafe-${index}`, url: unsafeUrl }),
      null,
      `${unsafeUrl} must not create a panel backing tab`
    );
  }
  assert.equal(normalizeWebPanelUrl("example.com"), "https://example.com/");
  assert.equal(
    normalizeWebPanelUrl("HTTP://Example.COM/path"),
    "http://example.com/path"
  );
  assert.equal(
    normalizeWebPanelUrl("https://example.com/?next=javascript%3Aalert(1)"),
    "https://example.com/?next=javascript%3Aalert(1)"
  );
  assert.equal(environment.addedTabs.length, 0);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.gBrowser.selectedBrowser, environment.selectedBrowser);
});

test("rolls back partial creation failures without disturbing the selected tab", () => {
  const creationFailure = createEnvironment({ failCreation: true });
  const failedResult = captureConsoleErrors(() =>
    creationFailure.runtime.attach(panel("failed"))
  );
  assert.equal(failedResult.result, null);
  assert.equal(failedResult.errors.length, 1);
  assert.deepEqual(creationFailure.gBrowser.tabs, [creationFailure.selectedTab]);

  const malformed = createEnvironment({ malformedCreation: true });
  const malformedResult = captureConsoleErrors(() =>
    malformed.runtime.attach(panel("malformed"))
  );
  assert.equal(malformedResult.result, null);
  assert.equal(malformedResult.errors.length, 1);
  assert.equal(malformed.removedTabs.length, 1);
  assert.equal(malformed.gBrowser.selectedTab, malformed.selectedTab);
  assert.deepEqual(malformed.gBrowser.visibleTabs, [malformed.selectedTab]);
});

test("rolls back if Zen cannot hide the backing tab", () => {
  const environment = createEnvironment({ failHide: true });
  const { errors, result } = captureConsoleErrors(() =>
    environment.runtime.attach(panel("unhidden"))
  );

  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.equal(environment.removedTabs.length, 1);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
  assert.deepEqual(environment.gBrowser.visibleTabs, [environment.selectedTab]);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
});

test("rolls back if native tab creation unexpectedly changes the selected tab", () => {
  const environment = createEnvironment({ selectDuringCreation: true });
  const { errors, result } = captureConsoleErrors(() =>
    environment.runtime.attach(panel("selected"))
  );

  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.equal(environment.removedTabs.length, 1);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.gBrowser.selectedBrowser, environment.selectedBrowser);
});

test("disposes a backing tab if native presentation fails", () => {
  const environment = createEnvironment({ failPresentation: true });
  const { errors, result } = captureConsoleErrors(() =>
    environment.runtime.attach(panel("unpresentable"))
  );

  assert.equal(result, null);
  assert.equal(errors.length, 1);
  assert.equal(environment.runtime.getBrowser("unpresentable"), null);
  assert.equal(environment.removedTabs.length, 1);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
});

test("resetPanel applies exact history and resumes the same hidden tab restore once", () => {
  const environment = createEnvironment({ selectDuringSessionRestore: true });
  const item = panel("social", "https://social.example/home");
  const browser = environment.runtime.attach(item);
  const backingTab = environment.gBrowser.getTabForBrowser(browser);
  browser.currentURI.spec = "https://social.example/deep/thread";
  environment.sessionStates.set(backingTab, {
    entries: [
      {
        scroll: "0,0",
        title: "Home",
        url: item.url,
      },
      {
        scroll: "12,640",
        title: "Thread",
        triggeringPrincipal_base64: "stale-principal",
        url: browser.currentURI.spec,
      },
    ],
    extData: { retained: "yes" },
    image: "https://social.example/icon.svg",
    index: 2,
    scroll: "12,640",
  });

  assert.equal(environment.runtime.resetPanel(item, browser), true);

  assert.deepEqual(environment.sessionStateReads, [backingTab]);
  assert.equal(environment.sessionStateWrites.length, 1);
  assert.equal(environment.sessionStateWrites[0].tab, backingTab);
  assert.deepEqual(environment.sessionStateWrites[0].state, {
    entries: [
      {
        triggeringPrincipal_base64: `serialized:${item.url}`,
        url: item.url,
      },
    ],
    extData: { retained: "yes" },
    image: "https://social.example/icon.svg",
    index: 0,
  });
  assert.equal(
    Object.hasOwn(environment.sessionStateWrites[0].state, "scroll"),
    false
  );
  assert.deepEqual(environment.createdUris, [{ spec: item.url }]);
  assert.deepEqual(environment.createdPrincipals, [
    { originAttributes: {}, uri: environment.createdUris[0] },
  ]);
  assert.deepEqual(environment.serializedPrincipals, [
    environment.createdPrincipals[0],
  ]);
  assert.equal(backingTab.getAttribute("pending"), "true");
  assert.equal(backingTab.listenerCount(), 2);
  assert.equal(environment.runtime.getBrowser(item), browser);
  assert.equal(environment.gBrowser.getTabForBrowser(browser), backingTab);
  assert.equal(environment.addedTabs.length, 1);
  assert.equal(environment.removedTabs.length, 0);
  assert.deepEqual(browser.loadURICalls, []);
  assert.equal(browser.reloadCount, 0);
  assert.equal(backingTab.hidden, true);
  assert.equal(backingTab.getAttribute("hidden"), "true");
  assert.equal(backingTab.sessionValues.get("hiddenBy"), "sine-web-panels");
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.gBrowser.selectedBrowser, environment.selectedBrowser);
  assert.deepEqual(environment.gBrowser.visibleTabs, [environment.selectedTab]);

  assert.equal(environment.runtime.resetPanel(item, browser), true);
  assert.equal(environment.sessionStateWrites.length, 1);

  const laterBrowser = createAttributeTarget("browser");
  const laterUserTab = {
    ...createAttributeTarget("tab"),
    closing: false,
    hidden: false,
    linkedBrowser: laterBrowser,
    owner: null,
    selected: false,
  };
  environment.gBrowser.tabs.push(laterUserTab);
  environment.gBrowser.selectedTab = laterUserTab;
  environment.tabContainer.dispatch("TabSelect", laterUserTab);

  backingTab.dispatch("SSTabRestoring", backingTab);

  assert.equal(browser.reloadCount, 1);
  assert.equal(backingTab.getAttribute("pending"), null);
  assert.equal(backingTab.listenerCount(), 1);
  assert.equal(environment.scheduledTimers.size, 0);
  assert.equal(environment.runtime.adoptCurrentUrl(item, browser), false);
  assert.equal(environment.runtime.getBrowser(item), browser);
  assert.equal(environment.gBrowser.getTabForBrowser(browser), backingTab);
  assert.equal(environment.addedTabs.length, 1);
  assert.equal(environment.removedTabs.length, 0);
  assert.equal(backingTab.hidden, true);
  assert.equal(environment.gBrowser.selectedTab, laterUserTab);
  assert.equal(environment.gBrowser.selectedBrowser, laterBrowser);

  backingTab.dispatch("SSTabRestored", backingTab);

  assert.equal(backingTab.listenerCount(), 0);
  assert.equal(environment.runtime.adoptCurrentUrl(item, browser), true);
  assert.equal(environment.gBrowser.selectedTab, laterUserTab);
  assert.equal(environment.gBrowser.selectedBrowser, laterBrowser);
});

test("resetPanel waits for completion when Firefox starts hidden restoration automatically", () => {
  const environment = createEnvironment();
  const item = panel("social", "https://social.example/home");
  const browser = environment.runtime.attach(item);
  const backingTab = environment.gBrowser.getTabForBrowser(browser);

  assert.equal(environment.runtime.resetPanel(item, browser), true);
  backingTab.removeAttribute("pending");
  backingTab.dispatch("SSTabRestoring", backingTab);

  assert.equal(browser.reloadCount, 0);
  assert.equal(backingTab.listenerCount(), 1);
  assert.equal(environment.runtime.adoptCurrentUrl(item, browser), false);

  backingTab.dispatch("SSTabRestored", backingTab);

  assert.equal(backingTab.listenerCount(), 0);
  assert.equal(environment.runtime.adoptCurrentUrl(item, browser), true);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
});

test("resetPanel timeout removes only its stuck owned backing tab", () => {
  const environment = createEnvironment();
  const item = panel("social", "https://social.example/home");
  const browser = environment.runtime.attach(item);
  const backingTab = environment.gBrowser.getTabForBrowser(browser);

  assert.equal(environment.runtime.resetPanel(item, browser), true);
  assert.equal(backingTab.getAttribute("pending"), "true");
  const { errors } = captureConsoleErrors(() => environment.flushTimers());

  assert.equal(errors.length, 1);
  assert.equal(environment.runtime.getBrowser(item), null);
  assert.equal(backingTab.closing, true);
  assert.equal(environment.removedTabs.length, 1);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.gBrowser.selectedBrowser, environment.selectedBrowser);
  assert.deepEqual(environment.surfaceEvents.at(-1)?.detail, {
    panelId: item.id,
    reason: "reset-restore-timeout",
  });
});

test("resetPanel fails closed on malformed state and treats an unloaded panel as reset", () => {
  const environment = createEnvironment();
  const item = panel("social", "https://social.example/home");
  const browser = environment.runtime.attach(item);
  const backingTab = environment.gBrowser.getTabForBrowser(browser);
  environment.sessionStates.set(backingTab, { index: 1 });

  const { errors, result } = captureConsoleErrors(() =>
    environment.runtime.resetPanel(item, browser)
  );

  assert.equal(result, false);
  assert.equal(errors.length, 1);
  assert.deepEqual(environment.sessionStateReads, [backingTab]);
  assert.deepEqual(environment.sessionStateWrites, []);
  assert.equal(environment.runtime.getBrowser(item), browser);
  assert.equal(environment.gBrowser.getTabForBrowser(browser), backingTab);
  assert.equal(backingTab.hidden, true);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.addedTabs.length, 1);
  assert.equal(environment.removedTabs.length, 0);

  const unloaded = panel("unloaded", "https://unloaded.example/");
  assert.equal(environment.runtime.resetPanel(unloaded), true);
  assert.equal(environment.runtime.resetPanel(unloaded, browser), false);
  assert.equal(environment.addedTabs.length, 1);
});

test("adoptCurrentUrl preserves the exact native browser and extension tab identity", () => {
  const environment = createEnvironment();
  const original = panel("social", "https://social.example/home");
  const browser = environment.runtime.attach(original);
  const backingTab = environment.gBrowser.getTabForBrowser(browser);
  browser.currentURI.spec = "HTTPS://SOCIAL.EXAMPLE:443/deep/thread";
  const updated = panel("social", "https://social.example/deep/thread");

  assert.equal(environment.runtime.adoptCurrentUrl(updated, browser), true);
  assert.equal(environment.runtime.attach(updated), browser);

  assert.equal(environment.runtime.getBrowser(updated), browser);
  assert.equal(environment.gBrowser.getTabForBrowser(browser), backingTab);
  assert.equal(backingTab.linkedBrowser, browser);
  assert.equal(environment.addedTabs.length, 1);
  assert.equal(environment.removedTabs.length, 0);
  assert.deepEqual(browser.loadURICalls, []);
  assert.equal(browser.reloadCount, 0);
  assert.deepEqual(environment.sessionStateReads, []);
  assert.deepEqual(environment.sessionStateWrites, []);
  assert.equal(backingTab.hidden, true);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.gBrowser.selectedBrowser, environment.selectedBrowser);
});

test("panel URL actions fail closed when browser identity or current URL is stale", () => {
  const environment = createEnvironment();
  const original = panel("social", "https://social.example/home");
  const browser = environment.runtime.attach(original);
  const backingTab = environment.gBrowser.getTabForBrowser(browser);
  const wrongBrowser = createAttributeTarget("browser");
  const updated = panel("social", "https://social.example/replacement");

  browser.currentURI.spec = updated.url;
  const { result } = captureConsoleErrors(() => [
    environment.runtime.resetPanel(original, wrongBrowser),
    environment.runtime.adoptCurrentUrl(updated, wrongBrowser),
    (() => {
      browser.currentURI.spec = "https://social.example/navigation-race";
      return environment.runtime.adoptCurrentUrl(updated, browser);
    })(),
  ]);

  assert.deepEqual(result, [false, false, false]);
  assert.equal(environment.runtime.attach(original), browser);
  assert.equal(environment.gBrowser.getTabForBrowser(browser), backingTab);
  assert.equal(environment.addedTabs.length, 1);
  assert.equal(environment.removedTabs.length, 0);
  assert.deepEqual(environment.sessionStateReads, []);
  assert.deepEqual(environment.sessionStateWrites, []);
  assert.deepEqual(browser.loadURICalls, []);
  assert.equal(browser.reloadCount, 0);
  assert.equal(backingTab.hidden, true);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.gBrowser.selectedBrowser, environment.selectedBrowser);
});

test("recreates exactly one backing tab when a panel URL changes", () => {
  const environment = createEnvironment();
  const firstBrowser = environment.runtime.attach(
    panel("social", "https://www.facebook.com/")
  );
  const firstTab = environment.gBrowser.getTabForBrowser(firstBrowser);

  const secondBrowser = environment.runtime.attach(
    panel("social", "https://www.linkedin.com/feed/")
  );
  const secondTab = environment.gBrowser.getTabForBrowser(secondBrowser);

  assert.notEqual(secondBrowser, firstBrowser);
  assert.notEqual(secondTab, firstTab);
  assert.equal(firstTab.closing, true);
  assert.equal(secondTab.closing, false);
  assert.equal(environment.addedTabs.length, 2);
  assert.equal(environment.removedTabs.length, 1);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab, secondTab]);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
});

test("unload removes only its owned backing tab and leaves unrelated tabs untouched", () => {
  const environment = createEnvironment();
  const firstBrowser = environment.runtime.attach(panel("first"));
  const secondBrowser = environment.runtime.attach(panel("second"));
  const firstTab = environment.gBrowser.getTabForBrowser(firstBrowser);
  const secondTab = environment.gBrowser.getTabForBrowser(secondBrowser);

  environment.runtime.unload("first");

  assert.equal(firstTab.closing, true);
  assert.equal(secondTab.closing, false);
  assert.equal(environment.runtime.getBrowser("first"), null);
  assert.equal(environment.runtime.getBrowser("second"), secondBrowser);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab, secondTab]);
  assert.equal(environment.removedTabs.length, 1);
  assert.deepEqual(environment.removedTabs[0].options, {
    animate: false,
    skipPermitUnload: true,
    skipSessionStore: true,
  });
});

test("active unload invalidates the controller instead of leaving a blank open panel", () => {
  const environment = createEnvironment();
  environment.runtime.attach(panel("active"));

  environment.runtime.unload("active");

  assert.equal(environment.runtime.getBrowser("active"), null);
  assert.equal(environment.surfaceEvents.length, 1);
  assert.deepEqual(environment.surfaceEvents[0].detail, {
    panelId: "active",
    reason: "unload",
  });
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
});

test("unloadMissing removes exactly the panels no longer present", () => {
  const environment = createEnvironment();
  environment.runtime.attach(panel("keep"));
  environment.runtime.attach(panel("remove-a"));
  environment.runtime.attach(panel("remove-b"));

  environment.runtime.unloadMissing(["keep"]);

  assert.ok(environment.runtime.getBrowser("keep"));
  assert.equal(environment.runtime.getBrowser("remove-a"), null);
  assert.equal(environment.runtime.getBrowser("remove-b"), null);
  assert.equal(environment.removedTabs.length, 2);
});

test("re-hides an owned backing tab if another component shows it", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("facebook"));
  const tab = environment.gBrowser.getTabForBrowser(browser);
  const initialHideCount = environment.hiddenTabs.length;
  environment.flushMicrotasks();

  environment.gBrowser.showTab(tab);

  assert.equal(tab.hidden, false);
  assert.equal(tab.sessionValues.has("hiddenBy"), false);
  assert.equal(tab.sessionValues.get("sineWebPanelBacking"), "facebook");
  assert.equal(environment.scheduledMicrotasks.length, 1);
  environment.flushMicrotasks();

  assert.equal(tab.hidden, true);
  assert.equal(tab.sessionValues.get("hiddenBy"), "sine-web-panels");
  assert.equal(tab.sessionValues.get("sineWebPanelBacking"), "facebook");
  assert.equal(environment.hiddenTabs.length, initialHideCount + 1);
  assert.equal(environment.runtime.getBrowser("facebook"), browser);
  assert.deepEqual(environment.gBrowser.visibleTabs, [environment.selectedTab]);
});

test("repairs a shown and selected panel tab after native event dispatch and before paint", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("facebook"));
  const tab = environment.gBrowser.getTabForBrowser(browser);
  environment.flushMicrotasks();

  environment.gBrowser.selectedTab = tab;
  environment.gBrowser.showTab(tab);
  environment.tabContainer.dispatch("TabSelect", tab);

  assert.equal(environment.gBrowser.selectedTab, tab);
  assert.equal(tab.hidden, false);
  assert.equal(tab.sessionValues.has("hiddenBy"), false);
  assert.equal(environment.selectionChangesDuringDispatch.length, 0);
  assert.equal(environment.scheduledMicrotasks.length, 1);
  environment.flushMicrotasks();

  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(tab.hidden, true);
  assert.equal(tab.sessionValues.get("hiddenBy"), "sine-web-panels");
  assert.equal(tab.sessionValues.get("sineWebPanelBacking"), "facebook");
  assert.equal(environment.runtime.getBrowser("facebook"), browser);
  assert.deepEqual(environment.gBrowser.visibleTabs, [environment.selectedTab]);
});

test("restores the user tab if an extension attempts to select a backing tab", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("facebook"));
  const tab = environment.gBrowser.getTabForBrowser(browser);
  const container = browser.closest(".browserSidebarContainer");
  environment.flushMicrotasks();

  environment.gBrowser.selectedTab = tab;
  environment.gBrowser.selectedBrowser = browser;
  environment.tabContainer.dispatch("TabSelect", tab);

  assert.equal(environment.gBrowser.selectedTab, tab);
  assert.equal(container.classList.contains("deck-selected"), false);
  assert.equal(environment.selectionChangesDuringDispatch.length, 0);
  environment.flushMicrotasks();

  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.gBrowser.selectedBrowser, environment.selectedBrowser);
  assert.equal(container.classList.contains("deck-selected"), false);
  assert.equal(container.classList.contains(ACTIVE_CONTAINER_CLASS), true);
  assert.equal(browser.getAttribute(ACTIVE_BROWSER_ATTRIBUTE), "");
});

test("does not present an inactive backing tab while repairing its selection", () => {
  const environment = createEnvironment();
  const inactiveBrowser = environment.runtime.attach(panel("facebook"));
  const inactiveTab = environment.gBrowser.getTabForBrowser(inactiveBrowser);
  const inactiveContainer = inactiveBrowser.closest(".browserSidebarContainer");
  const activeBrowser = environment.runtime.attach(panel("linkedin"));
  const activeContainer = activeBrowser.closest(".browserSidebarContainer");
  environment.flushMicrotasks();

  environment.gBrowser.selectedTab = inactiveTab;
  environment.tabContainer.dispatch("TabSelect", inactiveTab);
  environment.flushMicrotasks();

  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(inactiveContainer.classList.contains("deck-selected"), false);
  assert.equal(inactiveContainer.classList.contains(ACTIVE_CONTAINER_CLASS), false);
  assert.equal(inactiveBrowser.getAttribute(ACTIVE_BROWSER_ATTRIBUTE), null);
  assert.equal(activeContainer.classList.contains("deck-selected"), false);
  assert.equal(activeContainer.classList.contains(ACTIVE_CONTAINER_CLASS), true);
  assert.equal(activeBrowser.getAttribute(ACTIVE_BROWSER_ATTRIBUTE), "");
});

test("restores the most recently selected user tab instead of the attach-time tab", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("facebook"));
  const backingTab = environment.gBrowser.getTabForBrowser(browser);
  environment.flushMicrotasks();

  const secondBrowser = createAttributeTarget("browser");
  const secondUserTab = {
    ...createAttributeTarget("tab"),
    closing: false,
    hidden: false,
    linkedBrowser: secondBrowser,
    owner: null,
    selected: false,
  };
  environment.gBrowser.tabs.push(secondUserTab);
  environment.gBrowser.selectedTab = secondUserTab;
  environment.tabContainer.dispatch("TabSelect", secondUserTab);

  environment.gBrowser.selectedTab = backingTab;
  environment.tabContainer.dispatch("TabSelect", backingTab);
  environment.flushMicrotasks();

  assert.equal(environment.gBrowser.selectedTab, secondUserTab);
  assert.equal(environment.gBrowser.selectedBrowser, secondBrowser);
});

test("does not restore a most-recent user tab hidden by another feature or collapsed group", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("facebook"));
  const backingTab = environment.gBrowser.getTabForBrowser(browser);
  environment.flushMicrotasks();

  const hiddenBrowser = createAttributeTarget("browser");
  const hiddenUserTab = {
    ...createAttributeTarget("tab"),
    closing: false,
    hidden: false,
    linkedBrowser: hiddenBrowser,
    owner: null,
    selected: false,
  };
  environment.gBrowser.tabs.push(hiddenUserTab);
  environment.gBrowser.selectedTab = hiddenUserTab;
  environment.tabContainer.dispatch("TabSelect", hiddenUserTab);
  hiddenUserTab.visible = false;

  environment.gBrowser.selectedTab = backingTab;
  environment.tabContainer.dispatch("TabSelect", backingTab);
  environment.flushMicrotasks();

  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
  assert.equal(environment.gBrowser.selectedBrowser, environment.selectedBrowser);
  assert.equal(hiddenUserTab.visible, false);
});

test("external backing-tab closure invalidates the active panel without touching user tabs", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("facebook"));
  const tab = environment.gBrowser.getTabForBrowser(browser);

  environment.gBrowser.removeTab(tab, { animate: false });

  assert.equal(environment.runtime.getBrowser("facebook"), null);
  assert.equal(environment.surfaceEvents.length, 1);
  assert.equal(environment.surfaceEvents[0].type, "sine-web-panel-runtime-invalidated");
  assert.deepEqual(environment.surfaceEvents[0].detail, {
    panelId: "facebook",
    reason: "tab-close",
  });
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
  assert.equal(environment.gBrowser.selectedTab, environment.selectedTab);
});

test("startup removes restored orphan backing tabs before creating new panels", () => {
  const environment = createEnvironment({ startupOrphanCount: 2 });

  assert.equal(environment.startupOrphans.every(tab => !tab.closing), true);
  environment.flushMicrotasks();

  assert.equal(environment.startupOrphans.every(tab => tab.closing), true);
  assert.equal(environment.removedTabs.length, 2);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
});

test("adopted orphan backing tabs are removed when they enter another window", () => {
  const environment = createEnvironment();
  const orphanBrowser = createAttributeTarget("browser");
  const orphan = {
    ...createAttributeTarget("tab"),
    closing: false,
    hidden: true,
    linkedBrowser: orphanBrowser,
    owner: null,
    selected: false,
    sessionValues: new Map([["sineWebPanelBacking", "adopted-orphan"]]),
    undiscardable: true,
  };
  environment.browserToTab.set(orphanBrowser, orphan);
  environment.gBrowser.tabs.push(orphan);

  environment.tabContainer.dispatch("TabOpen", orphan);

  assert.equal(orphan.closing, false);
  environment.flushMicrotasks();

  assert.equal(orphan.closing, true);
  assert.equal(environment.removedTabs.length, 1);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
});

test("detects a crash-restored orphan whose SessionStore marker arrives after TabOpen", () => {
  const environment = createEnvironment();
  const orphanBrowser = createAttributeTarget("browser");
  const orphan = {
    ...createAttributeTarget("tab"),
    closing: false,
    hidden: false,
    linkedBrowser: orphanBrowser,
    owner: null,
    selected: false,
    sessionValues: new Map(),
    undiscardable: true,
  };
  environment.browserToTab.set(orphanBrowser, orphan);
  environment.gBrowser.tabs.push(orphan);

  environment.tabContainer.dispatch("TabOpen", orphan);
  orphan.sessionValues.set("sineWebPanelBacking", "restored-orphan");
  orphan.hidden = true;
  orphan.setAttribute("hidden", "true");

  assert.equal(orphan.closing, false);
  environment.flushMicrotasks();

  assert.equal(orphan.closing, true);
  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
});

test("does not remove the selected restored tab when no visible fallback exists", () => {
  const environment = createEnvironment();
  const reusedTab = environment.selectedTab;
  environment.flushMicrotasks();

  reusedTab.sessionValues = new Map([
    ["sineWebPanelBacking", "reused-restored-orphan"],
  ]);
  environment.windowEvents.dispatch("SSWindowStateReady", environment.windowRef);

  assert.equal(reusedTab.closing, false);
  environment.flushMicrotasks();

  assert.equal(reusedTab.closing, false);
  assert.equal(environment.gBrowser.selectedTab, reusedTab);
  assert.deepEqual(environment.gBrowser.tabs, [reusedTab]);
});

test("selects a visible user fallback before removing a selected restored orphan", () => {
  const environment = createEnvironment();
  const orphan = environment.selectedTab;
  const fallbackBrowser = createAttributeTarget("browser");
  const fallback = {
    ...createAttributeTarget("tab"),
    closing: false,
    hidden: false,
    linkedBrowser: fallbackBrowser,
    owner: null,
    selected: false,
  };
  environment.gBrowser.tabs.push(fallback);
  environment.flushMicrotasks();

  orphan.setAttribute("pending", "true");
  orphan.setAttribute(PANEL_TAB_ATTRIBUTE, "true");
  orphan.setAttribute(PANEL_ID_ATTRIBUTE, "selected-restored-orphan");
  orphan.sessionValues = new Map([
    ["hiddenBy", "sine-web-panels"],
    ["sineWebPanelBacking", "selected-restored-orphan"],
  ]);
  environment.windowEvents.dispatch("SSWindowStateReady", environment.windowRef);
  environment.flushMicrotasks();

  assert.equal(orphan.closing, true);
  assert.equal(fallback.closing, false);
  assert.equal(environment.gBrowser.selectedTab, fallback);
  assert.equal(environment.gBrowser.selectedBrowser, fallbackBrowser);
  assert.deepEqual(environment.gBrowser.tabs, [fallback]);
  assert.deepEqual(environment.removedTabs.map(entry => entry.tab), [orphan]);
  assert.equal(environment.removedTabs[0].selectedBeforeRemoval, fallback);
  assert.deepEqual(environment.removedTabs[0].options, {
    animate: false,
    skipPermitUnload: true,
    skipSessionStore: true,
  });
});

test("unload fully deactivates the Zen browser before removing its tab", () => {
  const environment = createEnvironment();
  const browser = environment.runtime.attach(panel("facebook"));

  environment.runtime.unload("facebook");

  assert.equal(browser.zenModeActive, false);
  assert.equal(browser.docShellIsActive, false);
  assert.equal(browser.renderLayers, false);
});

test("destroy is idempotent and releases every owned tab, observer, and listener", () => {
  const environment = createEnvironment();
  environment.runtime.attach(panel("one"));
  environment.runtime.attach(panel("two"));

  environment.runtime.destroy();
  environment.runtime.destroy();

  assert.deepEqual(environment.gBrowser.tabs, [environment.selectedTab]);
  assert.equal(environment.removedTabs.length, 2);
  assert.equal(environment.tabContainer.listenerCount(), 0);
  assert.equal(environment.windowEvents.listenerCount(), 0);
});
