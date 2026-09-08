export const WEBRTC_PERMISSION_NOTIFICATION_ID = "webRTC-shareDevices";
export const WEBRTC_MICROPHONE_ANCHOR_ID =
  "webRTC-shareMicrophone-notification-icon";

const NOTIFICATION_PANEL_ID = "notification-popup";
const NOTIFICATION_ICON_BOX_ID = "notification-popup-box";
const POPUP_NOTIFICATIONS_MODULE =
  "resource://gre/modules/PopupNotifications.sys.mjs";
const NATIVE_OBSERVER_TOPICS = Object.freeze([
  "fullscreen-transition-start",
  "pointer-lock-entered",
]);

function restoreOwnProperty(target, name, descriptor) {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor);
  } else {
    delete target[name];
  }
}

export function isWebPanelMicrophonePrompt(id, anchorId) {
  return (
    id === WEBRTC_PERMISSION_NOTIFICATION_ID &&
    anchorId === WEBRTC_MICROPHONE_ANCHOR_ID
  );
}

export class WebPanelPermissionRouter {
  #window;
  #PopupNotificationsClass;
  #primary = null;
  #routed = null;
  #panel = null;
  #iconBox = null;
  #activeBrowser = null;
  #getAnchor = null;
  #showDescriptor = null;
  #showState = null;
  #showWrapper = null;
  #adoptionTimer = null;
  #initialized = false;
  #destroyed = false;

  constructor(windowRef, { PopupNotificationsClass = null } = {}) {
    this.#window = windowRef;
    this.#PopupNotificationsClass = PopupNotificationsClass;
  }

  activate({ browser, getAnchor } = {}) {
    if (
      this.#destroyed ||
      !browser ||
      typeof getAnchor !== "function"
    ) {
      return false;
    }

    if (browser !== this.#activeBrowser) {
      this.#deactivateCurrentBrowser();
    }
    this.#activeBrowser = browser;
    this.#getAnchor = getAnchor;

    if (!this.#initialized && !this.#initialize()) {
      return false;
    }

    this.#adoptQueuedPrompt();
    return true;
  }

