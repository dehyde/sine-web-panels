const MODULE_VERSION = new URL(import.meta.url).search;
const { normalizeWebPanelUrl } = await import(
  `./web-panels-store.uc.mjs${MODULE_VERSION}`
);

const ACTIVATION_RETRY_DELAY_MS = 50;
const MAX_ACTIVATION_ATTEMPTS = 100;
const RESET_RESTORE_TIMEOUT_MS = 30_000;
const ACTIVE_BROWSER_ATTRIBUTE = "sine-web-panel-active";
const ACTIVE_CONTAINER_CLASS = "sine-web-panel-native-overlay";
const PANEL_CONTAINER_ATTRIBUTE = "sine-web-panel-container";
const PANEL_ID_ATTRIBUTE = "sine-web-panel-id";
const PANEL_SESSION_KEY = "sineWebPanelBacking";
const PANEL_TAB_ATTRIBUTE = "sine-web-panel-tab";
const TAB_HIDE_OWNER = "sine-web-panels";

export const WEB_PANEL_RUNTIME_INVALIDATED_EVENT =
  "sine-web-panel-runtime-invalidated";

const TAB_REMOVAL_OPTIONS = Object.freeze({
  animate: false,
  skipPermitUnload: true,
  skipSessionStore: true,
});

export class WebPanelsRuntime {
  #window;
  #surface;
  #gBrowser;
  #browsers = new Map();
  #activeId = null;
  #activationTimers = new Map();
  #ownedClosingTabs = new WeakSet();
  #abortController;
  #resizeObserver = null;
  #lastSelectedTab = null;
  #orphanScanQueued = false;
  #pendingOrphanChecks = new WeakSet();
  #pendingTabRepairs = new WeakSet();
  #destroyed = false;

