const MODULE_VERSION = new URL(import.meta.url).search;

const {
  WEB_PANEL_RUNTIME_INVALIDATED_EVENT,
  WebPanelsRuntime,
} = await import(`./web-panels-runtime.uc.mjs${MODULE_VERSION}`);
const { WebPanelPermissionRouter } = await import(
  `./web-panels-permissions.uc.mjs${MODULE_VERSION}`
);
const {
  MIN_PANEL_WIDTH,
  PANEL_TYPE,
  SEPARATOR_TYPE,
  WebPanelsStore,
  normalizeWebPanelUrl,
  parseWebPanelUnreadCount,
} = await import(`./web-panels-store.uc.mjs${MODULE_VERSION}`);

const ROOT_ID = "sine-web-panels-root";
const RAIL_ID = "sine-web-panels-rail";
const LIST_ID = "sine-web-panels-list";
const ADD_BUTTON_ID = "sine-web-panels-add-button";
const SURFACE_ID = "sine-web-panels-surface";
const BACKDROP_ID = "sine-web-panels-backdrop";
const MENU_ID = "sine-web-panels-menu";
const EDITOR_ID = "sine-web-panels-editor";
const TAB_MENU_ITEM_ID = "sine-web-panels-tab-context-add";
const CONTENT_CONTEXT_MENU_ID = "contentAreaContextMenu";
const CONTENT_RESET_MENU_ITEM_ID = "sine-web-panels-context-reset";
const WEB_PANEL_CONTEXT_NAVIGATION_IDS = Object.freeze([
  "context-back",
  "context-forward",
  "context-reload",
  "context-stop",
]);
const INSTANCE_KEY = "__sineWebPanelsInstance";
export const PANEL_VIEWPORT_INSET = 8;
export const PANEL_VIEWPORT_MAX_WIDTH_RATIO = 0.95;

function snapshotAttribute(element, name) {
  return {
    element,
    name,
    present: element.hasAttribute(name),
    value: element.getAttribute(name),
  };
}

function restoreAttribute(snapshot) {
  if (snapshot.present) {
    snapshot.element.setAttribute(snapshot.name, snapshot.value);
  } else {
    snapshot.element.removeAttribute(snapshot.name);
  }
}

export function configureWebPanelContextNavigation(documentRef, browser, tab) {
  const snapshots = [];
  const remember = (element, name) => {
    snapshots.push(snapshotAttribute(element, name));
  };
  const items = new Map(
    WEB_PANEL_CONTEXT_NAVIGATION_IDS.map(id => [id, documentRef.getElementById(id)])
  );

  for (const item of items.values()) {
    if (!item) {
      continue;
    }
    remember(item, "command");
    item.removeAttribute("command");
  }

  const back = items.get("context-back");
  if (back) {
    remember(back, "disabled");
    back.toggleAttribute("disabled", !browser?.canGoBack);
  }

  const forward = items.get("context-forward");
  if (forward) {
    remember(forward, "disabled");
    forward.toggleAttribute("disabled", !browser?.canGoForward);
  }

  const isLoading = Boolean(
    browser?.webProgress?.isLoadingDocument || tab?.hasAttribute?.("busy")
  );
  const reload = items.get("context-reload");
  if (reload) {
    remember(reload, "hidden");
    remember(reload, "disabled");
    reload.toggleAttribute("hidden", isLoading);
    reload.removeAttribute("disabled");
  }

  const stop = items.get("context-stop");
  if (stop) {
    remember(stop, "hidden");
    remember(stop, "disabled");
    stop.toggleAttribute("hidden", !isLoading);
    stop.removeAttribute("disabled");
  }

  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    for (const snapshot of snapshots.reverse()) {
      restoreAttribute(snapshot);
    }
  };
}

export function routeWebPanelNavigationCommand(commandId, options = {}) {
  if (!WEB_PANEL_CONTEXT_NAVIGATION_IDS.includes(commandId)) {
    return false;
  }

  const {
    browser,
    tab,
    event = {},
    navigationFlags = {},
  } = options;
  if (!browser || !tab) {
    return true;
  }

  switch (commandId) {
    case "context-back":
      if (browser.canGoBack) {
        browser.goBack(false);
      }
      break;
    case "context-forward":
      if (browser.canGoForward) {
        browser.goForward(false);
      }
      break;
    case "context-reload": {
      const flags = event.shiftKey || browser.currentURI?.schemeIs?.("view-source")
        ? (navigationFlags.bypassProxy ?? 0) | (navigationFlags.bypassCache ?? 0)
        : navigationFlags.none ?? 0;
      browser.reloadWithFlags(flags);
      break;
    }
    case "context-stop":
      browser.stop();
      break;
  }
  return true;
}

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function calculateWebPanelViewportGeometry(rect, fallbackViewport = {}) {
  const top = typeof rect?.top === "number" && Number.isFinite(rect.top)
    ? rect.top
    : 0;
  const left = typeof rect?.left === "number" && Number.isFinite(rect.left)
    ? rect.left
    : 0;
  const width = positiveNumber(rect?.width, positiveNumber(fallbackViewport.width, 1));
  const height = positiveNumber(
    rect?.height,
    positiveNumber(fallbackViewport.height, PANEL_VIEWPORT_INSET * 2)
  );
  const fallbackTop = typeof fallbackViewport.top === "number" && Number.isFinite(fallbackViewport.top)
    ? fallbackViewport.top
    : top;
  const fallbackLeft = typeof fallbackViewport.left === "number" && Number.isFinite(fallbackViewport.left)
    ? fallbackViewport.left
    : left;
  const fallbackWidth = positiveNumber(fallbackViewport.width, width);
  const fallbackHeight = positiveNumber(fallbackViewport.height, height);
  const visibleTop = Math.max(top, fallbackTop);
  const visibleBottom = Math.min(top + height, fallbackTop + fallbackHeight);
  const visibleLeft = Math.max(left, fallbackLeft);
  const visibleRight = Math.min(left + width, fallbackLeft + fallbackWidth);
  const visibleHeight = Math.max(0, visibleBottom - visibleTop);
  const visibleWidth = Math.max(0, visibleRight - visibleLeft);

  return {
    top: visibleTop + PANEL_VIEWPORT_INSET,
    height: Math.max(0, visibleHeight - PANEL_VIEWPORT_INSET * 2),
    maxWidth: Math.max(1, Math.floor(visibleWidth * PANEL_VIEWPORT_MAX_WIDTH_RATIO)),
  };
}

export function clampWebPanelWidth(width, maxWidth, minWidth = MIN_PANEL_WIDTH) {
  const safeMax = Math.max(1, Math.floor(Number(maxWidth) || 1));
  const safeMin = Math.min(
    safeMax,
    Math.max(1, Math.round(Number(minWidth) || MIN_PANEL_WIDTH))
  );
  const requestedWidth = Number.isFinite(Number(width))
    ? Math.round(Number(width))
    : safeMin;
  return Math.min(safeMax, Math.max(safeMin, requestedWidth));
}

