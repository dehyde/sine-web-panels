import assert from "node:assert/strict";
import test from "node:test";

const { WebPanelPermissionRouter } = await import(
  "../web-panels-permissions.uc.mjs"
);

const WEBRTC_NOTIFICATION_ID = "webRTC-shareDevices";
const MICROPHONE_ANCHOR_ID =
  "webRTC-shareMicrophone-notification-icon";

function createEventTarget(extra = {}) {
  const listeners = new Map();
  return Object.assign(extra, {
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    dispatch(type, detail = null) {
      const event = { detail, target: this, type };
      for (const listener of [...(listeners.get(type) ?? [])]) {
        if (typeof listener === "function") {
          listener(event);
        } else {
          listener?.handleEvent?.(event);
        }
      }
    },
    listenerCount(type = null) {
      if (type) {
        return listeners.get(type)?.size ?? 0;
      }
      return [...listeners.values()].reduce(
        (count, entries) => count + entries.size,
        0
      );
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  });
}

function createBrowser(id, ownerDocument) {
  const attributes = new Map();
  return {
    id,
    ownerDocument,
    getAttribute(name) {
      return attributes.get(name) ?? "";
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
  };
}

function createPopupNotificationsClass() {
  const notificationsByBrowser = new WeakMap();
  const instances = [];
  const removalCalls = [];

  const notificationsFor = browser => {
    let notifications = notificationsByBrowser.get(browser);
    if (!notifications) {
      notifications = [];
      notificationsByBrowser.set(browser, notifications);
    }
    return notifications;
  };

  class FakePopupNotifications {
    constructor(tabbrowser, panel, iconBox, options = {}) {
      this.tabbrowser = tabbrowser;
      this.panel = panel;
      this.iconBox = iconBox;
      this.options = options;
      this.showCalls = [];
      this.reshowCalls = [];
      instances.push(this);
    }

    _isActiveBrowser(browser) {
      return this.tabbrowser?.selectedBrowser === browser;
    }

    getNotification(id, browser) {
      return this.getNotificationsForBrowser(browser).find(
        notification => notification.id === id
      ) ?? null;
    }

    getNotificationsForBrowser(browser) {
      return notificationsFor(browser);
    }

    _remove(notification, withoutUserResponse = false) {
      const notifications = notificationsFor(notification.browser);
      const index = notifications.indexOf(notification);
      if (index < 0) {
        return;
      }
      notifications.splice(index, 1);
      removalCalls.push({
        notification,
        owner: notification.owner,
        removedBy: this,
        withoutUserResponse,
      });
      notification.options.eventCallback?.call(
        notification,
        "removed",
        undefined,
        withoutUserResponse
      );
    }

    remove(notification, withoutUserResponse = false) {
      const wasVisible =
        this.panel.firstElementChild?.notification === notification;
      this._remove(notification, withoutUserResponse);
      if (wasVisible) {
        this.panel.hidePopup();
      }
    }

    _hidePanel() {
      this.panel.hidePopup();
      return Promise.resolve();
    }

    show(...args) {
      const [
        browser,
        id,
        message,
        anchorID,
        mainAction,
        secondaryActions,
        options,
      ] = args;
      const call = {
        active: this._isActiveBrowser(browser),
        args,
        receiver: this,
      };
      this.showCalls.push(call);

      const existing = this.getNotification(id, browser);
      if (existing) {
        this.remove(existing, true);
      }

      const notification = {
        anchorID,
        browser,
        id,
        mainAction,
        message,
        options: options ?? {},
        owner: this,
        secondaryActions,
        remove() {
          this.owner.remove(this);
        },
        reshow() {
          return this.owner.reshow(this);
        },
      };
      notificationsFor(browser).push(notification);
      call.notification = notification;
      call.visibleAnchor = this.#visibleAnchor(notification);

      if (call.active) {
        this.panel.firstElementChild = { notification };
        this.panel.state = "open";
        this.panel.dispatch("popupshowing");
        notification.options.eventCallback?.call(notification, "showing");
        this.panel.dispatch("popupshown");
      }
      return notification;
    }

    reshow(notification) {
      const call = {
        notification,
        visibleAnchor: this.#visibleAnchor(notification),
      };
      this.reshowCalls.push(call);
      if (this._isActiveBrowser(notification.browser)) {
        this.panel.firstElementChild = { notification };
        this.panel.state = "open";
        this.panel.dispatch("popupshowing");
        this.panel.dispatch("popupshown");
      }
      return notification;
    }

    #visibleAnchor(notification) {
      const nativeAnchor = this.iconBox;
      return typeof this.options.getVisibleAnchorElement === "function"
        ? this.options.getVisibleAnchorElement(nativeAnchor)
        : nativeAnchor;
    }
  }

  return {
    FakePopupNotifications,
    instances,
    notificationsByBrowser,
    notificationsFor,
    removalCalls,
    seedNotification(owner, browser, {
      anchorID = MICROPHONE_ANCHOR_ID,
      id = WEBRTC_NOTIFICATION_ID,
      options = {},
    } = {}) {
      const notification = {
        anchorID,
        browser,
        id,
        options,
        owner,
        remove() {
          this.owner.remove(this);
        },
      };
      notificationsFor(browser).push(notification);
      return notification;
    },
  };
}

function createEnvironment({
  includeChromeUi = true,
  includePrimary = true,
} = {}) {
  const elements = new Map();
  const documentRef = {
    getElementById(id) {
      return elements.get(id) ?? null;
    },
  };
  const panel = createEventTarget({
    firstElementChild: null,
    hidePopup() {
      if (this.state === "closed") {
        return;
      }
      this.state = "closed";
      this.dispatch("popuphidden");
      this.firstElementChild = null;
    },
    id: "notification-popup",
    state: "closed",
  });
  const iconBox = createEventTarget({
    checkVisibility: () => true,
    id: "notification-popup-box",
    isConnected: true,
    ownerDocument: documentRef,
  });
  const normalBrowser = createBrowser("normal", documentRef);
  const otherNormalBrowser = createBrowser("other-normal", documentRef);
  const panelA = createBrowser("panel-a", documentRef);
  const panelB = createBrowser("panel-b", documentRef);
  const selectedTab = { id: "selected-user-tab" };
  const forbiddenCalls = [];
  const tabContainer = createEventTarget();
  const gBrowser = {
    documentGlobal: null,
    tabContainer,
    get selectedBrowser() {
      return normalBrowser;
    },
    set selectedBrowser(_browser) {
      forbiddenCalls.push("selectedBrowser");
      throw new Error("The router must not select a browser.");
    },
    get selectedTab() {
      return selectedTab;
    },
    set selectedTab(_tab) {
      forbiddenCalls.push("selectedTab");
      throw new Error("The router must not select a tab.");
    },
    showTab() {
      forbiddenCalls.push("showTab");
      throw new Error("The router must not show a hidden tab.");
    },
  };
  const windowEvents = createEventTarget();
  const windowRef = Object.assign(windowEvents, {
    console: { error() {}, warn() {} },
    document: documentRef,
    gBrowser,
    Services: {
      perms: {
        addFromPrincipal() {
          forbiddenCalls.push("Services.perms.addFromPrincipal");
          throw new Error("The router must not grant permission.");
        },
      },
    },
    SitePermissions: {
      setForPrincipal() {
        forbiddenCalls.push("SitePermissions.setForPrincipal");
        throw new Error("The router must not grant permission.");
      },
    },
  });
  gBrowser.documentGlobal = windowRef;

  const native = createPopupNotificationsClass();
  let primary = null;
  const installChromeUi = () => {
    elements.set(panel.id, panel);
    elements.set(iconBox.id, iconBox);
  };
  const uninstallChromeUi = () => {
    elements.delete(panel.id);
    elements.delete(iconBox.id);
  };
  const installPrimary = () => {
    primary = new native.FakePopupNotifications(
      gBrowser,
      panel,
      iconBox
    );
    windowRef.PopupNotifications = primary;
    return primary;
  };
  if (includeChromeUi) {
    installChromeUi();
  }
  if (includePrimary) {
    installPrimary();
  }

  const anchorA = {
    checkVisibility: () => true,
    id: "panel-a-rail-button",
    isConnected: true,
    ownerDocument: documentRef,
  };
  const anchorB = {
    checkVisibility: () => true,
    id: "panel-b-rail-button",
    isConnected: true,
    ownerDocument: documentRef,
  };
  elements.set(anchorA.id, anchorA);
  elements.set(anchorB.id, anchorB);

  return {
    ...native,
    anchorA,
    anchorB,
    documentRef,
    elements,
    forbiddenCalls,
    get primary() {
      return primary;
    },
    iconBox,
    installChromeUi,
    installPrimary,
    normalBrowser,
    otherNormalBrowser,
    panel,
    panelA,
    panelB,
    selectedTab,
    uninstallChromeUi,
    windowRef,
  };
}

function permissionRequest(browser, overrides = {}) {
  const callbacks = {
    event: overrides.eventCallback ?? function eventCallback() {},
    main: overrides.mainCallback ?? function mainCallback() {},
    secondary:
      overrides.secondaryCallback ?? function secondaryCallback() {},
  };
  const message = overrides.message ?? { id: "microphone-message" };
  const mainAction = {
    accessKey: "A",
    callback: callbacks.main,
    label: "Allow",
  };
  const secondaryActions = [
    {
      accessKey: "B",
      callback: callbacks.secondary,
      label: "Block",
    },
  ];
  const options = {
    eventCallback: callbacks.event,
    persistent: true,
  };
  return {
    args: [
      browser,
      overrides.id ?? WEBRTC_NOTIFICATION_ID,
      message,
      overrides.anchorID ?? MICROPHONE_ANCHOR_ID,
      mainAction,
      secondaryActions,
      options,
    ],
    callbacks,
    mainAction,
    message,
    options,
    secondaryActions,
  };
}

function createRouter(environment) {
  return new WebPanelPermissionRouter(environment.windowRef, {
    PopupNotificationsClass: environment.FakePopupNotifications,
  });
}

function routedOwner(environment) {
  return environment.instances.find(instance => instance !== environment.primary);
}

test("construction is side-effect-free and activate lazily installs routing", () => {
  const environment = createEnvironment();
  const originalShow = environment.primary.show;
  const originalListeners = environment.panel.listenerCount();
  const router = createRouter(environment);

  assert.equal(environment.primary.show, originalShow);
  assert.equal(environment.instances.length, 1);
  assert.equal(environment.panel.listenerCount(), originalListeners);

  assert.equal(
    router.activate({
      browser: environment.panelA,
      getAnchor: () => environment.anchorA,
    }),
    true
  );
  assert.notEqual(environment.primary.show, originalShow);
  assert.equal(environment.instances.length, 2);
  assert.ok(environment.panel.listenerCount("popupshown") > 0);
  assert.ok(environment.panel.listenerCount("PanelUpdated") > 0);
  assert.ok(environment.panel.listenerCount("popuphidden") > 0);
});

test("failed lazy setup is mutation-free and retries on a later activate", () => {
  const environment = createEnvironment({ includePrimary: false });
  const router = createRouter(environment);

  assert.equal(
    router.activate({
      browser: environment.panelA,
      getAnchor: () => environment.anchorA,
    }),
    false
  );
  assert.equal(environment.instances.length, 0);
  assert.equal(environment.panel.listenerCount(), 0);

  const primary = environment.installPrimary();
  const originalShow = primary.show;
  assert.equal(
    router.activate({
      browser: environment.panelA,
      getAnchor: () => environment.anchorA,
    }),
    true
  );
  assert.notEqual(primary.show, originalShow);
  assert.equal(environment.instances.length, 2);

  router.destroy();
  assert.equal(primary.show, originalShow);
});

test("missing notification chrome also retries without partial installation", () => {
  const environment = createEnvironment({ includeChromeUi: false });
  const router = createRouter(environment);
  const originalShow = environment.primary.show;

  assert.equal(
    router.activate({
      browser: environment.panelA,
      getAnchor: () => environment.anchorA,
    }),
    false
  );
  assert.equal(environment.primary.show, originalShow);
  assert.equal(environment.instances.length, 1);
  assert.equal(environment.panel.listenerCount(), 0);

  environment.installChromeUi();
  assert.equal(
    router.activate({
      browser: environment.panelA,
      getAnchor: () => environment.anchorA,
    }),
    true
  );
  assert.notEqual(environment.primary.show, originalShow);
});

test("routes only the exact active panel microphone prompt to its own owner", () => {
  const environment = createEnvironment();
  const router = createRouter(environment);
  router.activate({
    browser: environment.panelA,
    getAnchor: () => environment.anchorA,
  });
  const panelOwner = routedOwner(environment);

  const exact = permissionRequest(environment.panelA);
  const routed = environment.primary.show(...exact.args);
  assert.equal(routed.owner, panelOwner);
  assert.equal(panelOwner.showCalls.length, 1);
  assert.equal(panelOwner.showCalls[0].active, true);
  assert.equal(panelOwner.showCalls[0].visibleAnchor, environment.anchorA);
  assert.equal(environment.primary.showCalls.length, 0);

  const wrongId = permissionRequest(environment.panelA, {
    anchorID: "geolocation-notification-icon",
    id: "geolocation",
  });
  const wrongIdResult = environment.primary.show(...wrongId.args);
  assert.equal(wrongIdResult.owner, environment.primary);

  const cameraAndMicrophone = permissionRequest(environment.panelA, {
    anchorID: "webRTC-shareDevices-notification-icon",
  });
  const combinedResult = environment.primary.show(...cameraAndMicrophone.args);
  assert.equal(combinedResult.owner, environment.primary);

  const screen = permissionRequest(environment.panelA, {
    anchorID: "webRTC-shareScreen-notification-icon",
  });
  const screenResult = environment.primary.show(...screen.args);
  assert.equal(screenResult.owner, environment.primary);

  const inactive = permissionRequest(environment.panelB);
  const inactiveResult = environment.primary.show(...inactive.args);
  assert.equal(inactiveResult.owner, environment.primary);

  const normal = permissionRequest(environment.normalBrowser);
  const normalResult = environment.primary.show(...normal.args);
  assert.equal(normalResult.owner, environment.primary);
  assert.deepEqual(environment.forbiddenCalls, []);
});

test("pass-through and routed calls preserve receiver, arguments, and return identity", () => {
  const environment = createEnvironment();
  const router = createRouter(environment);
  router.activate({
    browser: environment.panelA,
    getAnchor: () => environment.anchorA,
  });
  const panelOwner = routedOwner(environment);

  const normalRequest = permissionRequest(environment.normalBrowser);
  const normalResult = environment.primary.show(...normalRequest.args);
  const nativeCall = environment.primary.showCalls.at(-1);
  assert.equal(nativeCall.receiver, environment.primary);
  assert.equal(nativeCall.notification, normalResult);
  normalRequest.args.forEach((argument, index) => {
    assert.equal(nativeCall.args[index], argument);
  });
  environment.primary.remove(normalResult, false);

  const panelRequest = permissionRequest(environment.panelA);
  const panelResult = environment.primary.show(...panelRequest.args);
  const routedCall = panelOwner.showCalls.at(-1);
  assert.equal(routedCall.receiver, panelOwner);
  assert.equal(routedCall.notification, panelResult);
  panelRequest.args.forEach((argument, index) => {
    assert.equal(routedCall.args[index], argument);
  });
  assert.equal(panelResult.mainAction, panelRequest.mainAction);
  assert.equal(panelResult.mainAction.callback, panelRequest.callbacks.main);
  assert.equal(panelResult.secondaryActions, panelRequest.secondaryActions);
  assert.equal(
    panelResult.secondaryActions[0].callback,
    panelRequest.callbacks.secondary
  );
  assert.equal(panelResult.options, panelRequest.options);
  assert.equal(panelResult.options.eventCallback, panelRequest.callbacks.event);
});

test("same-browser activation updates the live anchor without cancelling its prompt", () => {
  const environment = createEnvironment();
  const router = createRouter(environment);
  router.activate({
    browser: environment.panelA,
    getAnchor: () => environment.anchorA,
  });
  const panelOwner = routedOwner(environment);
  const pending = environment.primary.show(
    ...permissionRequest(environment.panelA).args
  );

  assert.equal(
    router.activate({
      browser: environment.panelA,
      getAnchor: () => environment.anchorB,
    }),
    true
  );
  assert.equal(
    environment.notificationsFor(environment.panelA).includes(pending),
    true
  );
  assert.deepEqual(environment.removalCalls, []);

  pending.reshow();
  assert.equal(panelOwner.reshowCalls.at(-1).visibleAnchor, environment.anchorB);
});

test("a stale or hidden rail anchor falls back to notification chrome", () => {
  const environment = createEnvironment();
  const router = createRouter(environment);
  const disconnected = {
    checkVisibility: () => true,
    id: "stale-anchor",
    isConnected: false,
    ownerDocument: environment.documentRef,
  };
  router.activate({
    browser: environment.panelA,
    getAnchor: () => disconnected,
  });
  const panelOwner = routedOwner(environment);

  environment.primary.show(...permissionRequest(environment.panelA).args);
  assert.equal(
    panelOwner.showCalls.at(-1).visibleAnchor,
    environment.iconBox
  );

  router.activate({
    browser: environment.panelA,
    getAnchor: () => {
      throw new Error("synthetic detached render");
    },
  });
  const pending = panelOwner.getNotification(
    WEBRTC_NOTIFICATION_ID,
    environment.panelA
  );
  pending.reshow();
  assert.equal(
    panelOwner.reshowCalls.at(-1).visibleAnchor,
    environment.iconBox
  );
});

test("switch and close cancel only unanswered prompts owned by the panel router", () => {
  const environment = createEnvironment();
  const router = createRouter(environment);
  const removedEvents = [];
  router.activate({
    browser: environment.panelA,
    getAnchor: () => environment.anchorA,
  });
  const panelOwner = routedOwner(environment);
  const pending = environment.primary.show(
    ...permissionRequest(environment.panelA, {
      eventCallback(...args) {
        removedEvents.push({ args, receiver: this });
      },
    }).args
  );
  const foreign = environment.seedNotification(
    environment.primary,
    environment.panelA
  );
  const unrelated = environment.seedNotification(
    panelOwner,
    environment.panelA,
    { anchorID: "geolocation-notification-icon", id: "geolocation" }
  );

  assert.equal(
    router.activate({
      browser: environment.panelB,
      getAnchor: () => environment.anchorB,
    }),
    true
  );
  assert.equal(environment.notificationsFor(environment.panelA).includes(pending), false);
  assert.equal(environment.notificationsFor(environment.panelA).includes(foreign), true);
  assert.equal(environment.notificationsFor(environment.panelA).includes(unrelated), true);
  const cancelled = environment.removalCalls.find(
    call => call.notification === pending
  );
  assert.ok(cancelled);
  assert.equal(cancelled.withoutUserResponse, true);
  assert.equal(cancelled.removedBy, panelOwner);
  assert.deepEqual(removedEvents.at(-1), {
    args: ["removed", undefined, true],
    receiver: pending,
  });

  const pendingB = environment.primary.show(
    ...permissionRequest(environment.panelB).args
  );
  router.deactivate();
  assert.equal(environment.notificationsFor(environment.panelB).includes(pendingB), false);
  assert.equal(environment.removalCalls.at(-1).notification, pendingB);
  assert.equal(environment.removalCalls.at(-1).withoutUserResponse, true);
});

test("a visible normal-tab prompt is preserved while the panel prompt queues", async () => {
  const environment = createEnvironment();
  const router = createRouter(environment);
  router.activate({
    browser: environment.panelA,
    getAnchor: () => environment.anchorA,
  });
  const normalWebRtc = environment.primary.show(
    ...permissionRequest(environment.normalBrowser).args
  );
  const normalGeolocation = environment.primary.show(
    ...permissionRequest(environment.normalBrowser, {
      anchorID: "geolocation-notification-icon",
      id: "geolocation",
    }).args
  );
  const backgroundWebRtc = environment.primary.show(
    ...permissionRequest(environment.otherNormalBrowser).args
  );

  const queued = environment.primary.show(
    ...permissionRequest(environment.panelA).args
  );

  assert.equal(
    environment.notificationsFor(environment.normalBrowser).includes(normalWebRtc),
    true
  );
  assert.equal(
    environment.notificationsFor(environment.normalBrowser).includes(normalGeolocation),
    true
  );
  assert.equal(
    environment.notificationsFor(environment.otherNormalBrowser).includes(backgroundWebRtc),
    true
  );
  assert.equal(
    environment.notificationsFor(environment.panelA).includes(queued),
    true
  );
  assert.equal(queued.owner, environment.primary);

  environment.primary.remove(normalGeolocation, false);
  environment.primary.remove(normalWebRtc, false);
  await new Promise(resolve => setTimeout(resolve, 0));

  const panelOwner = routedOwner(environment);
  assert.equal(queued.owner, panelOwner);
  assert.equal(panelOwner.reshowCalls.at(-1).notification, queued);
  assert.equal(
    panelOwner.reshowCalls.at(-1).visibleAnchor,
    environment.anchorA
  );
});

test("foreign shared-panel updates and panel hiding cancel only the routed prompt", () => {
  for (const eventType of ["popupshown", "PanelUpdated", "popuphidden"]) {
    const environment = createEnvironment();
    const router = createRouter(environment);
    router.activate({
      browser: environment.panelA,
      getAnchor: () => environment.anchorA,
    });
    const panelOwner = routedOwner(environment);
    const routed = environment.primary.show(
      ...permissionRequest(environment.panelA).args
    );
    const foreign = environment.seedNotification(
      environment.primary,
      environment.panelA,
      { anchorID: "geolocation-notification-icon", id: "geolocation" }
    );

    if (eventType !== "popuphidden") {
      environment.panel.firstElementChild = { notification: foreign };
    }
    environment.panel.dispatch(eventType);

    assert.equal(
      environment.notificationsFor(environment.panelA).includes(routed),
      false,
      `${eventType} cancels the panel-owned prompt`
    );
    assert.equal(
      environment.notificationsFor(environment.panelA).includes(foreign),
      true,
      `${eventType} preserves the foreign notification`
    );
    const removal = environment.removalCalls.find(
      call => call.notification === routed
    );
    assert.ok(removal);
    assert.equal(removal.removedBy, panelOwner);
    assert.equal(removal.withoutUserResponse, true);
    router.destroy();
  }
});

test("accepted capture continues across panel close and switch", () => {
  const environment = createEnvironment();
  const router = createRouter(environment);
  let stopCalls = 0;
  environment.panelA.activeCapture = {
    getTracks() {
      return [{
        stop() {
          stopCalls += 1;
          throw new Error("Accepted capture must continue in the background.");
        },
      }];
    },
  };
  router.activate({
    browser: environment.panelA,
    getAnchor: () => environment.anchorA,
  });
  const panelOwner = routedOwner(environment);
  const prompt = environment.primary.show(
    ...permissionRequest(environment.panelA).args
  );

  panelOwner.remove(prompt, false);
  const removalsAfterAcceptance = environment.removalCalls.length;
  environment.panel.dispatch("popuphidden");
  router.activate({
    browser: environment.panelB,
    getAnchor: () => environment.anchorB,
  });
  router.deactivate();

  assert.equal(stopCalls, 0);
  assert.equal(environment.removalCalls.length, removalsAfterAcceptance);
  assert.ok(environment.panelA.activeCapture);
  assert.deepEqual(environment.forbiddenCalls, []);
});

test("destroy cancels pending work, removes listeners, and restores inherited show", () => {
  const environment = createEnvironment();
  const originalShow = environment.primary.show;
  assert.equal(Object.hasOwn(environment.primary, "show"), false);
  const router = createRouter(environment);
  router.activate({
    browser: environment.panelA,
    getAnchor: () => environment.anchorA,
  });
  const pending = environment.primary.show(
    ...permissionRequest(environment.panelA).args
  );
  assert.equal(Object.hasOwn(environment.primary, "show"), true);
  assert.ok(environment.panel.listenerCount() > 0);

  router.destroy();
  router.destroy();

  assert.equal(environment.notificationsFor(environment.panelA).includes(pending), false);
  assert.equal(environment.removalCalls.at(-1).notification, pending);
  assert.equal(environment.removalCalls.at(-1).withoutUserResponse, true);
  assert.equal(Object.hasOwn(environment.primary, "show"), false);
  assert.equal(environment.primary.show, originalShow);
  assert.equal(environment.panel.listenerCount(), 0);
  assert.equal(environment.windowRef.listenerCount(), 0);
  assert.equal(environment.windowRef.gBrowser.tabContainer.listenerCount(), 0);
});

test("destroy does not overwrite a wrapper installed later by another feature", () => {
  const environment = createEnvironment();
  const router = createRouter(environment);
  router.activate({
    browser: environment.panelA,
    getAnchor: () => environment.anchorA,
  });
  const routerWrapper = environment.primary.show;
  function laterWrapper(...args) {
    return routerWrapper.apply(this, args);
  }
  environment.primary.show = laterWrapper;

  router.destroy();

  assert.equal(environment.primary.show, laterWrapper);
  assert.equal(environment.panel.listenerCount(), 0);
});

test("twenty-five route, switch, and close cycles keep ownership isolated", () => {
  const environment = createEnvironment();
  const router = createRouter(environment);
  const originalShow = environment.primary.show;

  for (let cycle = 0; cycle < 25; cycle += 1) {
    const activeBrowser = cycle % 2 === 0
      ? environment.panelA
      : environment.panelB;
    const nextBrowser = cycle % 2 === 0
      ? environment.panelB
      : environment.panelA;
    const activeAnchor = cycle % 2 === 0
      ? environment.anchorA
      : environment.anchorB;
    const nextAnchor = cycle % 2 === 0
      ? environment.anchorB
      : environment.anchorA;
    assert.equal(
      router.activate({ browser: activeBrowser, getAnchor: () => activeAnchor }),
      true
    );
    const panelOwner = routedOwner(environment);
    const routed = environment.primary.show(
      ...permissionRequest(activeBrowser, {
        message: { cycle, source: "panel" },
      }).args
    );
    assert.equal(routed.owner, panelOwner);
    assert.equal(panelOwner.showCalls.at(-1).visibleAnchor, activeAnchor);

    const normal = environment.primary.show(
      ...permissionRequest(environment.normalBrowser, {
        anchorID: "geolocation-notification-icon",
        id: `normal-${cycle}`,
        message: { cycle, source: "normal" },
      }).args
    );
    assert.equal(normal.owner, environment.primary);

    assert.equal(
      router.activate({ browser: nextBrowser, getAnchor: () => nextAnchor }),
      true
    );
    assert.equal(environment.notificationsFor(activeBrowser).includes(routed), false);
    assert.equal(
      environment.notificationsFor(environment.normalBrowser).includes(normal),
      true
    );
    const removal = environment.removalCalls.find(
      call => call.notification === routed
    );
    assert.ok(removal, `cycle ${cycle} cancels its panel prompt`);
    assert.equal(removal.owner, panelOwner);
    assert.equal(removal.withoutUserResponse, true);
    assert.equal(environment.windowRef.gBrowser.selectedBrowser, environment.normalBrowser);
    assert.equal(environment.windowRef.gBrowser.selectedTab, environment.selectedTab);
    environment.primary.remove(normal, false);
  }

  router.deactivate();
  router.destroy();
  assert.equal(environment.primary.show, originalShow);
  assert.deepEqual(environment.forbiddenCalls, []);
});
