/**
 * A chrome window small enough to read and complete enough to mount the panel
 * controller against.
 *
 * The point is to test behaviour, not text. Asserting that the source contains
 * `browser.reload();` proves the string is there and nothing else: it passes
 * when the behaviour is broken and fails when the code is merely renamed. So
 * this fakes the parts of the browser the controller actually touches — the
 * DOM, prefs, observers, gBrowser and the clock — and the tests then drive the
 * real class through them.
 *
 * It is deliberately not a DOM implementation. Selector support covers the
 * shapes the controller uses (`#id`, `.class`, `tag`, and combinations),
 * matching the last compound of a descendant selector, which is enough because
 * the controller never relies on ancestry to find anything.
 */

let nextId = 0;

class FakeClassList {
  #classes = new Set();

  add(...names) {
    for (const name of names) this.#classes.add(name);
  }

  remove(...names) {
    for (const name of names) this.#classes.delete(name);
  }

  contains(name) {
    return this.#classes.has(name);
  }

  get value() {
    return [...this.#classes].join(" ");
  }

  set value(text) {
    this.#classes = new Set(String(text ?? "").split(/\s+/).filter(Boolean));
  }
}

class FakeStyle {
  #properties = new Map();

  setProperty(name, value) {
    this.#properties.set(name, String(value));
  }

  removeProperty(name) {
    this.#properties.delete(name);
  }

  getPropertyValue(name) {
    return this.#properties.get(name) ?? "";
  }

  has(name) {
    return this.#properties.has(name);
  }
}

function kebab(name) {
  return String(name).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
}

export class FakeElement {
  constructor(tagName = "div", ownerDocument = null) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.rect = { top: 0, left: 0, width: 0, height: 0 };
    this._key = `el-${nextId++}`;
    // dataset.itemId <-> data-item-id, so attribute selectors see it.
    this.dataset = new Proxy(
      {},
      {
        get: (_, key) => this.attributes.get(`data-${kebab(key)}`),
        set: (_, key, value) => {
          this.attributes.set(`data-${kebab(key)}`, String(value));
          return true;
        },
        deleteProperty: (_, key) => this.attributes.delete(`data-${kebab(key)}`),
      }
    );
  }

  get id() {
    return this.attributes.get("id") ?? "";
  }

  set id(value) {
    this.attributes.set("id", String(value));
  }

  get className() {
    return this.classList.value;
  }

  set className(value) {
    this.classList.value = value;
  }