  constructor(windowRef, surface) {
    this.#window = windowRef;
    this.#surface = surface;
    this.#gBrowser = windowRef?.gBrowser ?? null;
    this.#lastSelectedTab = this.#gBrowser?.selectedTab ?? null;

    const AbortControllerRef = windowRef?.AbortController ?? globalThis.AbortController;
    this.#abortController = new AbortControllerRef();
    const signal = this.#abortController.signal;
    this.#queueOrphanScan();
    this.#gBrowser?.tabContainer?.addEventListener?.(
      "TabOpen",
      this.#onTabOpen,
      { signal }
    );
    this.#gBrowser?.tabContainer?.addEventListener?.(
      "TabClose",
      this.#onTabClose,
      { signal }
    );
    this.#gBrowser?.tabContainer?.addEventListener?.(
      "TabSelect",
      this.#onTabSelect,
      { signal }
    );
    this.#gBrowser?.tabContainer?.addEventListener?.(
      "TabShow",
      this.#onTabShow,
      { signal }
    );
    windowRef?.addEventListener?.("resize", this.#onResize, { signal });
    windowRef?.addEventListener?.(
      "SSWindowStateReady",
      this.#onSessionStoreReady,
      { signal }
    );

    if (surface && typeof windowRef?.ResizeObserver === "function") {
      this.#resizeObserver = new windowRef.ResizeObserver(this.#syncActiveGeometry);
      this.#resizeObserver.observe(surface);
    }
  }

  getBrowser(itemOrId) {
    const id = typeof itemOrId === "string" ? itemOrId : itemOrId?.id;
    return id ? this.#browsers.get(String(id))?.browser ?? null : null;
  }

  getUserBrowser() {
    return this.#currentUserTab()?.linkedBrowser ?? null;
  }

  resetPanel(item, expectedBrowser = null) {
    const normalizedItem = this.#normalizedItem(item);
    if (!normalizedItem || this.#destroyed) {
      return false;
    }

    const runtime = this.#browsers.get(normalizedItem.id);
    if (!runtime) {
      return expectedBrowser === null;
    }
    if (runtime.resetInProgress) {
      return (
        runtime.item.url === normalizedItem.url &&
        (!expectedBrowser || runtime.browser === expectedBrowser)
      );
    }
    if (
      runtime.item.url !== normalizedItem.url ||
      (expectedBrowser && runtime.browser !== expectedBrowser)
    ) {
      return false;
    }

    const selectedBefore = this.#gBrowser?.selectedTab ?? null;
    let clearHistoryRestoreWait = null;
    let stateApplied = false;
    try {
      if (
        !this.#isOwnedRuntimeValid(runtime) ||
        !this.#validUserTab(selectedBefore) ||
        runtime.tab.hasAttribute?.("pending") ||
        this.#window?.SessionStore?.isTabRestoring?.(runtime.tab)
      ) {
        return false;
      }

      const sessionStore = this.#window?.SessionStore;
      if (
        typeof sessionStore?.getTabState !== "function" ||
        typeof sessionStore?.setTabState !== "function"
      ) {
        throw new Error("SessionStore tab-state APIs are unavailable.");
      }

      const services = this.#window?.Services ?? globalThis.Services;
      const e10sUtils = this.#e10sUtils();
      if (
        typeof services?.io?.newURI !== "function" ||
        typeof services?.scriptSecurityManager?.createContentPrincipal !== "function" ||
        typeof e10sUtils?.serializePrincipal !== "function"
      ) {
        throw new Error("Content-principal APIs are unavailable.");
      }

      const state = JSON.parse(sessionStore.getTabState(runtime.tab));
      if (!state || typeof state !== "object" || !Array.isArray(state.entries)) {
        throw new Error("The panel tab state is malformed.");
      }

      const uri = services.io.newURI(normalizedItem.url);
      const originAttributes = typeof e10sUtils.predictOriginAttributes === "function"
        ? e10sUtils.predictOriginAttributes({ browser: runtime.browser })
        : {};
      const principal = services.scriptSecurityManager.createContentPrincipal(
        uri,
        originAttributes
      );
      state.entries = [
        {
          url: normalizedItem.url,
          ...(normalizedItem.title ? { title: normalizedItem.title } : {}),
          triggeringPrincipal_base64: e10sUtils.serializePrincipal(principal),
        },
      ];
      state.index = 0;
      delete state.scroll;

      const onRestoring = () => {
        clearHistoryRestoreWait?.();
        if (
          this.#browsers.get(normalizedItem.id) !== runtime ||
          !this.#isRuntimeValid(runtime)
        ) {
          runtime.resetCleanup?.();
          return;
        }
        try {
          this.#restoreBackingTabOwnership(runtime, selectedBefore);
          if (!this.#isOwnedRuntimeValid(runtime)) {
            throw new Error("The reset panel backing tab lost ownership.");
          }
          if (!runtime.tab.hasAttribute?.("pending")) {
            return;
          }
          if (typeof runtime.browser.reload !== "function") {
            throw new Error("The panel browser cannot resume session restoration.");
          }
          runtime.browser.reload();
          this.#restoreUserSelection(selectedBefore, runtime);
        } catch (error) {
          console.error("[Web Panels] Could not resume the reset panel.", {
            error,
            panelId: normalizedItem.id,
          });
          runtime.resetCleanup?.();
          this.#invalidateRuntime(runtime, "reset-restore-failure", {
            removeTab: true,
          });
        }
      };
      const onRestored = () => {
        runtime.resetCleanup?.();
        if (
          this.#browsers.get(normalizedItem.id) !== runtime ||
          !this.#isRuntimeValid(runtime)
        ) {
          return;
        }
        try {
          this.#restoreBackingTabOwnership(runtime, selectedBefore);
          if (!this.#isOwnedRuntimeValid(runtime)) {
            throw new Error("The restored panel backing tab lost ownership.");
          }
        } catch (error) {
          console.error("[Web Panels] Could not finish the reset panel.", {
            error,
            panelId: normalizedItem.id,
          });
          this.#invalidateRuntime(runtime, "reset-completion-failure", {
            removeTab: true,
          });
        }
      };
      runtime.tab.addEventListener?.("SSTabRestoring", onRestoring, { once: true });
      runtime.tab.addEventListener?.("SSTabRestored", onRestored, { once: true });
      let removeRestoringListener = () => {
        runtime.tab.removeEventListener?.("SSTabRestoring", onRestoring);
      };
      let removeRestoredListener = () => {
        runtime.tab.removeEventListener?.("SSTabRestored", onRestored);
      };

      runtime.resetInProgress = true;
      const restoreTimer = this.#window.setTimeout(() => {
        clearHistoryRestoreWait?.();
        if (
          this.#browsers.get(normalizedItem.id) !== runtime ||
          !this.#isRuntimeValid(runtime)
        ) {
          runtime.resetCleanup?.();
          return;
        }
        if (!runtime.tab.hasAttribute?.("pending")) {
          return;
        }
        console.error("[Web Panels] Reset panel restoration timed out.", {
          panelId: normalizedItem.id,
        });
        runtime.resetCleanup?.();
        this.#invalidateRuntime(runtime, "reset-restore-timeout", {
          removeTab: true,
        });
      }, RESET_RESTORE_TIMEOUT_MS);
      clearHistoryRestoreWait = () => {
        removeRestoringListener?.();
        removeRestoringListener = null;
        this.#window?.clearTimeout?.(restoreTimer);
        clearHistoryRestoreWait = null;
      };
      runtime.resetCleanup = () => {
        clearHistoryRestoreWait?.();
        removeRestoredListener?.();
        removeRestoredListener = null;
        runtime.resetCleanup = null;
        runtime.resetInProgress = false;
      };

      sessionStore.setTabState(runtime.tab, state);
      stateApplied = true;
      this.#restoreBackingTabOwnership(runtime, selectedBefore);
      if (!this.#isOwnedRuntimeValid(runtime)) {
        throw new Error("The panel backing tab changed while it was reset.");
      }
      runtime.item = normalizedItem;
      return true;
    } catch (error) {
      clearHistoryRestoreWait?.();
      runtime.resetCleanup?.();
      try {
        this.#restoreUserSelection(selectedBefore, runtime);
      } catch (selectionError) {
        console.error("[Web Panels] Could not preserve the selected user tab.", {
          error: selectionError,
          panelId: normalizedItem.id,
        });
      }
      if (
        stateApplied &&
        this.#browsers.get(normalizedItem.id) === runtime
      ) {
        this.#invalidateRuntime(runtime, "reset-state-failure", {
          removeTab: this.#isRuntimeValid(runtime),
        });
      }
      console.error("[Web Panels] Could not reset the panel URL.", {
        error,
        panelId: normalizedItem.id,
      });
      return false;
    }
  }

  adoptCurrentUrl(item, expectedBrowser = null) {
    const normalizedItem = this.#normalizedItem(item);
    if (!normalizedItem || this.#destroyed) {
      return false;
    }

    const runtime = this.#browsers.get(normalizedItem.id);
    if (
      !runtime ||
      runtime.resetInProgress ||
      (expectedBrowser && runtime.browser !== expectedBrowser)
    ) {
      return false;
    }

    try {
      if (!this.#isOwnedRuntimeValid(runtime)) {
        return false;
      }
      const currentUrl = normalizeWebPanelUrl(runtime.browser.currentURI?.spec);
      if (!currentUrl || currentUrl !== normalizedItem.url) {
        return false;
      }
      runtime.item = normalizedItem;
      return true;
    } catch (error) {
      console.error("[Web Panels] Could not adopt the current panel URL.", {
        error,
        panelId: normalizedItem.id,
      });
      return false;
    }
  }

  syncGeometry() {
    this.#syncActiveGeometry();
  }

  ensureBrowser(item) {
    return this.#ensureRuntime(item)?.browser ?? null;
  }

  attach(item) {
    const runtime = this.#ensureRuntime(item);
    if (!runtime) {
      return null;
    }

    const previousRuntime = this.#activeId
      ? this.#browsers.get(this.#activeId) ?? null
      : null;
    runtime.parentTab = this.#currentUserTab();

    try {
      this.#present(runtime);
    } catch (error) {
      this.#invalidateRuntime(runtime, "presentation-failure", {
        removeTab: true,
      });
      if (previousRuntime && previousRuntime !== runtime) {
        try {
          this.#present(previousRuntime);
        } catch (restoreError) {
          this.#invalidateRuntime(previousRuntime, "presentation-failure", {
            removeTab: true,
          });
          console.error("[Web Panels] Could not restore the previous native panel.", {
            error: restoreError,
            panelId: previousRuntime.item.id,
          });
        }
      }
      console.error("[Web Panels] Could not present the native panel browser.", {
        error,
        panelId: runtime.item.id,
      });
      return null;
    }

    if (previousRuntime && previousRuntime !== runtime) {
      this.#clearPresentation(previousRuntime);
      this.#deactivateBrowser(previousRuntime.browser);
    }
    this.#activeId = runtime.item.id;
    this.#syncGeometry(runtime);
    this.#activateBrowser(runtime.browser);
    return runtime.browser;
  }

  detach() {
    if (!this.#activeId) {
      return;
    }
    const runtime = this.#browsers.get(this.#activeId);
    if (runtime) {
      this.#clearPresentation(runtime);
      this.#deactivateBrowser(runtime.browser);
    }
    this.#activeId = null;
  }

  unload(id) {
    const runtime = this.#browsers.get(String(id));
    if (!runtime) {
      return;
    }

    const wasActive = this.#activeId === runtime.item.id;
    this.#browsers.delete(runtime.item.id);
    if (wasActive) {
      this.#activeId = null;
    }
    this.#disposeRuntime(runtime, { removeTab: true });
    if (wasActive) {
      this.#notifyInvalidated(runtime.item.id, "unload");
    }
  }

  unloadMissing(itemIds) {
    const currentIds = new Set(itemIds.map(String));
    for (const id of [...this.#browsers.keys()]) {
      if (!currentIds.has(id)) {
        this.unload(id);
      }
    }
  }

  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#abortController.abort();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.detach();
    for (const id of [...this.#browsers.keys()]) {
      this.unload(id);
    }
    this.#surface?.replaceChildren?.();
    this.#gBrowser = null;
    this.#surface = null;
    this.#window = null;
    this.#lastSelectedTab = null;
  }

  #ensureRuntime(item) {
    const normalizedItem = this.#normalizedItem(item);
    if (
      !normalizedItem ||
      this.#destroyed ||
      !this.#surface ||
      typeof this.#gBrowser?.addWebTab !== "function" ||
      typeof this.#gBrowser?.hideTab !== "function"
    ) {
      return null;
    }

    const existing = this.#browsers.get(normalizedItem.id);
    if (existing && this.#isRuntimeValid(existing)) {
      if (existing.item.url === normalizedItem.url) {
        return existing;
      }
      this.unload(normalizedItem.id);
    } else if (existing) {
      this.#browsers.delete(normalizedItem.id);
      this.#disposeRuntime(existing, { removeTab: true });
    }

    return this.#createRuntime(normalizedItem);
  }

  #createRuntime(item) {
    const selectedBefore = this.#gBrowser.selectedTab;
    const selectedOwnerBefore = selectedBefore?.owner ?? null;
    let tab = null;
    let browser = null;
    let container = null;

    try {
      try {
        tab = this.#gBrowser.addWebTab(item.url, {
          createLazyBrowser: false,
          inBackground: true,
          ownerTab: null,
          relatedToCurrent: false,
          skipAnimation: true,
          skipBackgroundNotify: true,
          skipRoute: true,
          userContextId: 0,
        });
      } finally {
        if (
          selectedBefore &&
          !selectedBefore.closing &&
          selectedBefore.owner !== selectedOwnerBefore
        ) {
          selectedBefore.owner = selectedOwnerBefore;
        }
      }
      if (!tab || tab.closing) {
        throw new Error("Zen did not create a backing tab.");
      }

      tab.owner = null;
      tab.undiscardable = true;
      tab.setAttribute(PANEL_TAB_ATTRIBUTE, "true");
      tab.setAttribute(PANEL_ID_ATTRIBUTE, item.id);

      browser = tab.linkedBrowser;
      if (!browser || this.#gBrowser.getTabForBrowser?.(browser) !== tab) {
        throw new Error("The backing tab and browser identity did not match.");
      }
      this.#ensureSessionValue(tab, PANEL_SESSION_KEY, item.id);

      container = browser.closest?.(".browserSidebarContainer") ?? null;
      if (!container?.classList || !container?.style) {
        throw new Error("The native browser container was not available.");
      }

      this.#addBrowserClass(browser, "sine-web-panels-browser");
      browser.setAttribute(PANEL_ID_ATTRIBUTE, item.id);
      container.setAttribute?.(PANEL_CONTAINER_ATTRIBUTE, "true");
      container.setAttribute?.(PANEL_ID_ATTRIBUTE, item.id);

      this.#gBrowser.hideTab(tab, TAB_HIDE_OWNER);
      if (!tab.hidden) {
        throw new Error("Zen did not hide the panel backing tab.");
      }
      this.#ensureSessionValue(tab, "hiddenBy", TAB_HIDE_OWNER);
      if (this.#gBrowser.selectedTab !== selectedBefore) {
        throw new Error("Creating the panel unexpectedly changed the selected tab.");
      }

      const runtime = { browser, container, item, parentTab: selectedBefore, tab };
      this.#browsers.set(item.id, runtime);
      this.#resizeObserver?.observe(container);
      return runtime;
    } catch (error) {
      this.#rollbackCreation({ browser, container, selectedBefore, tab });
      console.error("[Web Panels] Could not create a native panel backing tab.", {
        error,
        panelId: item.id,
      });
      return null;
    }
  }

  #rollbackCreation({ browser, container, selectedBefore, tab }) {
    if (browser) {
      this.#clearActivationTimer(browser);
      browser.removeAttribute?.(ACTIVE_BROWSER_ATTRIBUTE);
      browser.zenModeActive = false;
      browser.docShellIsActive = false;
      browser.renderLayers = false;
    }
    container?.classList?.remove(ACTIVE_CONTAINER_CLASS);
    container?.removeAttribute?.(PANEL_CONTAINER_ATTRIBUTE);
    container?.removeAttribute?.(PANEL_ID_ATTRIBUTE);
    if (
      tab &&
      this.#gBrowser?.selectedTab !== selectedBefore &&
      selectedBefore &&
      !selectedBefore.closing
    ) {
      this.#gBrowser.selectedTab = selectedBefore;
    }
    if (tab && !tab.closing) {
      tab.undiscardable = false;
      this.#ownedClosingTabs.add(tab);
      this.#gBrowser?.removeTab?.(tab, TAB_REMOVAL_OPTIONS);
    }
  }

  #isRuntimeValid(runtime) {
    return Boolean(
      runtime?.tab &&
        !runtime.tab.closing &&
        this.#gBrowser?.tabs?.includes(runtime.tab) &&
        runtime.tab.linkedBrowser === runtime.browser &&
        runtime.container &&
        this.#gBrowser?.getTabForBrowser?.(runtime.browser) === runtime.tab
    );
  }

  #isOwnedRuntimeValid(runtime) {
    if (
      !this.#isRuntimeValid(runtime) ||
      this.#browsers.get(runtime.item.id) !== runtime ||
      runtime.tab.selected ||
      this.#gBrowser?.selectedTab === runtime.tab ||
      !runtime.tab.hidden ||
      runtime.tab.owner !== null ||
      !runtime.tab.undiscardable ||
      runtime.tab.getAttribute?.(PANEL_TAB_ATTRIBUTE) !== "true" ||
      runtime.tab.getAttribute?.(PANEL_ID_ATTRIBUTE) !== runtime.item.id ||
      runtime.browser.getAttribute?.(PANEL_ID_ATTRIBUTE) !== runtime.item.id ||
      runtime.container.getAttribute?.(PANEL_CONTAINER_ATTRIBUTE) !== "true" ||
      runtime.container.getAttribute?.(PANEL_ID_ATTRIBUTE) !== runtime.item.id
    ) {
      return false;
    }

    const sessionStore = this.#window?.SessionStore;
    if (typeof sessionStore?.getCustomTabValue !== "function") {
      return false;
    }
    return (
      sessionStore.getCustomTabValue(runtime.tab, PANEL_SESSION_KEY) ===
        runtime.item.id &&
      sessionStore.getCustomTabValue(runtime.tab, "hiddenBy") === TAB_HIDE_OWNER
    );
  }

  #restoreUserSelection(selectedTab, runtime) {
    const currentTab = this.#gBrowser?.selectedTab ?? null;
    if (
      currentTab !== runtime?.tab &&
      !runtime?.tab?.selected &&
      this.#validUserTab(currentTab)
    ) {
      return;
    }
    const fallback = this.#validUserTab(selectedTab)
      ? selectedTab
      : this.#fallbackUserTab(runtime);
    if (!fallback) {
      throw new Error("The previously selected user tab is unavailable.");
    }
    this.#gBrowser.selectedTab = fallback;
    if (
      this.#gBrowser.selectedTab !== fallback ||
      runtime?.tab?.selected
    ) {
      throw new Error("The selected user tab could not be restored.");
    }
  }

  #restoreBackingTabOwnership(runtime, selectedTab) {
    this.#restoreUserSelection(selectedTab, runtime);
    runtime.tab.owner = null;
    runtime.tab.undiscardable = true;
    if (!runtime.tab.hidden) {
      this.#gBrowser.hideTab(runtime.tab, TAB_HIDE_OWNER);
    }
    if (!runtime.tab.hidden) {
      throw new Error("The reset panel backing tab could not be re-hidden.");
    }
    runtime.tab.setAttribute(PANEL_TAB_ATTRIBUTE, "true");
    runtime.tab.setAttribute(PANEL_ID_ATTRIBUTE, runtime.item.id);
    runtime.browser.setAttribute(PANEL_ID_ATTRIBUTE, runtime.item.id);
    this.#ensureSessionValue(runtime.tab, PANEL_SESSION_KEY, runtime.item.id);
    this.#ensureSessionValue(runtime.tab, "hiddenBy", TAB_HIDE_OWNER);
  }

  #e10sUtils() {
    const available = this.#window?.E10SUtils ?? globalThis.E10SUtils;
    if (available) {
      return available;
    }
    const chromeUtils = this.#window?.ChromeUtils ?? globalThis.ChromeUtils;
    return chromeUtils?.importESModule?.(
      "resource://gre/modules/E10SUtils.sys.mjs"
    )?.E10SUtils ?? null;
  }

  #present(runtime) {
    if (!this.#isRuntimeValid(runtime)) {
      throw new Error("The cached native panel runtime is no longer valid.");
    }
    runtime.container.classList.add(ACTIVE_CONTAINER_CLASS);
    runtime.browser.setAttribute(ACTIVE_BROWSER_ATTRIBUTE, "");
  }

  #clearPresentation(runtime) {
    runtime?.container?.classList?.remove(ACTIVE_CONTAINER_CLASS);
    runtime?.browser?.removeAttribute?.(ACTIVE_BROWSER_ATTRIBUTE);
  }

  #disposeRuntime(runtime, { removeTab }) {
    runtime.resetCleanup?.();
    this.#resizeObserver?.unobserve?.(runtime.container);
    this.#clearPresentation(runtime);
    this.#deactivateBrowser(runtime.browser);
    runtime.container?.removeAttribute?.(PANEL_CONTAINER_ATTRIBUTE);
    runtime.container?.removeAttribute?.(PANEL_ID_ATTRIBUTE);
    runtime.tab.undiscardable = false;
    if (removeTab && !runtime.tab.closing) {
      this.#ownedClosingTabs.add(runtime.tab);
      this.#gBrowser?.removeTab?.(runtime.tab, TAB_REMOVAL_OPTIONS);
    }
  }

  #activateBrowser(browser, attempt = 1) {
    const panelId = browser?.getAttribute?.(PANEL_ID_ATTRIBUTE);
    const runtime = panelId ? this.#browsers.get(panelId) : null;
    if (!browser || runtime?.browser !== browser) {
      this.#clearActivationTimer(browser);
      return;
    }

    browser.zenModeActive = true;
    browser.docShellIsActive = true;
    browser.renderLayers = true;

    if (browser.docShellIsActive && browser.renderLayers) {
      this.#clearActivationTimer(browser);
      return;
    }

    if (attempt >= MAX_ACTIVATION_ATTEMPTS) {
      this.#clearActivationTimer(browser);
      console.error("[Web Panels] The native panel browser did not become render-ready.", {
        panelId,
      });
      this.#invalidateRuntime(runtime, "activation-timeout", { removeTab: true });
      return;
    }

    this.#clearActivationTimer(browser);
    const timer = this.#window.setTimeout(() => {
      this.#activationTimers.delete(browser);
      this.#activateBrowser(browser, attempt + 1);
    }, ACTIVATION_RETRY_DELAY_MS);
    this.#activationTimers.set(browser, timer);
  }

  #deactivateBrowser(browser) {
    if (!browser) {
      return;
    }
    this.#clearActivationTimer(browser);
    browser.zenModeActive = false;
    browser.docShellIsActive = false;
    browser.renderLayers = false;
  }

  #clearActivationTimer(browser) {
    const timer = this.#activationTimers.get(browser);
    if (timer !== undefined) {
      this.#window?.clearTimeout(timer);
      this.#activationTimers.delete(browser);
    }
  }

  #syncGeometry(runtime) {
    if (
      !runtime?.container?.style ||
      !runtime.container.getBoundingClientRect ||
      !this.#surface?.getBoundingClientRect
    ) {
      return;
    }
    const surfaceRect = this.#surfaceTargetRect();
    const containerRect = runtime.container.getBoundingClientRect();
    runtime.container.style.setProperty(
      "--sine-web-panel-native-top",
      `${surfaceRect.top - containerRect.top}px`
    );
    runtime.container.style.setProperty(
      "--sine-web-panel-native-left",
      `${surfaceRect.left - containerRect.left}px`
    );
    runtime.container.style.setProperty(
      "--sine-web-panel-native-width",
      `${surfaceRect.width}px`
    );
    runtime.container.style.setProperty(
      "--sine-web-panel-native-height",
      `${surfaceRect.height}px`
    );
    const surfaceRight = surfaceRect.left + surfaceRect.width;
    const surfaceBottom = surfaceRect.top + surfaceRect.height;
    const root = this.#surface.closest?.("#sine-web-panels-root");
    root?.style?.setProperty(
      "--sine-web-panel-surface-top",
      `${surfaceRect.top}px`
    );
    root?.style?.setProperty(
      "--sine-web-panel-surface-right",
      `${surfaceRight}px`
    );
    root?.style?.setProperty(
      "--sine-web-panel-surface-bottom",
      `${surfaceBottom}px`
    );
    root?.style?.setProperty(
      "--sine-web-panel-surface-left",
      `${surfaceRect.left}px`
    );
    const containerRight = containerRect.left + containerRect.width;
    const containerBottom = containerRect.top + containerRect.height;
    runtime.container.style.setProperty(
      "--sine-web-panel-native-clip-top",
      `${surfaceRect.top - containerRect.top}px`
    );
    runtime.container.style.setProperty(
      "--sine-web-panel-native-clip-right",
      `${containerRight - surfaceRight}px`
    );
    runtime.container.style.setProperty(
      "--sine-web-panel-native-clip-bottom",
      `${containerBottom - surfaceBottom}px`
    );
    runtime.container.style.setProperty(
      "--sine-web-panel-native-clip-left",
      `${surfaceRect.left - containerRect.left}px`
    );
  }

  #surfaceTargetRect() {
    const rect = this.#surface.getBoundingClientRect();
    const shell = this.#surface.closest?.("#sine-web-panels-shell");
    const transform = shell
      ? this.#window?.getComputedStyle?.(shell)?.transform
      : null;
    if (!transform || transform === "none") {
      return rect;
    }

    const DOMMatrixRef =
      this.#window?.DOMMatrixReadOnly ?? this.#window?.DOMMatrix ?? null;
    if (typeof DOMMatrixRef !== "function") {
      return rect;
    }

    try {
      const matrix = new DOMMatrixRef(transform);
      return {
        top: rect.top - matrix.m42,
        left: rect.left - matrix.m41,
        width: rect.width,
        height: rect.height,
      };
    } catch (error) {
      console.error("[Web Panels] Could not normalize the animated panel geometry.", {
        error,
      });
      return rect;
    }
  }

  #syncActiveGeometry = () => {
    if (!this.#activeId) {
      return;
    }
    this.#syncGeometry(this.#browsers.get(this.#activeId));
  };

  #onResize = () => {
    this.#syncActiveGeometry();
  };

  #onSessionStoreReady = () => {
    this.#queueOrphanScan();
  };

  #onTabClose = event => {
    const tab = event.target;
    if (this.#ownedClosingTabs.has(tab)) {
      return;
    }
    const runtime = this.#runtimeForTab(tab);
    if (!runtime) {
      return;
    }

    this.#invalidateRuntime(runtime, "tab-close", { removeTab: false });
  };

  #onTabSelect = event => {
    const tab = event.target;
    const runtime = this.#runtimeForTab(tab);
    if (!runtime) {
      if (tab && !tab.closing) {
        this.#lastSelectedTab = tab;
      }
      return;
    }

    this.#queueTabRepair(runtime, "tab-select");
  };

  #onTabShow = event => {
    const runtime = this.#runtimeForTab(event.target);
    if (!runtime || runtime.tab.closing) {
      return;
    }

    this.#queueTabRepair(runtime, "tab-show");
  };

  #queueTabRepair(runtime, reason) {
    const tab = runtime?.tab;
    if (!tab || this.#pendingTabRepairs.has(tab)) {
      return;
    }

    const queueMicrotaskRef = this.#window?.queueMicrotask ?? globalThis.queueMicrotask;
    if (typeof queueMicrotaskRef !== "function") {
      this.#invalidateRuntime(runtime, reason, { removeTab: true });
      return;
    }

    this.#pendingTabRepairs.add(tab);
    try {
      queueMicrotaskRef(() => this.#repairBackingTab(runtime, reason));
    } catch (error) {
      this.#pendingTabRepairs.delete(tab);
      console.error("[Web Panels] Could not schedule panel tab repair.", {
        error,
        panelId: runtime.item.id,
      });
      this.#invalidateRuntime(runtime, reason, { removeTab: true });
    }
  }

  #repairBackingTab(runtime, reason) {
    const tab = runtime?.tab;
    if (tab) {
      this.#pendingTabRepairs.delete(tab);
    }
    if (
      this.#destroyed ||
      !runtime ||
      this.#browsers.get(runtime.item.id) !== runtime
    ) {
      return;
    }
    if (!this.#isRuntimeValid(runtime)) {
      this.#invalidateRuntime(runtime, reason, { removeTab: true });
      return;
    }

    if (this.#gBrowser.selectedTab === tab || tab.selected) {
      const fallback = this.#fallbackUserTab(runtime);
      if (!fallback) {
        this.#invalidateRuntime(runtime, reason, { removeTab: true });
        return;
      }
      try {
        this.#gBrowser.selectedTab = fallback;
      } catch (error) {
        console.error("[Web Panels] Could not restore the user tab.", {
          error,
          panelId: runtime.item.id,
        });
        this.#invalidateRuntime(runtime, reason, { removeTab: true });
        return;
      }
      if (
        this.#gBrowser.selectedTab === tab ||
        tab.selected ||
        !this.#isRuntimeValid(runtime)
      ) {
        this.#invalidateRuntime(runtime, reason, { removeTab: true });
        return;
      }
    }

    try {
      if (!tab.hidden) {
        this.#gBrowser.hideTab(tab, TAB_HIDE_OWNER);
      }
      if (!tab.hidden) {
        throw new Error("Zen did not re-hide the panel backing tab.");
      }
      this.#ensureSessionValue(tab, PANEL_SESSION_KEY, runtime.item.id);
      this.#ensureSessionValue(tab, "hiddenBy", TAB_HIDE_OWNER);
      if (this.#activeId === runtime.item.id) {
        this.#present(runtime);
      }
    } catch (error) {
      console.error("[Web Panels] Could not repair a panel backing tab.", {
        error,
        panelId: runtime.item.id,
      });
      this.#invalidateRuntime(runtime, reason, { removeTab: true });
    }
  }

  #ensureSessionValue(tab, key, value) {
    const sessionStore = this.#window?.SessionStore;
    if (
      typeof sessionStore?.getCustomTabValue !== "function" ||
      typeof sessionStore?.setCustomTabValue !== "function"
    ) {
      throw new Error("SessionStore tab ownership is unavailable.");
    }
    if (sessionStore.getCustomTabValue(tab, key) !== value) {
      sessionStore.setCustomTabValue(tab, key, value);
    }
    if (sessionStore.getCustomTabValue(tab, key) !== value) {
      throw new Error(`The panel tab ${key} marker was not persisted.`);
    }
  }

  #onTabOpen = event => {
    const tab = event.target;
    this.#queueOrphanCheck(tab);
  };

  #queueOrphanScan() {
    if (this.#orphanScanQueued || this.#destroyed) {
      return;
    }
    const queueMicrotaskRef = this.#window?.queueMicrotask ?? globalThis.queueMicrotask;
    if (typeof queueMicrotaskRef !== "function") {
      return;
    }
    this.#orphanScanQueued = true;
    queueMicrotaskRef(() => {
      this.#orphanScanQueued = false;
      if (!this.#destroyed) {
        this.#removeOrphanedBackingTabs();
      }
    });
  }

  #queueOrphanCheck(tab) {
    if (!tab || this.#pendingOrphanChecks.has(tab) || this.#destroyed) {
      return;
    }
    const queueMicrotaskRef = this.#window?.queueMicrotask ?? globalThis.queueMicrotask;
    if (typeof queueMicrotaskRef !== "function") {
      return;
    }
    this.#pendingOrphanChecks.add(tab);
    queueMicrotaskRef(() => {
      this.#pendingOrphanChecks.delete(tab);
      if (
        this.#destroyed ||
        tab.closing ||
        !this.#gBrowser?.tabs?.includes(tab)
      ) {
        return;
      }
      if (this.#isOrphanedBackingTab(tab)) {
        this.#removeOrphanedBackingTab(tab);
      }
    });
  }

  #invalidateRuntime(runtime, reason, { removeTab }) {
    if (!runtime || this.#browsers.get(runtime.item.id) !== runtime) {
      return;
    }
    const wasActive = this.#activeId === runtime.item.id;
    this.#browsers.delete(runtime.item.id);
    if (wasActive) {
      this.#activeId = null;
    }
    this.#disposeRuntime(runtime, { removeTab });
    if (wasActive) {
      this.#notifyInvalidated(runtime.item.id, reason);
    }
  }

  #runtimeForTab(tab) {
    for (const runtime of this.#browsers.values()) {
      if (runtime.tab === tab) {
        return runtime;
      }
    }
    return null;
  }

  #currentUserTab() {
    const selectedTab = this.#gBrowser?.selectedTab ?? null;
    return this.#runtimeForTab(selectedTab)
      ? this.#lastSelectedTab
      : selectedTab;
  }

  #fallbackUserTab(runtime) {
    if (this.#validUserTab(this.#lastSelectedTab)) {
      return this.#lastSelectedTab;
    }
    if (this.#validUserTab(runtime.parentTab)) {
      return runtime.parentTab;
    }
    return (
      this.#gBrowser?.visibleTabs?.find(candidate => this.#validUserTab(candidate)) ??
      null
    );
  }

  #validUserTab(tab) {
    return Boolean(
      tab &&
        !tab.closing &&
        this.#gBrowser?.tabs?.includes(tab) &&
        this.#gBrowser?.visibleTabs?.includes(tab) &&
        !this.#runtimeForTab(tab)
    );
  }

  #removeOrphanedBackingTabs() {
    for (const tab of [...(this.#gBrowser?.tabs ?? [])]) {
      if (this.#isOrphanedBackingTab(tab)) {
        this.#removeOrphanedBackingTab(tab);
      }
    }
  }

  #isOrphanedBackingTab(tab) {
    if (!tab || tab.closing || this.#runtimeForTab(tab)) {
      return false;
    }
    if (tab.getAttribute?.(PANEL_TAB_ATTRIBUTE) === "true") {
      return true;
    }
    const sessionStore = this.#window?.SessionStore;
    if (typeof sessionStore?.getCustomTabValue !== "function") {
      return false;
    }
    try {
      return Boolean(sessionStore.getCustomTabValue(tab, PANEL_SESSION_KEY)) ||
        sessionStore.getCustomTabValue(tab, "hiddenBy") === TAB_HIDE_OWNER;
    } catch (error) {
      console.error("[Web Panels] Could not inspect a restored hidden tab.", {
        error,
      });
      return false;
    }
  }

  #removeOrphanedBackingTab(tab) {
    if (!tab || tab.closing || typeof this.#gBrowser?.removeTab !== "function") {
      return;
    }
    if (this.#gBrowser.selectedTab === tab || tab.selected) {
      let fallback = this.#lastSelectedTab;
      if (
        fallback === tab ||
        !this.#validUserTab(fallback) ||
        this.#isOrphanedBackingTab(fallback)
      ) {
        fallback = this.#gBrowser.visibleTabs?.find(
          candidate =>
            candidate !== tab &&
            this.#validUserTab(candidate) &&
            !this.#isOrphanedBackingTab(candidate)
        ) ?? null;
      }
      if (!fallback) {
        return;
      }
      this.#gBrowser.selectedTab = fallback;
      if (this.#gBrowser.selectedTab !== fallback) {
        return;
      }
      this.#lastSelectedTab = fallback;
    }
    tab.undiscardable = false;
    this.#ownedClosingTabs.add(tab);
    this.#gBrowser.removeTab(tab, TAB_REMOVAL_OPTIONS);
  }

  #notifyInvalidated(panelId, reason) {
    const CustomEventRef = this.#window?.CustomEvent ?? globalThis.CustomEvent;
    if (!CustomEventRef || !this.#surface?.dispatchEvent) {
      return;
    }
    this.#surface.dispatchEvent(
      new CustomEventRef(WEB_PANEL_RUNTIME_INVALIDATED_EVENT, {
        detail: { panelId, reason },
      })
    );
  }

  #addBrowserClass(browser, className) {
    if (browser.classList?.add) {
      browser.classList.add(className);
      return;
    }
    const current = browser.getAttribute?.("class") ?? "";
    const classes = new Set(current.split(/\s+/).filter(Boolean));
    classes.add(className);
    browser.setAttribute?.("class", [...classes].join(" "));
  }

  #normalizedItem(item) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const id = item.id ? String(item.id) : "";
    const url = normalizeWebPanelUrl(item.url);
    if (!id || !url) {
      return null;
    }

    return {
      ...item,
      id,
      url,
    };
  }
}