function isPanel(item) {
  return item?.type === PANEL_TYPE;
}

function isSeparator(item) {
  return item?.type === SEPARATOR_TYPE;
}

function displayCount(count) {
  return Number.isInteger(count) && count > 0 ? (count > 99 ? "99+" : String(count)) : "";
}

class SineWebPanels {
  #store = new WebPanelsStore();
  #root;
  #rail;
  #list;
  #surface;
  #surfaceShell;
  #backdrop;
  #editor;
  #menu;
  #browserChrome;
  #contentContainer;
  #pageViewportElement;
  #pageViewportResizeObserver;
  #tabContextMenuItem;
  #contentContextMenu;
  #contentResetMenuItem;
  #panelContextState = null;
  #runtime;
  #permissions;
  #items = [];
  #activeId = null;
  #editorState = null;
  #railInsertIndex = null;
  #unreadCounts = new Map();
  #menuOpenedAt = 0;
  #abortController = new AbortController();
  #prefObserver;
  #resizeState = null;
  #dragState = null;
  #openTransitionTimer = null;
  #closeTransitionTimer = null;
  #destroyed = false;

  constructor(windowRef) {
    this.window = windowRef;
    this.document = windowRef.document;
  }

  init() {
    this.destroyExistingRoot();
    this.#items = this.#store.loadItems({ persistNormalized: true });
    this.#mount();
    this.#runtime = new WebPanelsRuntime(this.window, this.#surface);
    this.#permissions = new WebPanelPermissionRouter(this.window);
    this.#applyEnabledState();
    this.#observePrefs();
  }

  destroyExistingRoot() {
    this.document.getElementById(ROOT_ID)?.remove();
    this.document.getElementById(EDITOR_ID)?.remove();
    this.document.getElementById(TAB_MENU_ITEM_ID)?.remove();
    this.document.getElementById(CONTENT_RESET_MENU_ITEM_ID)?.remove();
  }

  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#hideContentContextMenu();
    this.#resetContentContextState();
    this.#abortController.abort();
    this.#clearOpenTransitionTimer();
    this.#clearCloseTransitionTimer();
    if (this.#prefObserver) {
      Services.prefs.removeObserver(WebPanelsStore.prefs.enabled, this.#prefObserver);
      this.#prefObserver = null;
    }
    this.#permissions?.destroy();
    this.#permissions = null;
    this.#runtime?.destroy();
    this.#runtime = null;
    this.#pageViewportResizeObserver?.disconnect();
    this.#pageViewportResizeObserver = null;
    this.#pageViewportElement = null;
    this.#resetChromeLayout();
    this.#editor?.remove();
    this.#tabContextMenuItem?.remove();
    this.#contentResetMenuItem?.remove();
    this.#root?.remove();
    this.#activeId = null;
    this.#editor = null;
    this.#tabContextMenuItem = null;
    this.#contentContextMenu = null;
    this.#contentResetMenuItem = null;
    this.#root = null;
  }

  #mount() {
    this.#browserChrome = this.document.getElementById("browser");
    if (!this.#browserChrome) {
      console.warn("[Web Panels] Browser chrome root was not found.");
      return;
    }