  setAttribute(name, value) {
    // class= and classList are one thing in a browser; the controller sets
    // the attribute and the selectors read the list.
    if (name === "class") {
      this.classList.value = String(value);
      return;
    }
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    if (name === "class") {
      return this.classList.value || null;
    }
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  toggleAttribute(name, force) {
    const next = force === undefined ? !this.attributes.has(name) : Boolean(force);
    if (next) {
      this.attributes.set(name, "true");
    } else {
      this.attributes.delete(name);
    }
    return next;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (!node) continue;
      node.parentNode?.removeChild?.(node);
      node.parentNode = this;
      this.children.push(node);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  insertBefore(node, reference) {
    const index = reference ? this.children.indexOf(reference) : -1;
    node.parentNode = this;
    if (index === -1) {
      this.children.push(node);
    } else {
      this.children.splice(index, 0, node);
    }
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index !== -1) {
      this.children.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    const index = handlers.indexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
  }

  dispatch(type, event = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
  }

  matches(selector) {
    return matchesCompound(this, lastCompound(selector));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const compound = lastCompound(selector);
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        if (matchesCompound(child, compound)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  focus() {}
  select() {}
  blur() {}

  getBoundingClientRect() {
    return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
  }
}

function lastCompound(selector) {
  const parts = String(selector).trim().split(/\s*[>\s]\s*/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function matchesCompound(element, compound) {
  if (!compound) return false;
  const id = /#([A-Za-z0-9_-]+)/.exec(compound)?.[1];
  if (id && element.id !== id) return false;

  for (const [, cls] of compound.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
    if (!element.classList.contains(cls)) return false;
  }

  const attribute = /\[([A-Za-z0-9_-]+)(?:="([^"]*)")?\]/.exec(compound);
  if (attribute) {
    const [, name, value] = attribute;
    if (!element.hasAttribute(name)) return false;
    if (value !== undefined && element.getAttribute(name) !== value) return false;
  }

  const tag = /^[A-Za-z][A-Za-z0-9-]*/.exec(compound)?.[0];
  if (tag && element.tagName !== tag) return false;

  return true;
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.append(this.body);
    this.listeners = new Map();
    this.fullscreenElement = null;
    this.defaultView = null;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createXULElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.documentElement.querySelector(`#${id}`);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener() {}

  dispatch(type, event = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler({ preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
}

/** A pref branch with observers, since the controller reacts to pref changes. */
export function createPrefs(initial = {}) {
  const values = new Map(Object.entries(initial));
  const observers = new Map();

  const notify = name => {
    for (const observer of [...(observers.get(name) ?? [])]) {
      observer.observe(null, "nsPref:changed", name);
    }
  };

  return {
    values,
    getBoolPref: (name, fallback = false) => values.get(name) ?? fallback,
    setBoolPref: (name, value) => {
      values.set(name, Boolean(value));
      notify(name);
    },
    getStringPref: (name, fallback = "") => values.get(name) ?? fallback,
    setStringPref: (name, value) => {
      values.set(name, String(value));
      notify(name);
    },
    getCharPref: (name, fallback = "") => values.get(name) ?? fallback,
    setCharPref: (name, value) => {
      values.set(name, String(value));
      notify(name);
    },
    getPrefType: name => (values.has(name) ? 32 : 0),
    clearUserPref: name => {
      values.delete(name);
      notify(name);
    },
    addObserver: (name, observer) => {
      if (!observers.has(name)) observers.set(name, []);
      observers.get(name).push(observer);
    },
    removeObserver: (name, observer) => {
      const list = observers.get(name) ?? [];
      const index = list.indexOf(observer);
      if (index !== -1) list.splice(index, 1);
    },
  };
}

/**
 * Builds the window, installs globalThis.Services, and returns handles for
 * driving it: the clock has to be pumped by hand so timed behaviour (the peek
 * timer) is asserted rather than waited on.
 */
export function createChromeWindow({ prefs = {}, viewportWidth = 1600 } = {}) {
  const document = new FakeDocument();
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;

  const browser = new FakeElement("box", document);
  browser.id = "browser";
  document.body.append(browser);

  const appContent = new FakeElement("box", document);
  appContent.id = "zen-appcontent-wrapper";
  appContent.rect = { top: 0, left: 0, width: viewportWidth, height: 900 };
  browser.append(appContent);

  for (const id of ["mainPopupSet", "tabContextMenu", "context_closeTab"]) {
    const element = new FakeElement("box", document);
    element.id = id;
    document.body.append(element);
  }

  const observerTopics = new Map();
  const mutationObservers = [];

  const window = {
    document,
    innerWidth: viewportWidth,
    innerHeight: 900,
    fullScreen: false,
    performance: { now: () => now },
    getComputedStyle: element => ({
      getPropertyValue: name => element.style.getPropertyValue(name),
      color: "rgb(0, 0, 0)",
    }),
    setTimeout: (fn, delay = 0) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => {
      fn();
      return 0;
    },
    addEventListener: (type, handler) => document.addEventListener(type, handler),
    removeEventListener: () => {},
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        mutationObservers.push(this);
      }
      observe(target, options) {
        this.target = target;
        this.options = options;
      }
      disconnect() {
        const index = mutationObservers.indexOf(this);
        if (index !== -1) mutationObservers.splice(index, 1);
      }
    },
    SessionStore: {
      values: new Map(),
      setCustomTabValue(tab, key, value) {
        this.values.set(tab, { ...(this.values.get(tab) ?? {}), [key]: value });
      },
      getCustomTabValue(tab, key) {
        return this.values.get(tab)?.[key] ?? "";
      },
    },
    gBrowser: {
      tabs: [],
      // A getter, like the browser's: a hidden tab must drop out of it, or the
      // controller's "find me an ordinary tab" never sees the truth.
      get visibleTabs() {
        return this.tabs.filter(tab => !tab.hidden);
      },
      _selectedTab: null,
      get selectedTab() {
        return this._selectedTab;
      },
      // Assigning fires TabSelect synchronously, as the browser does. A plain
      // property here swallowed the event, and that hid a guard which undid
      // every panel the moment it opened.
      set selectedTab(tab) {
        if (tab === this._selectedTab) return;
        this._selectedTab = tab;
        this.tabContainer.dispatch("TabSelect", { target: tab });
      },
      tabContainer: new FakeElement("tabs", document),
      tabpanels: null,
      addTrustedTab(url) {
        return this._addTab(url);
      },
      // Builds the slice of Zen's tab deck that #openSurface anchors to:
      // .browserSidebarContainer > .browserContainer > browser.
      _addTab(url = "about:blank") {
        const tab = new FakeElement("tab", document);
        const container = new FakeElement("vbox", document);
        container.classList.add("browserSidebarContainer");
        const frame = new FakeElement("vbox", document);
        frame.classList.add("browserContainer");
        const linkedBrowser = new FakeElement("browser", document);
        linkedBrowser.currentURI = { spec: url };
        frame.append(linkedBrowser);
        container.append(frame);
        this.tabpanels.append(container);
        tab.linkedBrowser = linkedBrowser;
        tab.linkedPanel = container;
        this.tabs.push(tab);
        return tab;
      },
      hideTab() {},
      removeTab(tab) {
        tab.closing = true;
        const index = this.tabs.indexOf(tab);
        if (index !== -1) this.tabs.splice(index, 1);
      },
      addTabsProgressListener() {},
      removeTabsProgressListener() {},
      getTabForBrowser: () => null,
    },
  };

  document.defaultView = window;

  const tabpanels = new FakeElement("tabpanels", document);
  tabpanels.id = "tabbrowser-tabpanels";
  appContent.append(tabpanels);
  window.gBrowser.tabpanels = tabpanels;

  // CSS.escape is a browser global the controller uses to build selectors.
  globalThis.CSS = { escape: value => String(value).replace(/([^\w-])/g, "\\$1") };

  globalThis.Services = {
    appinfo: { OS: "Linux" },
    prefs: createPrefs(prefs),
    obs: {
      addObserver: (observer, topic) => {
        if (!observerTopics.has(topic)) observerTopics.set(topic, []);
        observerTopics.get(topic).push(observer);
      },
      removeObserver: (observer, topic) => {
        const list = observerTopics.get(topic) ?? [];
        const index = list.indexOf(observer);
        if (index !== -1) list.splice(index, 1);
      },
    },
    scriptSecurityManager: { getSystemPrincipal: () => "system-principal" },
    io: { newURI: spec => ({ spec }) },
  };

  return {
    window,
    document,
    browser,
    appContent,
    prefs: globalThis.Services.prefs,

    /** A tab in the strip, with the deck DOM the controller anchors panels to. */
    addTab({ url = "about:blank", panelId = null, hidden = false, select = false } = {}) {
      const tab = window.gBrowser._addTab(url);
      tab.hidden = hidden;
      if (panelId) {
        tab.setAttribute("sine-web-panel-tab", "true");
        tab.setAttribute("sine-web-panel-id", panelId);
      }
      if (select) {
        window.gBrowser.selectedTab = tab;
      }
      return tab;
    },

    /** Runs every timer due within `ms`, so peek timing is asserted not waited on. */
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },

    /** Flips an attribute on the chrome root and runs the observers watching it. */
    setRootAttribute(name, value) {
      if (value === null) {
        document.documentElement.removeAttribute(name);
      } else {
        document.documentElement.setAttribute(name, value);
      }
      for (const observer of mutationObservers) {
        if (observer.options?.attributeFilter?.includes(name)) {
          observer.callback([{ attributeName: name }]);
        }
      }
    },

    notify(topic) {
      for (const observer of [...(observerTopics.get(topic) ?? [])]) {
        observer.observe(null, topic, null);
      }
    },
  };
}