  deactivate() {
    return this.#deactivateCurrentBrowser();
  }

  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#deactivateCurrentBrowser();
    this.#removeRouterListeners();
    this.#cleanupRoutedPopupState();
    this.#restoreShowWrapper();
    this.#releaseRoutedOwner();
    this.#initialized = false;
  }

  #initialize() {
    const primary = this.#window?.PopupNotifications;
    const panel = this.#window?.document?.getElementById?.(
      NOTIFICATION_PANEL_ID
    );
    const iconBox = this.#window?.document?.getElementById?.(
      NOTIFICATION_ICON_BOX_ID
    );
    const PopupNotificationsClass = this.#resolvePopupNotificationsClass();

    if (
      !primary ||
      typeof primary.show !== "function" ||
      !panel ||
      !iconBox ||
      typeof PopupNotificationsClass !== "function"
    ) {
      this.#report(
        "warn",
        "Microphone permission routing is waiting for the native notification UI."
      );
      return false;
    }

    const listenerRegistrations = [];
    const windowFacade = this.#createWindowFacade(listenerRegistrations);
    const router = this;
    const tabbrowserFacade = {
      documentGlobal: windowFacade,
      tabContainer: null,
      get selectedBrowser() {
        return router.#activeBrowser;
      },
      get selectedTab() {
        return router.#resolveVisibleAnchor() ?? iconBox;
      },
    };

    let routed;
    try {
      routed = new PopupNotificationsClass(
        tabbrowserFacade,
        panel,
        iconBox,
        {
          getVisibleAnchorElement(nativeAnchor) {
            return (
              router.#resolveVisibleAnchor() ??
              router.#visibleElement(nativeAnchor) ??
              router.#visibleElement(iconBox)
            );
          },
        }
      );
      routed.window = this.#window;
    } catch (error) {
      this.#removeWindowRegistrations(listenerRegistrations);
      this.#report(
        "error",
        "Could not create the isolated microphone notification owner.",
        error
      );
      return false;
    }

    this.#primary = primary;
    this.#routed = routed;
    this.#panel = panel;
    this.#iconBox = iconBox;

    if (!this.#isUsableRoutedOwner()) {
      this.#removeWindowRegistrations(listenerRegistrations);
      this.#releaseRoutedOwner();
      this.#report(
        "error",
        "The native microphone notification owner did not expose its required lifecycle methods."
      );
      return false;
    }

    this.#isolateRoutedUpdates();
    this.#detachConstructorListeners(listenerRegistrations);

    if (!this.#installShowWrapper()) {
      this.#releaseRoutedOwner();
      return false;
    }

    panel.addEventListener("popupshowing", this.#onPanelChanged, true);
    panel.addEventListener("popupshown", this.#onPanelChanged, true);
    panel.addEventListener("PanelUpdated", this.#onPanelChanged, true);
    panel.addEventListener("popuphidden", this.#onPopupHidden, true);
    this.#window.addEventListener?.("activate", this.#onWindowActivate, true);
    this.#initialized = true;
    return true;
  }

  #resolvePopupNotificationsClass() {
    if (typeof this.#PopupNotificationsClass === "function") {
      return this.#PopupNotificationsClass;
    }

    const chromeUtils =
      this.#window?.ChromeUtils ??
      globalThis.ChromeUtils ??
      (typeof ChromeUtils === "undefined" ? null : ChromeUtils);
    try {
      return chromeUtils?.importESModule?.(POPUP_NOTIFICATIONS_MODULE)
        ?.PopupNotifications;
    } catch (error) {
      this.#report(
        "error",
        "Could not load Firefox microphone notification support.",
        error
      );
      return null;
    }
  }

  #createWindowFacade(listenerRegistrations) {
    const windowRef = this.#window;
    return {
      document: windowRef.document,
      addEventListener(type, listener, options) {
        listenerRegistrations.push({ listener, options, type });
        windowRef.addEventListener?.(type, listener, options);
      },
      removeEventListener(type, listener, options) {
        windowRef.removeEventListener?.(type, listener, options);
      },
    };
  }

  #isUsableRoutedOwner() {
    return Boolean(
      typeof this.#routed?.show === "function" &&
        typeof this.#routed?.getNotificationsForBrowser === "function" &&
        (typeof this.#routed?._remove === "function" ||
          typeof this.#routed?.remove === "function")
    );
  }

  #isolateRoutedUpdates() {
    const routed = this.#routed;
    if (typeof routed?._update !== "function") {
      return;
    }

    const nativeUpdate = routed._update;
    routed._update = (notifications, anchors, dismissShowing) => {
      const candidates = notifications ?? this.#notificationsFor(
        this.#activeBrowser
      );
      const owned = [...(candidates ?? [])].filter(
        notification => notification?.owner === routed
      );
      return nativeUpdate.call(
        routed,
        owned,
        anchors,
        dismissShowing
      );
    };
  }

  #detachConstructorListeners(listenerRegistrations) {
    this.#panel?.removeEventListener?.("popuphidden", this.#routed);
    this.#panel?.removeEventListener?.("popuppositioned", this.#routed);
    this.#iconBox?.removeEventListener?.("click", this.#routed);
    this.#iconBox?.removeEventListener?.("keypress", this.#routed);
    this.#removeWindowRegistrations(listenerRegistrations);
    this.#removeNativeObservers();
  }

  #removeWindowRegistrations(listenerRegistrations) {
    for (const { listener, options, type } of listenerRegistrations) {
      this.#window?.removeEventListener?.(type, listener, options);
    }
    listenerRegistrations.length = 0;
  }

  #removeNativeObservers() {
    const services =
      this.#window?.Services ??
      globalThis.Services ??
      (typeof Services === "undefined" ? null : Services);
    for (const topic of NATIVE_OBSERVER_TOPICS) {
      try {
        services?.obs?.removeObserver?.(this.#routed, topic);
      } catch {
        // The injected test owner and partially constructed native owners may
        // not have registered these observers.
      }
    }
  }

  #installShowWrapper() {
    const primary = this.#primary;
    const originalShow = primary.show;
    const showDescriptor = Object.getOwnPropertyDescriptor(primary, "show");
    const state = {
      originalShow,
      router: this,
    };
    const wrapper = function (...args) {
      const activeRouter = state.router;
      if (!activeRouter) {
        return state.originalShow.apply(this, args);
      }
      return activeRouter.#routeShow(this, args);
    };

    try {
      Object.defineProperty(primary, "show", {
        configurable: true,
        writable: true,
        value: wrapper,
      });
    } catch (error) {
      this.#report(
        "error",
        "Could not install isolated microphone permission routing.",
        error
      );
      return false;
    }

    this.#showDescriptor = showDescriptor;
    this.#showState = state;
    this.#showWrapper = wrapper;
    return true;
  }

  #routeShow(receiver, args) {
    const [browser, id, , anchorId] = args;
    if (
      browser !== this.#activeBrowser ||
      !isWebPanelMicrophonePrompt(id, anchorId) ||
      !this.#browserBelongsToWindow(browser)
    ) {
      return this.#showState.originalShow.apply(receiver, args);
    }

    // The Firefox notification panel is shared. Preserve an already visible
    // normal-tab prompt, queue this request natively, and adopt it after that
    // prompt closes instead of dismissing unrelated browser UI.
    if (this.#hasForeignPopup()) {
      return this.#showState.originalShow.apply(receiver, args);
    }

    this.#removeSupersededDevicePrompts(browser);
    return this.#routed.show.apply(this.#routed, args);
  }

  #browserBelongsToWindow(browser) {
    return (
      !browser?.ownerDocument ||
      browser.ownerDocument === this.#window?.document
    );
  }

  #removeSupersededDevicePrompts(browser) {
    for (const notification of [...this.#notificationsFor(browser)]) {
      if (notification?.id !== WEBRTC_PERMISSION_NOTIFICATION_ID) {
        continue;
      }
      this.#removeNotification(notification, true);
    }
  }

  #deactivateCurrentBrowser() {
    this.#clearAdoptionTimer();
    const browser = this.#activeBrowser;
    if (!browser) {
      this.#getAnchor = null;
      return false;
    }

    this.#activeBrowser = null;
    this.#getAnchor = null;
    this.#cancelOwnedPrompts(browser, { hideVisible: true });
    return true;
  }

  #cancelOwnedPrompts(browser, { hideVisible = false } = {}) {
    const notifications = this.#ownedPrompts(browser);
    const visible = notifications.some(
      notification => this.#visibleNotification() === notification
    );

    for (const notification of notifications) {
      this.#removeNotification(notification, true);
    }

    if (hideVisible && visible) {
      this.#hideRoutedPopup();
    }
  }

  #removeNotification(notification, withoutUserResponse) {
    const owner = notification?.owner;
    try {
      if (typeof owner?._remove === "function") {
        owner._remove(notification, withoutUserResponse);
      } else {
        owner?.remove?.(notification, withoutUserResponse);
      }
    } catch (error) {
      this.#report(
        "error",
        "Could not cancel an unanswered panel microphone prompt.",
        error
      );
    }
  }

  #hideRoutedPopup() {
    try {
      const hidden = this.#routed?._hidePanel?.();
      hidden?.catch?.(error =>
        this.#report(
          "error",
          "Could not close the panel microphone prompt.",
          error
        )
      );
      if (!hidden && this.#panel?.state !== "closed") {
        this.#panel?.hidePopup?.();
      }
    } catch (error) {
      this.#report(
        "error",
        "Could not close the panel microphone prompt.",
        error
      );
    }
  }

  #adoptQueuedPrompt() {
    if (
      !this.#initialized ||
      !this.#activeBrowser ||
      this.#hasForeignPopup()
    ) {
      return false;
    }

    const notification = [...this.#notificationsFor(this.#activeBrowser)]
      .reverse()
      .find(
        candidate =>
          candidate?.owner === this.#primary &&
          isWebPanelMicrophonePrompt(candidate?.id, candidate?.anchorID)
      );
    if (!notification) {
      return false;
    }

    const previousOwner = notification.owner;
    try {
      notification.owner = this.#routed;
      if (typeof notification.reshow === "function") {
        notification.reshow();
      } else if (typeof this.#routed._update === "function") {
        this.#routed._update([notification], undefined, true);
      } else {
        throw new Error("The native notification could not be reshown.");
      }
      return true;
    } catch (error) {
      notification.owner = previousOwner;
      this.#report(
        "error",
        "Could not foreground the queued panel microphone prompt.",
        error
      );
      return false;
    }
  }

  #notificationsFor(browser) {
    if (!browser) {
      return [];
    }
    try {
      return this.#primary?.getNotificationsForBrowser?.(browser) ??
        this.#routed?.getNotificationsForBrowser?.(browser) ??
        [];
    } catch (error) {
      this.#report(
        "error",
        "Could not inspect pending panel microphone prompts.",
        error
      );
      return [];
    }
  }

  #ownedPrompts(browser) {
    return [...this.#notificationsFor(browser)].filter(
      notification =>
        notification?.owner === this.#routed &&
        isWebPanelMicrophonePrompt(
          notification?.id,
          notification?.anchorID
        )
    );
  }

  #visibleNotification() {
    return this.#panel?.firstElementChild?.notification ?? null;
  }

  #hasForeignPopup() {
    if (!this.#panel || this.#panel.state === "closed") {
      return false;
    }
    const notification = this.#visibleNotification();
    return Boolean(
      !notification ||
        notification.owner !== this.#routed ||
        notification.browser !== this.#activeBrowser
    );
  }

  #resolveVisibleAnchor() {
    let anchor;
    try {
      anchor = this.#getAnchor?.();
    } catch (error) {
      this.#report(
        "warn",
        "The live web-panel microphone anchor was unavailable.",
        error
      );
      return null;
    }
    return this.#visibleElement(anchor);
  }

  #visibleElement(element) {
    if (
      !element ||
      element.isConnected === false ||
      (element.ownerDocument &&
        element.ownerDocument !== this.#window?.document)
    ) {
      return null;
    }
    try {
      if (
        typeof element.checkVisibility === "function" &&
        !element.checkVisibility()
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return element;
  }

  #onPanelChanged = () => {
    const visible = this.#visibleNotification();
    if (
      visible?.owner === this.#routed &&
      visible.browser === this.#activeBrowser
    ) {
      return;
    }

    if (this.#activeBrowser) {
      this.#cancelOwnedPrompts(this.#activeBrowser);
    }
  };

  #onPopupHidden = event => {
    if (event?.target !== this.#panel) {
      return;
    }

    const visible = this.#visibleNotification();
    if (visible?.owner === this.#routed) {
      this.#cancelOwnedPrompts(visible.browser);
    }
    this.#cleanupRoutedPopupState();
    this.#scheduleAdoption();
  };

  #onWindowActivate = () => {
    this.#scheduleAdoption();
  };

  #scheduleAdoption() {
    this.#clearAdoptionTimer();
    if (!this.#activeBrowser || this.#destroyed) {
      return;
    }
    const setTimeoutRef =
      this.#window?.setTimeout?.bind(this.#window) ?? globalThis.setTimeout;
    this.#adoptionTimer = setTimeoutRef(() => {
      this.#adoptionTimer = null;
      this.#adoptQueuedPrompt();
    }, 0);
  }

  #clearAdoptionTimer() {
    if (this.#adoptionTimer === null) {
      return;
    }
    const clearTimeoutRef =
      this.#window?.clearTimeout?.bind(this.#window) ?? globalThis.clearTimeout;
    clearTimeoutRef(this.#adoptionTimer);
    this.#adoptionTimer = null;
  }

  #cleanupRoutedPopupState() {
    const routed = this.#routed;
    if (!routed) {
      return;
    }
    try {
      routed._clearPopupshownListener?.();
    } catch (error) {
      this.#report(
        "error",
        "Could not clear the panel microphone popup listener.",
        error
      );
    }
    this.#window?.removeEventListener?.(
      "keypress",
      routed._handleWindowKeyPress,
      true
    );
    if (routed._ignoreDismissal) {
      routed._ignoreDismissal.resolve?.();
      routed._ignoreDismissal = null;
    }
    routed._currentAnchorElement = null;
  }

  #removeRouterListeners() {
    this.#panel?.removeEventListener?.(
      "popupshowing",
      this.#onPanelChanged,
      true
    );
    this.#panel?.removeEventListener?.(
      "popupshown",
      this.#onPanelChanged,
      true
    );
    this.#panel?.removeEventListener?.(
      "PanelUpdated",
      this.#onPanelChanged,
      true
    );
    this.#panel?.removeEventListener?.(
      "popuphidden",
      this.#onPopupHidden,
      true
    );
    this.#window?.removeEventListener?.(
      "activate",
      this.#onWindowActivate,
      true
    );
  }

  #restoreShowWrapper() {
    if (!this.#showState) {
      return;
    }
    this.#showState.router = null;
    if (
      this.#primary &&
      this.#showWrapper &&
      this.#primary.show === this.#showWrapper
    ) {
      try {
        restoreOwnProperty(
          this.#primary,
          "show",
          this.#showDescriptor
        );
      } catch (error) {
        this.#report(
          "error",
          "Could not restore native microphone notification routing.",
          error
        );
      }
    }
    this.#showDescriptor = null;
    this.#showWrapper = null;
  }

  #releaseRoutedOwner() {
    if (this.#routed) {
      this.#panel?.removeEventListener?.("popuphidden", this.#routed);
      this.#panel?.removeEventListener?.("popuppositioned", this.#routed);
      this.#iconBox?.removeEventListener?.("click", this.#routed);
      this.#iconBox?.removeEventListener?.("keypress", this.#routed);
      this.#removeNativeObservers();
    }
    this.#routed = null;
    this.#panel = null;
    this.#iconBox = null;
    this.#primary = null;
  }

  #report(level, message, error = null) {
    const consoleRef = this.#window?.console ?? globalThis.console;
    const logger = consoleRef?.[level];
    if (typeof logger !== "function") {
      return;
    }
    if (error) {
      logger.call(consoleRef, `[Web Panels] ${message}`, error);
    } else {
      logger.call(consoleRef, `[Web Panels] ${message}`);
    }
  }
}