    this.#root = this.#el("div", {
      id: ROOT_ID,
      side: this.#placementSide(),
    });
    this.#root.style.setProperty("--sine-web-panels-width", `${this.#store.width}px`);

    this.#backdrop = this.#el("div", { id: BACKDROP_ID, hidden: "true" });
    this.#surfaceShell = this.#el("div", { id: "sine-web-panels-shell", hidden: "true" });
    const resizer = this.#el("div", {
      id: "sine-web-panels-resizer",
      role: "separator",
      "aria-orientation": "vertical",
      title: "Resize Web Panel",
    });
    this.#surface = this.#el("div", { id: SURFACE_ID });
    this.#surfaceShell.append(resizer, this.#surface);

    this.#rail = this.#el("div", {
      id: RAIL_ID,
      role: "toolbar",
      "aria-label": "Web Panels",
    });
    this.#list = this.#el("div", { id: LIST_ID });
    const addButton = this.#button({
      id: ADD_BUTTON_ID,
      label: "",
      title: "New Web Panel",
      className: "sine-web-panels-add-button",
    });
    addButton.setAttribute("aria-label", "New Web Panel");
    this.#rail.append(this.#list, addButton);

    this.#editor = this.#buildEditor();
    this.#menu = this.#el("div", { id: MENU_ID, hidden: "true", role: "menu" });

    this.#root.append(this.#backdrop, this.#surfaceShell, this.#rail, this.#menu);
    this.#browserChrome.append(this.#root);
    (this.document.getElementById("mainPopupSet") ?? this.#browserChrome).append(this.#editor);
    this.#mountTabContextMenuItem();
    this.#mountContentContextMenu();
    if (typeof this.window.ResizeObserver === "function") {
      this.#pageViewportResizeObserver = new this.window.ResizeObserver(
        this.#onPageViewportResize
      );
    }
    this.#syncChromeLayout();

    const signal = this.#abortController.signal;
    addButton.addEventListener("click", event => {
      event.stopPropagation();
      this.#openEditor({ mode: "add", anchor: addButton, insertIndex: this.#items.length });
    }, { signal });
    this.#backdrop.addEventListener("click", () => this.#closePanel(), { signal });
    this.#surfaceShell.addEventListener("click", event => event.stopPropagation(), { signal });
    this.#surface.addEventListener(WEB_PANEL_RUNTIME_INVALIDATED_EVENT, event => {
      if (event.detail?.panelId === this.#activeId) {
        this.#closePanel({ animate: false });
      }
    }, { signal });
    this.#rail.addEventListener("contextmenu", this.#onRailContextMenu, { signal });
    resizer.addEventListener("pointerdown", this.#onResizeStart, { signal });
    this.window.addEventListener("pointermove", this.#onPointerMove, { signal });
    this.window.addEventListener("pointerup", this.#onPointerUp, { signal });
    this.window.addEventListener("pointercancel", this.#onPointerUp, { signal });
    this.window.addEventListener("resize", this.#onWindowResize, { signal });
    this.window.gBrowser?.tabContainer?.addEventListener(
      "TabSelect",
      this.#onPageViewportChange,
      { signal }
    );
    this.document.addEventListener("click", this.#onDocumentClick, { signal });
    this.document.addEventListener("keydown", this.#onKeyDown, { signal });
    this.#render();
  }

  #mountTabContextMenuItem() {
    const tabContextMenu = this.document.getElementById("tabContextMenu");
    if (!tabContextMenu) {
      console.warn("[Web Panels] Tab context menu was not found.");
      return;
    }

    const menuItem = this.#xul("menuitem", {
      id: TAB_MENU_ITEM_ID,
      label: "Add to Web Panels",
      accesskey: "W",
    });
    const insertBefore =
      this.document.getElementById("context_bookmarkTab") ??
      this.document.getElementById("context_closeTab") ??
      null;
    tabContextMenu.insertBefore(menuItem, insertBefore);
    menuItem.addEventListener("command", this.#onAddTabToWebPanels, {
      signal: this.#abortController.signal,
    });
    tabContextMenu.addEventListener("popupshowing", this.#onTabContextMenuShowing, {
      signal: this.#abortController.signal,
    });
    this.#tabContextMenuItem = menuItem;
  }

  #mountContentContextMenu() {
    this.#contentContextMenu = this.document.getElementById(CONTENT_CONTEXT_MENU_ID);
    if (!this.#contentContextMenu) {
      console.warn("[Web Panels] Content context menu was not found.");
      return;
    }

    const signal = this.#abortController.signal;
    const resetItem = this.#xul("menuitem", {
      id: CONTENT_RESET_MENU_ITEM_ID,
      label: "Reset Web Panel",
      hidden: "true",
    });
    const navigationSeparator = this.document.getElementById(
      "context-sep-navigation"
    );
    this.#contentContextMenu.insertBefore(resetItem, navigationSeparator ?? null);
    resetItem.addEventListener("command", this.#onResetPanelFromContentMenu, {
      signal,
    });
    this.#contentResetMenuItem = resetItem;
    this.#contentContextMenu.addEventListener(
      "popupshowing",
      this.#onContentContextMenuShowing,
      { signal }
    );
    this.#contentContextMenu.addEventListener(
      "popuphiding",
      this.#onContentContextMenuHiding,
      { signal }
    );
    this.#contentContextMenu.addEventListener(
      "command",
      this.#onContentContextMenuCommand,
      { capture: true, signal }
    );
  }

  #activeContentContextTarget(contextMenu = this.window.gContextMenu) {
    if (!this.#activeId || !this.#runtime) {
      return null;
    }
    const panelId = this.#activeId;
    const browser = this.#runtime.getBrowser(panelId);
    if (!browser || contextMenu?.browser !== browser) {
      return null;
    }
    const tab = this.window.gBrowser?.getTabForBrowser?.(browser);
    if (!tab || tab.linkedBrowser !== browser) {
      return null;
    }
    return { panelId, browser, tab, contextMenu };
  }

  #isContentContextStateValid(state) {
    if (!state || this.#panelContextState !== state || state.panelId !== this.#activeId) {
      return false;
    }
    const { browser, contextMenu, tab } = state;
    return (
      contextMenu?.browser === browser &&
      this.#runtime?.getBrowser(state.panelId) === browser &&
      this.window.gBrowser?.getTabForBrowser?.(browser) === tab &&
      tab.linkedBrowser === browser
    );
  }

  #patchPanelContextMethod(state, name, replacement) {
    const { contextMenu } = state;
    const originalDescriptor = Object.getOwnPropertyDescriptor(contextMenu, name);
    const originalMethod = contextMenu[name];
    if (typeof originalMethod !== "function") {
      return false;
    }
    state.methodDescriptors.push({ name, originalDescriptor });
    Object.defineProperty(contextMenu, name, {
      configurable: true,
      writable: true,
      value: (...args) => {
        if (!this.#isContentContextStateValid(state)) {
          console.warn("[Web Panels] Ignored a stale panel context action.", {
            action: name,
            panelId: state.panelId,
          });
          return undefined;
        }
        try {
          return replacement(originalMethod.bind(contextMenu), ...args);
        } catch (error) {
          console.error("[Web Panels] Panel context action failed.", {
            action: name,
            error,
            panelId: state.panelId,
          });
          return undefined;
        }
      },
    });
    return true;
  }

  #installPanelContextOverrides(state) {
    const { browser, contextMenu, tab } = state;
    this.#patchPanelContextMethod(state, "openLinkInCurrent", () => {
      this.window.openLinkIn(
        contextMenu.linkURL,
        "current",
        contextMenu._openLinkInParameters({ targetBrowser: browser })
      );
    });
    this.#patchPanelContextMethod(state, "showOnlyThisFrame", () => {
      this.window.urlSecurityCheck(
        contextMenu.contentData.docLocation,
        browser.contentPrincipal,
        Ci.nsIScriptSecurityManager.DISALLOW_SCRIPT
      );
      this.window.openWebLinkIn(contextMenu.contentData.docLocation, "current", {
        referrerInfo: contextMenu.contentData.frameReferrerInfo,
        triggeringPrincipal: browser.contentPrincipal,
        targetBrowser: browser,
      });
    });
    this.#patchPanelContextMethod(state, "bookmarkThisPage", () => {
      const url = browser.currentURI?.spec;
      if (!url) {
        throw new Error("The panel page URL is unavailable for bookmarking.");
      }
      const result = this.window.top.PlacesCommandHook.bookmarkLink(
        url,
        browser.contentTitle || url
      );
      result?.catch?.(error => {
        console.error("[Web Panels] Could not bookmark the panel page.", error);
      });
      return result;
    });
    this.#patchPanelContextMethod(state, "inspectNode", () => {
      const { DevToolsShim } = ChromeUtils.importESModule(
        "chrome://devtools-startup/content/DevToolsShim.sys.mjs"
      );
      return DevToolsShim.inspectNode(tab, contextMenu.targetIdentifier);
    });
    this.#patchPanelContextMethod(state, "inspectA11Y", () => {
      const { DevToolsShim } = ChromeUtils.importESModule(
        "chrome://devtools-startup/content/DevToolsShim.sys.mjs"
      );
      return DevToolsShim.inspectA11Y(tab, contextMenu.targetIdentifier);
    });
    this.#patchPanelContextMethod(state, "switchPageDirection", () => {
      browser.sendMessageToActor(
        "SwitchDocumentDirection",
        {},
        "SwitchDocumentDirection",
        "roots"
      );
    });
    this.#hideSelectedTabOnlyContextItems(state);
    this.#patchSendPageToDevice(state);
  }

  #hideSelectedTabOnlyContextItems(state) {
    const screenshot = this.document.getElementById("context-take-screenshot");
    if (!screenshot) {
      return;
    }
    state.itemAttributeSnapshots.push(snapshotAttribute(screenshot, "hidden"));
    screenshot.setAttribute("hidden", "true");
  }

  #patchSendPageToDevice(state) {
    const sync = this.window.gSync;
    const name = "populateSendTabToDevicesMenu";
    const originalMethod = sync?.[name];
    if (typeof originalMethod !== "function") {
      return;
    }
    const originalDescriptor = Object.getOwnPropertyDescriptor(sync, name);
    state.externalMethodDescriptors.push({
      name,
      originalDescriptor,
      target: sync,
    });
    Object.defineProperty(sync, name, {
      configurable: true,
      writable: true,
      value: (popup, uri, title, options) => {
        const isPanelPageMenu =
          popup?.id === "context-sendpagetodevice-popup" &&
          options?.contextMenuType === "page";
        if (!isPanelPageMenu) {
          return originalMethod.call(sync, popup, uri, title, options);
        }
        if (!this.#isContentContextStateValid(state)) {
          console.warn("[Web Panels] Ignored a stale Send Page context menu.", {
            panelId: state.panelId,
          });
          return undefined;
        }
        return originalMethod.call(
          sync,
          popup,
          state.browser.currentURI,
          state.browser.contentTitle,
          options
        );
      },
    });
  }

  #resetContentContextState() {
    this.#contentResetMenuItem?.setAttribute("hidden", "true");
    const state = this.#panelContextState;
    if (!state) {
      return;
    }
    this.#panelContextState = null;

    try {
      state.restoreNavigation?.();
    } catch (error) {
      console.error("[Web Panels] Could not restore native context navigation.", error);
    }
    for (const { name, originalDescriptor } of state.methodDescriptors.reverse()) {
      try {
        if (originalDescriptor) {
          Object.defineProperty(state.contextMenu, name, originalDescriptor);
        } else {
          delete state.contextMenu[name];
        }
      } catch (error) {
        console.error("[Web Panels] Could not restore a native context action.", {
          action: name,
          error,
        });
      }
    }
    for (const snapshot of state.itemAttributeSnapshots.reverse()) {
      try {
        restoreAttribute(snapshot);
      } catch (error) {
        console.error("[Web Panels] Could not restore a native context item.", {
          error,
          itemId: snapshot.element.id,
        });
      }
    }
    for (const { name, originalDescriptor, target } of state.externalMethodDescriptors.reverse()) {
      try {
        if (originalDescriptor) {
          Object.defineProperty(target, name, originalDescriptor);
        } else {
          delete target[name];
        }
      } catch (error) {
        console.error("[Web Panels] Could not restore a native context service.", {
          action: name,
          error,
        });
      }
    }
  }

  #hideContentContextMenu() {
    if (!this.#panelContextState) {
      return;
    }
    try {
      if (
        typeof this.#contentContextMenu?.hidePopup === "function" &&
        this.#contentContextMenu.state !== "closed"
      ) {
        this.#contentContextMenu.hidePopup();
      }
    } catch (error) {
      console.error("[Web Panels] Could not close the native content context menu.", error);
    } finally {
      this.#resetContentContextState();
    }
  }

  #deferContentContextMenuHide() {
    const queueMicrotaskRef = this.window.queueMicrotask ?? globalThis.queueMicrotask;
    if (typeof queueMicrotaskRef !== "function") {
      this.#hideContentContextMenu();
      return;
    }
    queueMicrotaskRef(() => this.#hideContentContextMenu());
  }

  #observePrefs() {
    this.#prefObserver = {
      observe: (_subject, topic, prefName) => {
        if (topic === "nsPref:changed" && prefName === WebPanelsStore.prefs.enabled) {
          this.#applyEnabledState();
        }
      },
    };
    Services.prefs.addObserver(WebPanelsStore.prefs.enabled, this.#prefObserver);
  }

  #applyEnabledState() {
    if (!this.#root) {
      return;
    }

    if (this.#store.enabled) {
      this.#root.removeAttribute("disabled");
      this.#syncChromeLayout();
      this.#render();
      return;
    }

    this.#closePanel();
    this.#runtime?.destroy();
    this.#runtime = new WebPanelsRuntime(this.window, this.#surface);
    this.#root.setAttribute("disabled", "true");
    this.#resetChromeLayout();
  }

  #syncChromeLayout() {
    if (!this.#browserChrome || !this.#root || !this.#store.enabled) {
      return;
    }

    const side = this.#placementSide();
    const styles = this.window.getComputedStyle(this.#root);
    const railSize = Number.parseFloat(styles.getPropertyValue("--sine-web-panels-rail-size")) || 36;
    const gap = Number.parseFloat(styles.getPropertyValue("--sine-web-panels-gap")) || 8;
    const reservedSize = `${railSize + gap}px`;
    this.#browserChrome.setAttribute("sine-web-panels-side", side);
    this.#browserChrome.style.setProperty(
      "--sine-web-panels-reserved-inline-size",
      reservedSize
    );
    this.#contentContainer = this.#findContentContainer();
    this.#contentContainer?.style.removeProperty("margin-inline-start");
    this.#contentContainer?.style.removeProperty("margin-inline-end");
    this.#contentContainer?.style.setProperty(
      side === "right" ? "margin-inline-end" : "margin-inline-start",
      reservedSize,
      "important"
    );
    this.#observePageViewport();
    this.#syncPageViewportGeometry();
  }

  #resetChromeLayout() {
    this.#browserChrome?.removeAttribute("sine-web-panels-side");
    this.#browserChrome?.style.removeProperty("--sine-web-panels-reserved-inline-size");
    this.#contentContainer?.style.removeProperty("margin-inline-start");
    this.#contentContainer?.style.removeProperty("margin-inline-end");
    this.#contentContainer = null;
    this.#pageViewportResizeObserver?.disconnect();
    this.#pageViewportElement = null;
  }

  #findContentContainer() {
    return (
      this.document.getElementById("zen-appcontent-wrapper") ??
      this.document.getElementById("zen-tabbox-wrapper") ??
      this.document.getElementById("tabbrowser-tabbox") ??
      this.document.getElementById("appcontent")
    );
  }

  #findPageViewportElement() {
    const runtimeUserBrowser = this.#runtime?.getUserBrowser?.();
    if (typeof runtimeUserBrowser?.getBoundingClientRect === "function") {
      return runtimeUserBrowser;
    }
    const gBrowser = this.window.gBrowser;
    const selectedTab = gBrowser?.selectedTab ?? null;
    const visibleUserTab = gBrowser?.visibleTabs?.includes(selectedTab)
      ? selectedTab
      : gBrowser?.visibleTabs?.find(tab => !tab?.closing) ?? null;
    if (typeof visibleUserTab?.linkedBrowser?.getBoundingClientRect === "function") {
      return visibleUserTab.linkedBrowser;
    }
    return (
      this.document.getElementById("zen-tabbox-wrapper") ??
      this.document.getElementById("tabbrowser-tabbox") ??
      this.document.getElementById("appcontent") ??
      this.#contentContainer
    );
  }

  #observePageViewport() {
    const viewportElement = this.#findPageViewportElement();
    if (viewportElement === this.#pageViewportElement) {
      return;
    }
    this.#pageViewportResizeObserver?.disconnect();
    this.#pageViewportElement = viewportElement;
    if (viewportElement) {
      this.#pageViewportResizeObserver?.observe(viewportElement);
    }
    const layoutAnchor = this.document.getElementById("zen-tabbox-wrapper");
    if (layoutAnchor && layoutAnchor !== viewportElement) {
      this.#pageViewportResizeObserver?.observe(layoutAnchor);
    }
  }

  #pageViewportGeometry() {
    const fallbackViewport = {
      top: 0,
      left: 0,
      width: this.document.documentElement.clientWidth || this.window.innerWidth,
      height: this.document.documentElement.clientHeight || this.window.innerHeight,
    };
    let rect = null;
    try {
      rect = this.#findPageViewportElement()?.getBoundingClientRect?.() ?? null;
    } catch (error) {
      console.error("[Web Panels] Could not measure the page viewport.", error);
    }
    return calculateWebPanelViewportGeometry(rect, fallbackViewport);
  }

  #syncPageViewportGeometry() {
    if (!this.#root || !this.#store.enabled) {
      return;
    }
    const geometry = this.#pageViewportGeometry();
    this.#root.style.setProperty("--sine-web-panels-viewport-top", `${geometry.top}px`);
    this.#root.style.setProperty("--sine-web-panels-viewport-height", `${geometry.height}px`);
    this.#root.style.setProperty("--sine-web-panels-max-width", `${geometry.maxWidth}px`);
    this.#root.style.setProperty(
      "--sine-web-panels-width",
      `${clampWebPanelWidth(this.#store.width, geometry.maxWidth)}px`
    );
    this.#runtime?.syncGeometry();
  }

  #onPageViewportResize = () => {
    this.#syncPageViewportGeometry();
  };

  #onPageViewportChange = () => {
    this.#observePageViewport();
    this.window.requestAnimationFrame(() => {
      if (!this.#destroyed) {
        this.#syncPageViewportGeometry();
      }
    });
  };

  #render() {
    if (!this.#list || !this.#store.enabled) {
      return;
    }

    this.#items = this.#store.items;
    this.#runtime?.unloadMissing(this.#items.filter(isPanel).map(item => item.id));
    this.#list.replaceChildren();

    for (const [index, item] of this.#items.entries()) {
      const node = isSeparator(item)
        ? this.#renderSeparator(item, index)
        : this.#renderPanelButton(item, index);
      this.#list.append(node);
    }

    this.#root.toggleAttribute("has-items", this.#items.length > 0);
    this.#root.setAttribute("side", this.#placementSide());
    this.#syncChromeLayout();
    this.#runtime?.syncGeometry();
  }

  #renderPanelButton(item, index) {
    const button = this.#button({
      className: "sine-web-panels-item sine-web-panels-panel-button",
      title: item.title || item.url,
    });
    button.dataset.itemId = item.id;
    button.dataset.index = String(index);
    button.setAttribute("aria-label", item.title || item.url);
    if (item.id === this.#activeId) {
      button.setAttribute("active", "true");
    }

    const icon = this.#el("img", {
      class: "sine-web-panels-favicon",
      alt: "",
      draggable: "false",
    });
    icon.src = `page-icon:${item.url}`;
    icon.addEventListener("error", () => {
      icon.removeAttribute("src");
      icon.setAttribute("fallback", "true");
    }, { once: true });
    button.append(icon);
    this.#applyUnreadBadge(button, item.id);

    button.addEventListener("click", event => {
      event.stopPropagation();
      this.#togglePanel(item);
    }, { signal: this.#abortController.signal });
    button.addEventListener("contextmenu", event => this.#openItemMenu(event, item), {
      signal: this.#abortController.signal,
    });
    button.addEventListener("pointerdown", event => this.#onItemPointerDown(event, item), {
      signal: this.#abortController.signal,
    });
    return button;
  }

  #renderSeparator(item, index) {
    const separator = this.#el("div", {
      class: "sine-web-panels-item sine-web-panels-separator",
      role: "separator",
      "aria-label": "Web Panels separator",
    });
    separator.dataset.itemId = item.id;
    separator.dataset.index = String(index);
    separator.append(this.#el("span"));
    separator.addEventListener("contextmenu", event => this.#openItemMenu(event, item), {
      signal: this.#abortController.signal,
    });
    separator.addEventListener("pointerdown", event => this.#onItemPointerDown(event, item), {
      signal: this.#abortController.signal,
    });
    return separator;
  }

  #togglePanel(item) {
    if (this.#activeId === item.id) {
      this.#closePanel();
      return;
    }
    this.#openPanel(item);
  }

  #openPanel(item) {
    this.#closeEditor();
    this.#hideContentContextMenu();
    const switching = Boolean(this.#activeId);
    const wasClosing = this.#root.hasAttribute("closing");
    this.#clearOpenTransitionTimer();
    if (wasClosing) {
      this.#root.removeAttribute("closing");
    }
    this.#root.toggleAttribute("switching", switching);
    this.#root.toggleAttribute("opening", !switching);
    const browser = this.#runtime.attach(item);
    if (!browser) {
      this.#root.removeAttribute("switching");
      this.#root.removeAttribute("opening");
      if (wasClosing) {
        this.#root.setAttribute("closing", "true");
      }
      console.error("[Web Panels] Could not create the panel browser.", { panelId: item?.id });
      return;
    }

    this.#clearCloseTransitionTimer();
    this.#activeId = item.id;
    this.#surfaceShell.hidden = false;
    this.#backdrop.hidden = false;
    this.#root.setAttribute("open", "true");
    this.#root.setAttribute("active", item.id);
    this.#bindBrowserTitle(item, browser);
    this.#render();
    this.#permissions?.activate({
      browser,
      getAnchor: () => this.#findItemElement(item.id),
    });
    this.#openTransitionTimer = this.window.setTimeout(() => {
      this.#openTransitionTimer = null;
      this.#root?.removeAttribute("switching");
      this.#root?.removeAttribute("opening");
      this.#runtime?.syncGeometry();
    }, 90);
  }

  #closePanel({ animate = true } = {}) {
    if (!this.#activeId) {
      return;
    }

    this.#hideContentContextMenu();
    this.#clearOpenTransitionTimer();
    this.#clearCloseTransitionTimer();
    this.#permissions?.deactivate();
    this.#activeId = null;
    this.#root.removeAttribute("active");
    this.#root.removeAttribute("open");
    this.#root.removeAttribute("opening");
    this.#root.removeAttribute("switching");
    if (animate) {
      this.#root.setAttribute("closing", "true");
      this.#closeTransitionTimer = this.window.setTimeout(() => {
        this.#closeTransitionTimer = null;
        if (!this.#activeId) {
          this.#runtime?.detach();
          this.#surfaceShell.hidden = true;
          this.#backdrop.hidden = true;
          this.#root?.removeAttribute("closing");
        }
      }, 90);
    } else {
      this.#runtime?.detach();
      this.#surfaceShell.hidden = true;
      this.#backdrop.hidden = true;
      this.#root.removeAttribute("closing");
    }
    this.#render();
  }

  #clearOpenTransitionTimer() {
    if (this.#openTransitionTimer === null) {
      return;
    }
    this.window.clearTimeout(this.#openTransitionTimer);
    this.#openTransitionTimer = null;
  }

  #clearCloseTransitionTimer() {
    if (this.#closeTransitionTimer === null) {
      return;
    }
    this.window.clearTimeout(this.#closeTransitionTimer);
    this.#closeTransitionTimer = null;
  }

  #bindBrowserTitle(item, browser) {
    if (browser.getAttribute("sine-web-panels-title-bound") === item.id) {
      return;
    }
    browser.setAttribute("sine-web-panels-title-bound", item.id);
    const update = () => {
      const title = browser.contentTitle || browser.getAttribute("contentTitle") || "";
      const count = parseWebPanelUnreadCount(title);
      if (count) {
        this.#unreadCounts.set(item.id, count);
      } else {
        this.#unreadCounts.delete(item.id);
      }
      this.#render();
    };
    browser.addEventListener("DOMTitleChanged", update, { signal: this.#abortController.signal });
    browser.addEventListener("load", update, { signal: this.#abortController.signal });
  }

  #applyUnreadBadge(button, itemId) {
    const count = this.#unreadCounts.get(itemId);
    const badge = displayCount(count);
    if (!badge) {
      return;
    }

    button.setAttribute("badged", "true");
    button.setAttribute("unread-count", String(count));
    button.append(this.#el("span", { class: "sine-web-panels-badge" }, badge));
  }

  #buildEditor() {
    const editor = this.#xul("panel", {
      id: EDITOR_ID,
      class: "cui-widget-panel panel-no-padding",
      type: "arrow",
      orient: "vertical",
      flip: "slide",
      consumeoutsideclicks: "never",
      hidden: "true",
    });
    const form = this.#el("form", { id: "sine-web-panels-editor-content" });
    const input = this.#el("input", {
      id: "sine-web-panels-url-input",
      type: "text",
      autocomplete: "url",
      placeholder: "https://calendar.google.com",
      "aria-label": "Web Panel URL",
    });
    const error = this.#el("div", {
      id: "sine-web-panels-editor-error",
      role: "alert",
      hidden: "true",
    });
    const submit = this.#button({
      id: "sine-web-panels-editor-submit",
      label: "+ Add",
      className: "sine-web-panels-ghost-button",
    });
    submit.type = "submit";
    form.append(input, submit, error);
    form.addEventListener("submit", event => {
      event.preventDefault();
      this.#saveEditor();
    }, { signal: this.#abortController.signal });
    input.addEventListener("input", () => {
      submit.disabled = !input.value.trim();
      error.hidden = true;
    }, { signal: this.#abortController.signal });
    editor.addEventListener("popuphidden", () => {
      editor.hidden = true;
      this.#editorState = null;
    }, { signal: this.#abortController.signal });
    editor.append(form);
    return editor;
  }

  #openEditor({ mode, item = null, anchor = null, insertIndex = this.#items.length }) {
    const input = this.#editor.querySelector("input");
    const submit = this.#editor.querySelector("button");
    const error = this.#editor.querySelector('[role="alert"]');
    this.#closeMenu();
    this.#editorState = { mode, itemId: item?.id ?? null, insertIndex };
    input.value = item?.url ?? this.#currentTabUrl() ?? "";
    submit.textContent = mode === "edit" ? "Save" : "+ Add";
    submit.disabled = !input.value.trim();
    error.hidden = true;
    this.#editor.hidden = false;
    this.#openEditorPopup(anchor ?? this.#rail);
    this.window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  #saveEditor() {
    const input = this.#editor.querySelector("input");
    const error = this.#editor.querySelector('[role="alert"]');
    const url = normalizeWebPanelUrl(input.value);
    if (!url) {
      error.textContent = "Enter a valid http or https URL.";
      error.hidden = false;
      return;
    }

    if (this.#editorState?.mode === "edit") {
      const updated = this.#store.updatePanel(this.#editorState.itemId, url);
      if (updated) {
        this.#runtime.unload(updated.id);
      }
    } else {
      this.#store.insert(this.#store.createPanel(url), this.#editorState?.insertIndex ?? this.#items.length);
    }

    this.#closeEditor();
    this.#render();
  }

  #closeEditor() {
    if (!this.#editor) {
      return;
    }

    if (typeof this.#editor.hidePopup === "function" && this.#editor.state !== "closed") {
      this.#editor.hidePopup();
      return;
    }

    this.#editor.hidden = true;
    this.#editorState = null;
  }

  #openItemMenu(event, item) {
    event.preventDefault();
    event.stopPropagation();
    const index = this.#items.findIndex(entry => entry.id === item.id);
    const actions = isPanel(item)
      ? [
          ["Open in New Tab", () => this.#openInNewTab(item.url)],
          ["Edit Web Panel", () => this.#openEditor({ mode: "edit", item, anchor: this.#findItemElement(item.id) })],
          ["Reset Web Panel", () => this.#resetPanel(item)],
          ["Replace with Current URL", () => this.#replacePanelUrlWithCurrent(item), !this.#currentPanelUrl(item)],
          ["Move Up", () => this.#moveItem(item.id, index - 1), index <= 0],
          ["Move Down", () => this.#moveItem(item.id, index + 1), index >= this.#items.length - 1],
          ["separator"],
          ["Reload Web Panel", () => this.#reloadPanel(item)],
          ["Unload Web Panel", () => this.#runtime.unload(item.id)],
          ["Delete Web Panel", () => this.#deleteItem(item.id)],
        ]
      : [
          ["Move Up", () => this.#moveItem(item.id, index - 1), index <= 0],
          ["Move Down", () => this.#moveItem(item.id, index + 1), index >= this.#items.length - 1],
          ["separator"],
          ["Delete", () => this.#deleteItem(item.id)],
        ];
    this.#openMenu(event.clientX, event.clientY, actions);
  }

  #onRailContextMenu = event => {
    if (event.target.closest(".sine-web-panels-item") || event.target.closest(`#${ADD_BUTTON_ID}`)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.#railInsertIndex = this.#insertIndexFromY(event.clientY);
    this.#openMenu(event.clientX, event.clientY, [
      ["Add Spacer", () => {
        this.#store.insert(this.#store.createSeparator(), this.#railInsertIndex);
        this.#render();
      }],
      ["New Web Panel", () => this.#openEditor({ mode: "add", anchor: this.#rail, insertIndex: this.#railInsertIndex })],
    ]);
  };

  #openMenu(x, y, actions) {
    this.#closeEditor();
    this.#menu.replaceChildren();
    for (const action of actions) {
      if (action[0] === "separator") {
        this.#menu.append(this.#el("hr"));
        continue;
      }
      const [label, handler, disabled = false] = action;
      const button = this.#button({ label, className: "sine-web-panels-menu-item" });
      button.disabled = disabled;
      button.addEventListener("click", event => {
        event.stopPropagation();
        this.#closeMenu();
        handler();
      }, { signal: this.#abortController.signal });
      this.#menu.append(button);
    }
    this.#menu.hidden = false;
    this.#menuOpenedAt = this.window.performance.now();
    this.#menu.style.left = `${Math.min(x, this.window.innerWidth - 220)}px`;
    this.#menu.style.top = `${Math.min(y, this.window.innerHeight - 20)}px`;
  }

  #closeMenu() {
    this.#menu.hidden = true;
    this.#menuOpenedAt = 0;
  }

  #deleteItem(id) {
    this.#runtime.unload(id);
    this.#store.remove(id);
    if (this.#activeId === id) {
      this.#closePanel({ animate: false });
    }
    this.#unreadCounts.delete(id);
    this.#render();
  }

  #reloadPanel(item) {
    const browser = this.#runtime.getBrowser(item);
    if (typeof browser?.reload !== "function") {
      console.error("[Web Panels] Could not reload the panel browser.", { panelId: item?.id });
      return;
    }
    browser.reload();
  }

  #resetPanel(item, expectedBrowser = null) {
    const currentItem = this.#store.items.find(
      entry => entry.id === item?.id && isPanel(entry)
    );
    if (!currentItem) {
      return false;
    }
    const reset = this.#runtime.resetPanel(currentItem, expectedBrowser);
    if (!reset) {
      console.error("[Web Panels] Could not reset the panel.", {
        panelId: currentItem.id,
      });
      return false;
    }
    this.#unreadCounts.delete(currentItem.id);
    this.#render();
    return true;
  }

  #currentPanelUrl(item) {
    const browser = this.#runtime?.getBrowser(item);
    return normalizeWebPanelUrl(browser?.currentURI?.spec);
  }

  #replacePanelUrlWithCurrent(item) {
    const currentItem = this.#store.items.find(
      entry => entry.id === item?.id && isPanel(entry)
    );
    const browser = currentItem ? this.#runtime.getBrowser(currentItem) : null;
    const currentUrl = normalizeWebPanelUrl(browser?.currentURI?.spec);
    if (!currentItem || !browser || !currentUrl) {
      console.error("[Web Panels] The current panel URL is unavailable.", {
        panelId: item?.id,
      });
      return false;
    }

    const updated = this.#store.updatePanel(currentItem.id, currentUrl);
    if (!updated || !this.#runtime.adoptCurrentUrl(updated, browser)) {
      if (updated && !this.#store.replacePanel(currentItem)) {
        console.error("[Web Panels] Could not restore the saved panel metadata.", {
          panelId: currentItem.id,
        });
      }
      console.error("[Web Panels] Could not replace the saved panel URL.", {
        panelId: currentItem.id,
      });
      return false;
    }

    this.#unreadCounts.delete(currentItem.id);
    this.#render();
    return true;
  }

  #moveItem(id, targetIndex) {
    this.#store.move(id, targetIndex);
    this.#render();
  }

  #onItemPointerDown(event, item) {
    if (event.button !== 0 || this.#dragState || this.#resizeState) {
      return;
    }
    const target = this.#findItemElement(item.id);
    this.#dragState = {
      itemId: item.id,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      dragging: false,
      target,
    };
    target?.setPointerCapture?.(event.pointerId);
  }

  #onPointerMove = event => {
    if (this.#resizeState) {
      if (event.pointerId !== this.#resizeState.pointerId) {
        return;
      }
      this.#resize(event);
      return;
    }

    if (!this.#dragState || event.pointerId !== this.#dragState.pointerId) {
      return;
    }

    const distance = Math.hypot(event.clientX - this.#dragState.startX, event.clientY - this.#dragState.startY);
    if (!this.#dragState.dragging && distance < 4) {
      return;
    }

    this.#dragState.dragging = true;
    this.#root.setAttribute("dragging", "true");
    this.#dragState.target?.setAttribute("dragging", "true");
    this.#showDropIndicator(this.#insertIndexFromY(event.clientY));
  };

  #onPointerUp = event => {
    if (this.#resizeState) {
      const resize = this.#resizeState;
      if (event.pointerId !== resize.pointerId) {
        return;
      }
      this.#finishResize();
      if (resize.captureTarget?.hasPointerCapture?.(resize.pointerId)) {
        resize.captureTarget.releasePointerCapture(resize.pointerId);
      }
      return;
    }

    if (!this.#dragState || event.pointerId !== this.#dragState.pointerId) {
      return;
    }

    const drag = this.#dragState;
    this.#dragState = null;
    this.#root.removeAttribute("dragging");
    drag.target?.removeAttribute("dragging");
    this.#hideDropIndicator();

    if (drag.dragging && event.type !== "pointercancel") {
      event.preventDefault();
      this.#store.move(drag.itemId, this.#insertIndexFromY(event.clientY));
      this.#render();
    }
  };

  #showDropIndicator(index) {
    let indicator = this.document.getElementById("sine-web-panels-drop-indicator");
    if (!indicator) {
      indicator = this.#el("div", { id: "sine-web-panels-drop-indicator" });
      this.#rail.append(indicator);
    }

    const children = [...this.#list.querySelectorAll(".sine-web-panels-item")];
    const target = children[index] ?? children[children.length - 1];
    const railRect = this.#rail.getBoundingClientRect();
    const targetRect = target?.getBoundingClientRect();
    const top = targetRect
      ? index >= children.length
        ? targetRect.bottom - railRect.top + 3
        : targetRect.top - railRect.top - 3
      : 16;
    indicator.style.top = `${top}px`;
  }

  #hideDropIndicator() {
    this.document.getElementById("sine-web-panels-drop-indicator")?.remove();
  }

  #insertIndexFromY(clientY) {
    const nodes = [...this.#list.querySelectorAll(".sine-web-panels-item")];
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return Number.parseInt(node.dataset.index, 10);
      }
    }
    return this.#items.length;
  }

  #onResizeStart = event => {
    if (this.#resizeState || this.#dragState) {
      return;
    }
    event.preventDefault();
    const width = this.#surfaceShell.getBoundingClientRect().width;
    this.#resizeState = {
      captureTarget: event.currentTarget,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      side: this.#placementSide(),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    this.#root.setAttribute("resizing", "true");
  };

  #resize(event) {
    const delta = this.#resizeState.side === "right"
      ? this.#resizeState.startX - event.clientX
      : event.clientX - this.#resizeState.startX;
    const width = this.#clampWidth(this.#resizeState.startWidth + delta);
    this.#root.style.setProperty("--sine-web-panels-width", `${width}px`);
  }

  #finishResize() {
    const width = Number.parseInt(
      this.window.getComputedStyle(this.#root).getPropertyValue("--sine-web-panels-width"),
      10
    );
    this.#store.width = this.#clampWidth(width);
    this.#root.style.setProperty("--sine-web-panels-width", `${this.#store.width}px`);
    this.#root.removeAttribute("resizing");
    this.#resizeState = null;
  }

  #clampWidth(width) {
    return clampWebPanelWidth(width, this.#pageViewportGeometry().maxWidth);
  }

  #onWindowResize = () => {
    this.#observePageViewport();
    this.#syncPageViewportGeometry();
  };

  #onDocumentClick = event => {
    if (!this.#menu.hidden && this.window.performance.now() - this.#menuOpenedAt < 250) {
      return;
    }
    if (event.target.closest(`#${MENU_ID}`) || event.target.closest(`#${EDITOR_ID}`)) {
      return;
    }
    this.#closeMenu();
    if (!event.target.closest(`#${ADD_BUTTON_ID}`)) {
      this.#closeEditor();
    }
  };

  #onKeyDown = event => {
    if (event.key === "Escape") {
      this.#closeMenu();
      this.#closeEditor();
      this.#closePanel();
    }
  };

  #onContentContextMenuShowing = event => {
    if (event.target === this.#contentContextMenu) {
      this.#resetContentContextState();
      const target = this.#activeContentContextTarget(this.window.gContextMenu);
      if (!target) {
        return;
      }

      const state = {
        ...target,
        externalMethodDescriptors: [],
        itemAttributeSnapshots: [],
        methodDescriptors: [],
        restoreNavigation: null,
      };
      this.#panelContextState = state;
      try {
        state.restoreNavigation = configureWebPanelContextNavigation(
          this.document,
          state.browser,
          state.tab
        );
        this.#installPanelContextOverrides(state);
        this.#contentResetMenuItem?.removeAttribute("hidden");
      } catch (error) {
        console.error("[Web Panels] Could not prepare the panel context menu.", error);
        event.preventDefault();
        this.#resetContentContextState();
      }
      return;
    }
  };

  #onContentContextMenuHiding = event => {
    if (event.target === this.#contentContextMenu) {
      this.#resetContentContextState();
    }
  };

  #onContentContextMenuCommand = event => {
    const commandId = event.target?.id;
    if (!WEB_PANEL_CONTEXT_NAVIGATION_IDS.includes(commandId)) {
      return;
    }
    const state = this.#panelContextState;
    if (!state) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    if (!this.#isContentContextStateValid(state)) {
      console.warn("[Web Panels] Ignored stale panel context navigation.", {
        commandId,
        panelId: state.panelId,
      });
      this.#deferContentContextMenuHide();
      return;
    }

    try {
      routeWebPanelNavigationCommand(commandId, {
        browser: state.browser,
        tab: state.tab,
        event,
        navigationFlags: {
          none: Ci.nsIWebNavigation.LOAD_FLAGS_NONE,
          bypassProxy: Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY,
          bypassCache: Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE,
        },
      });
    } catch (error) {
      console.error("[Web Panels] Panel context navigation failed.", {
        commandId,
        error,
        panelId: state.panelId,
      });
    } finally {
      this.#deferContentContextMenuHide();
    }
  };

  #onResetPanelFromContentMenu = event => {
    const state = this.#panelContextState;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!this.#isContentContextStateValid(state)) {
      console.warn("[Web Panels] Ignored a stale panel reset action.", {
        panelId: state?.panelId,
      });
      this.#deferContentContextMenuHide();
      return;
    }

    const item = this.#items.find(
      entry => entry.id === state.panelId && isPanel(entry)
    );
    if (!item) {
      console.warn("[Web Panels] Ignored a reset for a missing panel.", {
        panelId: state.panelId,
      });
      this.#deferContentContextMenuHide();
      return;
    }

    this.#resetPanel(item, state.browser);
    this.#deferContentContextMenuHide();
  };

  #onTabContextMenuShowing = event => {
    if (event.target.id !== "tabContextMenu" || !this.#tabContextMenuItem) {
      return;
    }

    const url = this.#contextTabUrl();
    const isAvailable = this.#store.enabled && Boolean(url);
    this.#tabContextMenuItem.hidden = false;
    this.#tabContextMenuItem.disabled = !isAvailable;
  };

  #onAddTabToWebPanels = event => {
    event.preventDefault();
    const url = this.#contextTabUrl();
    const panel = this.#store.createPanel(url);
    if (!panel) {
      return;
    }

    this.#store.insert(panel, this.#store.items.length);
    this.#render();
  };

  #contextTabUrl() {
    const tab =
      this.window.TabContextMenu?.contextTab ??
      this.window.gBrowser?.selectedTab ??
      null;
    const spec = tab?.linkedBrowser?.currentURI?.spec;
    return normalizeWebPanelUrl(spec);
  }

  #openEditorPopup(anchor) {
    if (typeof this.#editor.openPopup !== "function") {
      return;
    }

    const position = this.#placementSide() === "right"
      ? "leftcenter rightcenter"
      : "rightcenter leftcenter";
    this.#editor.openPopup(anchor, position, 0, 0, false, false);
  }

  #placementSide() {
    return this.document.documentElement.getAttribute("zen-right-side") === "true" ? "left" : "right";
  }

  #currentTabUrl() {
    const spec = this.window.gBrowser?.selectedBrowser?.currentURI?.spec;
    return normalizeWebPanelUrl(spec) ? spec : "";
  }

  #openInNewTab(url) {
    const safeUrl = normalizeWebPanelUrl(url);
    if (!safeUrl) {
      return;
    }
    let opened = false;
    if (typeof this.window.openTrustedLinkIn === "function") {
      this.window.openTrustedLinkIn(safeUrl, "tab", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      opened = true;
    } else {
      opened = Boolean(
        this.window.gBrowser?.addTrustedTab?.(safeUrl, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        })
      );
    }
    if (!opened) {
      return false;
    }
    this.#closePanel({ animate: false });
    return true;
  }

  #findItemElement(id) {
    return this.#list.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
  }

  #button({ id = null, label = "", title = "", className = "" } = {}) {
    const button = this.#el("button", { type: "button" }, label);
    if (id) {
      button.id = id;
    }
    if (title) {
      button.title = title;
    }
    if (className) {
      button.className = className;
    }
    return button;
  }

  #el(tagName, attrs = {}, text = null) {
    const element = this.document.createElement(tagName);
    this.#setAttributes(element, attrs);
    if (text) {
      element.textContent = text;
    }
    return element;
  }

  #xul(tagName, attrs = {}) {
    const element = typeof this.document.createXULElement === "function"
      ? this.document.createXULElement(tagName)
      : this.document.createElementNS(
        "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
        tagName
      );
    this.#setAttributes(element, attrs);
    return element;
  }

  #setAttributes(element, attrs = {}) {
    for (const [name, value] of Object.entries(attrs)) {
      if (/^on/i.test(name)) {
        throw new TypeError(`Event handler attributes are not allowed: ${name}`);
      }
      if (value === null || value === undefined || value === false) {
        continue;
      }
      if (name === "class" || name === "className") {
        element.setAttribute("class", String(value));
      } else if (name === "hidden" && value === "true") {
        element.hidden = true;
      } else {
        element.setAttribute(name, String(value));
      }
    }
  }
}

if (typeof window !== "undefined") {
  window[INSTANCE_KEY]?.destroy?.();
  const instance = new SineWebPanels(window);
  window[INSTANCE_KEY] = instance;
  instance.init();

  const unload = () => {
    if (window[INSTANCE_KEY] !== instance) {
      return;
    }
    instance.destroy();
    delete window[INSTANCE_KEY];
  };

  if (typeof window.addUnloadListener === "function") {
    window.addUnloadListener(unload);
  } else {
    window.addEventListener("unload", unload, { once: true });
  }
}
