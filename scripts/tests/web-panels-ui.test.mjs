import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../web-panels.uc.mjs", import.meta.url), "utf8");
const runtime = await readFile(
  new URL("../web-panels-runtime.uc.mjs", import.meta.url),
  "utf8"
);
const permissions = await readFile(
  new URL("../web-panels-permissions.uc.mjs", import.meta.url),
  "utf8"
);
const styles = await readFile(new URL("../web-panels.css", import.meta.url), "utf8");
const validator = await readFile(
  new URL("../validate-package.mjs", import.meta.url),
  "utf8"
);
const {
  calculateWebPanelViewportGeometry,
  clampWebPanelWidth,
  configureWebPanelContextNavigation,
  routeWebPanelNavigationCommand,
} = await import(new URL("../web-panels.uc.mjs", import.meta.url));

class MockMenuItem {
  #attributes = new Map();

  constructor(attributes = {}) {
    for (const [name, value] of Object.entries(attributes)) {
      this.#attributes.set(name, String(value));
    }
  }

  getAttribute(name) {
    return this.#attributes.get(name) ?? "";
  }

  hasAttribute(name) {
    return this.#attributes.has(name);
  }

  removeAttribute(name) {
    this.#attributes.delete(name);
  }

  setAttribute(name, value) {
    this.#attributes.set(name, String(value));
  }

  toggleAttribute(name, force) {
    if (force) {
      this.#attributes.set(name, "true");
    } else {
      this.#attributes.delete(name);
    }
  }
}

function contextNavigationDocument() {
  const items = new Map([
    ["context-back", new MockMenuItem({ command: "Browser:BackOrBackDuplicate" })],
    ["context-forward", new MockMenuItem({ command: "Browser:ForwardOrForwardDuplicate" })],
    ["context-reload", new MockMenuItem({ command: "Browser:ReloadOrDuplicate", hidden: "true" })],
    ["context-stop", new MockMenuItem({ command: "Browser:Stop", disabled: "true" })],
  ]);
  return {
    getElementById(id) {
      return items.get(id) ?? null;
    },
    items,
  };
}

function privateMethodSource(name) {
  const marker = `  #${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `Expected ${marker} in the controller source.`);
  const next = source.indexOf("\n  #", start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

test("package validator runs the regression suite", () => {
  assert.match(validator, /spawnSync\(process\.execPath, \["--test",/);
  assert.match(validator, /web-panels-runtime\.test\.mjs/);
  assert.match(validator, /web-panels-permissions\.test\.mjs/);
  assert.match(validator, /web-panels-security\.test\.mjs/);
  assert.match(validator, /web-panels-ui\.test\.mjs/);
  assert.match(validator, /web-panels-css\.test\.mjs/);
});

test("centers panel geometry within the central page viewport", () => {
  assert.deepEqual(
    calculateWebPanelViewportGeometry({ top: 64, width: 1200, height: 800 }),
    {
      top: 72,
      height: 784,
      maxWidth: 1140,
    }
  );
  assert.equal(clampWebPanelWidth(1200, 1140), 1140);
  assert.equal(clampWebPanelWidth(420, 1140), 420);
  assert.equal(clampWebPanelWidth(100, 1140), 320);
  assert.equal(clampWebPanelWidth(420, 280), 280);
  assert.deepEqual(
    calculateWebPanelViewportGeometry(
      { top: -8, left: 240, width: 1027, height: 784 },
      { top: 0, left: 0, width: 1259, height: 768 }
    ),
    {
      top: 8,
      height: 752,
      maxWidth: 968,
    }
  );
});

test("tracks the selected page viewport without moving panel browsers", () => {
  assert.match(
    source,
    /const runtimeUserBrowser = this\.#runtime\?\.getUserBrowser\?\.\(\);[\s\S]*?runtimeUserBrowser\?\.getBoundingClientRect/
  );
  assert.match(runtime, /getUserBrowser\(\) \{\s*return this\.#currentUserTab\(\)\?\.linkedBrowser \?\? null;/s);
  assert.match(source, /gBrowser\?\.visibleTabs\?\.includes\(selectedTab\)/);
  assert.match(source, /getElementById\("zen-tabbox-wrapper"\)/);
  assert.match(
    source,
    /const fallbackViewport = \{\s*top: 0,\s*left: 0,\s*width:/s
  );
  assert.match(source, /new this\.window\.ResizeObserver\([\s\S]*?this\.#onPageViewportResize/);
  assert.match(source, /"TabSelect",\s*this\.#onPageViewportChange/);
  assert.match(
    source,
    /--sine-web-panels-viewport-top[\s\S]*?--sine-web-panels-viewport-height[\s\S]*?--sine-web-panels-max-width/
  );
  const resizeStart = source.indexOf("#onWindowResize = () => {");
  const resizeEnd = source.indexOf("};", resizeStart) + 2;
  const resizeSource = source.slice(resizeStart, resizeEnd);
  assert.doesNotMatch(resizeSource, /this\.#store\.width\s*=/);
});

test("panel item menu exposes reload and targets the managed panel browser", () => {
  assert.match(source, /\["Reload Web Panel", \(\) => this\.#reloadPanel\(item\)\]/);
  assert.match(source, /const browser = this\.#runtime\.getBrowser\(item\);/);
  assert.match(source, /browser\.reload\(\);/);
});

test("opening a panel URL in a tab immediately detaches the source panel", () => {
  const openSource = privateMethodSource("openInNewTab(");
  const trustedOpenIndex = openSource.indexOf(
    'this.window.openTrustedLinkIn(safeUrl, "tab"'
  );
  const fallbackOpenIndex = openSource.indexOf(
    "this.window.gBrowser?.addTrustedTab?.(safeUrl"
  );
  const closeIndex = openSource.lastIndexOf(
    "this.#closePanel({ animate: false });"
  );

  assert.ok(trustedOpenIndex >= 0);
  assert.ok(fallbackOpenIndex > trustedOpenIndex);
  assert.ok(closeIndex > fallbackOpenIndex);
  assert.match(openSource, /if \(!opened\) \{\s*return false;\s*\}/s);
  assert.match(openSource, /this\.#closePanel\(\{ animate: false \}\);\s*return true;/s);
  assert.doesNotMatch(openSource, /this\.#closePanel\(\);/);
});

test("panel item menu routes reset and replace-current without lifecycle fallbacks", () => {
  const menuSource = privateMethodSource("openItemMenu(event, item)");
  const resetSource = privateMethodSource("resetPanel(");
  const replaceSource = privateMethodSource("replacePanelUrlWithCurrent(");

  assert.match(
    menuSource,
    /\["Reset Web Panel", \(\) => this\.#resetPanel\(item\)\]/
  );
  assert.match(
    menuSource,
    /\["Replace with Current URL", \(\) => this\.#replacePanelUrlWithCurrent\(item\)(?:,\s*[^\]]+)?\]/
  );
  const savedItemIndex = resetSource.indexOf("this.#store.items.find(");
  const resetRuntimeIndex = resetSource.indexOf("this.#runtime.resetPanel(");
  assert.ok(savedItemIndex >= 0);
  assert.ok(resetRuntimeIndex > savedItemIndex);
  assert.match(
    resetSource,
    /this\.#runtime\.resetPanel\(currentItem, expectedBrowser\)/
  );
  assert.doesNotMatch(resetSource, /\.(?:attach|reload|unload)\s*\(/);

  const currentItemIndex = replaceSource.indexOf("this.#store.items.find(");
  const getBrowserIndex = replaceSource.indexOf(
    "this.#runtime.getBrowser(currentItem)"
  );
  const normalizeIndex = replaceSource.indexOf("normalizeWebPanelUrl(");
  const updateIndex = replaceSource.indexOf("this.#store.updatePanel(");
  const adoptIndex = replaceSource.indexOf("this.#runtime.adoptCurrentUrl(");
  assert.ok(currentItemIndex >= 0);
  assert.ok(getBrowserIndex > currentItemIndex);
  assert.ok(normalizeIndex > getBrowserIndex);
  assert.ok(updateIndex > normalizeIndex);
  assert.ok(adoptIndex > updateIndex);
  assert.match(
    replaceSource,
    /normalizeWebPanelUrl\(browser\?\.currentURI\?\.spec\)/
  );
  assert.match(
    replaceSource,
    /this\.#runtime\.adoptCurrentUrl\(updated, browser\)/
  );
  assert.match(
    replaceSource,
    /this\.#store\.replacePanel\(currentItem\)/
  );
  assert.doesNotMatch(replaceSource, /\.(?:attach|reload|unload)\s*\(/);
});

test("panel content consumes clicks while the backdrop remains the close target", () => {
  assert.match(
    source,
    /this\.#backdrop\.addEventListener\("click", \(\) => this\.#closePanel\(\)/
  );
  assert.match(
    source,
    /this\.#surfaceShell\.addEventListener\("click", event => event\.stopPropagation\(\)/
  );
});

test("panel context navigation follows the panel state and restores native menu attributes", () => {
  const documentRef = contextNavigationDocument();
  const restore = configureWebPanelContextNavigation(documentRef, {
    canGoBack: true,
    canGoForward: false,
    webProgress: { isLoadingDocument: true },
  }, {
    hasAttribute: name => name === "busy",
  });

  for (const id of ["context-back", "context-forward", "context-reload", "context-stop"]) {
    assert.equal(documentRef.items.get(id).hasAttribute("command"), false);
  }
  assert.equal(documentRef.items.get("context-back").hasAttribute("disabled"), false);
  assert.equal(documentRef.items.get("context-forward").hasAttribute("disabled"), true);
  assert.equal(documentRef.items.get("context-reload").hasAttribute("hidden"), true);
  assert.equal(documentRef.items.get("context-stop").hasAttribute("hidden"), false);
  assert.equal(documentRef.items.get("context-stop").hasAttribute("disabled"), false);

  restore();
  restore();
  assert.equal(
    documentRef.items.get("context-back").getAttribute("command"),
    "Browser:BackOrBackDuplicate"
  );
  assert.equal(
    documentRef.items.get("context-forward").getAttribute("command"),
    "Browser:ForwardOrForwardDuplicate"
  );
  assert.equal(
    documentRef.items.get("context-reload").getAttribute("command"),
    "Browser:ReloadOrDuplicate"
  );
  assert.equal(
    documentRef.items.get("context-stop").getAttribute("command"),
    "Browser:Stop"
  );
  assert.equal(documentRef.items.get("context-back").hasAttribute("disabled"), false);
  assert.equal(documentRef.items.get("context-forward").hasAttribute("disabled"), false);
  assert.equal(documentRef.items.get("context-reload").hasAttribute("hidden"), true);
  assert.equal(documentRef.items.get("context-reload").hasAttribute("disabled"), false);
  assert.equal(documentRef.items.get("context-stop").hasAttribute("hidden"), false);
  assert.equal(documentRef.items.get("context-stop").hasAttribute("disabled"), true);
});

test("panel navigation commands never operate on the selected background browser", () => {
  const calls = [];
  const panelTab = { id: "panel-tab" };
  const panelBrowser = {
    canGoBack: true,
    canGoForward: true,
    goBack: requireUserInteraction => calls.push(["back", requireUserInteraction]),
    goForward: requireUserInteraction => calls.push(["forward", requireUserInteraction]),
    reloadWithFlags: flags => calls.push(["reload", flags]),
    stop: () => calls.push(["stop"]),
  };
  const options = {
    browser: panelBrowser,
    tab: panelTab,
    event: {},
    navigationFlags: {
      none: 0,
      bypassProxy: 1,
      bypassCache: 2,
    },
  };

  assert.equal(routeWebPanelNavigationCommand("context-back", options), true);
  assert.equal(routeWebPanelNavigationCommand("context-forward", options), true);
  assert.equal(routeWebPanelNavigationCommand("context-reload", options), true);
  assert.equal(routeWebPanelNavigationCommand("context-stop", options), true);
  assert.equal(
    routeWebPanelNavigationCommand("context-not-owned", options),
    false
  );
  assert.deepEqual(calls, [
    ["back", false],
    ["forward", false],
    ["reload", 0],
    ["stop"],
  ]);

  routeWebPanelNavigationCommand("context-reload", {
    ...options,
    event: { shiftKey: true },
  });
  assert.deepEqual(calls.at(-1), ["reload", 3]);

  routeWebPanelNavigationCommand("context-reload", {
    ...options,
    browser: {
      ...panelBrowser,
      currentURI: { schemeIs: scheme => scheme === "view-source" },
    },
  });
  assert.deepEqual(calls.at(-1), ["reload", 3]);
});

test("native content context routing is scoped to the exact active panel and fails closed", () => {
  assert.match(
    source,
    /getElementById\(CONTENT_CONTEXT_MENU_ID\)[\s\S]*?"popupshowing",\s*this\.#onContentContextMenuShowing/
  );
  assert.match(
    source,
    /"command",\s*this\.#onContentContextMenuCommand,[\s\S]*?capture:\s*true/
  );
  assert.match(
    source,
    /contextMenu\?\.browser !== browser[\s\S]*?const tab = this\.window\.gBrowser\?\.getTabForBrowser\?\.\(browser\);[\s\S]*?tab\.linkedBrowser !== browser/
  );
  assert.match(
    source,
    /#hideContentContextMenu\(\);[\s\S]*?#runtime\.attach\(item\)/
  );
  assert.match(source, /#hideContentContextMenu\(\);[\s\S]*?#activeId = null;/);
  assert.match(
    source,
    /#patchPanelContextMethod\(state, "openLinkInCurrent"[\s\S]*?targetBrowser:\s*browser/
  );
  assert.match(
    source,
    /#patchPanelContextMethod\(state, "showOnlyThisFrame"[\s\S]*?targetBrowser:\s*browser/
  );
  assert.match(source, /DevToolsShim\.inspectNode\(tab, contextMenu\.targetIdentifier\)/);
  assert.match(
    source,
    /getElementById\("context-take-screenshot"\)[\s\S]*?screenshot\.setAttribute\("hidden", "true"\)/
  );
  assert.match(
    source,
    /#patchSendPageToDevice\(state\)[\s\S]*?originalMethod\.call\([\s\S]*?state\.browser\.currentURI,[\s\S]*?state\.browser\.contentTitle/
  );
  assert.doesNotMatch(source, /ScreenshotsUtils\.start\(browser, "ContextMenu"\)/);
  assert.doesNotMatch(source, /gBrowser\.selectedTab\s*=\s*state\.tab/);
  assert.doesNotMatch(source, /showTab\(state\.tab/);
  assert.doesNotMatch(source, /duplicateTabIn\(state\.tab/);
});

test("panel surface exposes Reset only and routes it through exact context identity", () => {
  const mountSource = privateMethodSource("mountContentContextMenu()");
  const showingSource = privateMethodSource("onContentContextMenuShowing");
  const resetCommandSource = privateMethodSource("onResetPanelFromContentMenu");
  const resetStateSource = privateMethodSource("resetContentContextState()");

  assert.match(
    mountSource,
    /this\.#xul\("menuitem", \{[\s\S]*?id:\s*CONTENT_RESET_MENU_ITEM_ID,[\s\S]*?label:\s*"Reset Web Panel"/
  );
  assert.doesNotMatch(mountSource, /Replace with Current URL/);
  assert.match(
    mountSource,
    /addEventListener\("command", this\.#onResetPanelFromContentMenu/
  );
  const resetStateIndex = showingSource.indexOf("this.#resetContentContextState()");
  const targetIndex = showingSource.indexOf("this.#activeContentContextTarget(");
  const showResetIndex = showingSource.indexOf(
    'this.#contentResetMenuItem?.removeAttribute("hidden")'
  );
  assert.ok(resetStateIndex >= 0);
  assert.ok(targetIndex > resetStateIndex);
  assert.ok(showResetIndex > targetIndex);
  assert.match(
    resetStateSource,
    /this\.#contentResetMenuItem\?\.setAttribute\("hidden", "true"\);/
  );

  const contextStateIndex = resetCommandSource.indexOf(
    "const state = this.#panelContextState;"
  );
  const validationIndex = resetCommandSource.indexOf(
    "this.#isContentContextStateValid(state)"
  );
  const itemIndex = resetCommandSource.indexOf("this.#items.find(");
  const resetIndex = resetCommandSource.indexOf(
    "this.#resetPanel(item, state.browser)"
  );
  assert.ok(contextStateIndex >= 0);
  assert.ok(validationIndex > contextStateIndex);
  assert.ok(itemIndex > validationIndex);
  assert.ok(resetIndex > itemIndex);
  assert.doesNotMatch(resetCommandSource, /replacePanelUrlWithCurrent/);
});

test("context routing restores Firefox state before mod teardown", () => {
  const destroyStart = source.indexOf("  destroy() {");
  const destroyEnd = source.indexOf("  #mount() {", destroyStart);
  const destroySource = source.slice(destroyStart, destroyEnd);
  const hideIndex = destroySource.indexOf("this.#hideContentContextMenu();");
  const abortIndex = destroySource.indexOf("this.#abortController.abort();");

  assert.ok(hideIndex >= 0);
  assert.ok(abortIndex > hideIndex);
  assert.match(
    source,
    /state\.restoreNavigation\?\.\(\);[\s\S]*?Object\.defineProperty\(state\.contextMenu, name, originalDescriptor\)[\s\S]*?delete state\.contextMenu\[name\]/
  );
  assert.match(
    source,
    /state\.itemAttributeSnapshots\.reverse\(\)[\s\S]*?restoreAttribute\(snapshot\)/
  );
  assert.match(
    source,
    /state\.externalMethodDescriptors\.reverse\(\)[\s\S]*?Object\.defineProperty\(target, name, originalDescriptor\)[\s\S]*?delete target\[name\]/
  );
  assert.match(
    source,
    /event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);[\s\S]*?if \(!this\.#isContentContextStateValid\(state\)\)/
  );
  assert.match(source, /queueMicrotaskRef\(\(\) => this\.#hideContentContextMenu\(\)\);/);
});

test("panel surface Reset command is removed during teardown and reinitialization", () => {
  const destroyExistingStart = source.indexOf("  destroyExistingRoot() {");
  const destroyStart = source.indexOf("  destroy() {", destroyExistingStart);
  const mountStart = source.indexOf("  #mount() {", destroyStart);
  assert.ok(destroyExistingStart >= 0);
  assert.ok(destroyStart > destroyExistingStart);
  assert.ok(mountStart > destroyStart);
  const destroyExistingSource = source.slice(destroyExistingStart, destroyStart);
  const destroySource = source.slice(destroyStart, mountStart);

  assert.match(
    destroyExistingSource,
    /getElementById\(CONTENT_RESET_MENU_ITEM_ID\)\?\.remove\(\)/
  );
  assert.match(destroySource, /this\.#contentResetMenuItem\?\.remove\(\);/);
  assert.match(destroySource, /this\.#contentResetMenuItem = null;/);
});

test("bookmark targeting uses panel data without shadowing selected browser state", () => {
  assert.match(
    source,
    /#patchPanelContextMethod\(state, "bookmarkThisPage"[\s\S]*?PlacesCommandHook\.bookmarkLink\([\s\S]*?browser\.contentTitle \|\| url/
  );
  assert.doesNotMatch(
    source,
    /Object\.defineProperty\(tabBrowser, "selectedBrowser"/
  );
});

test("resize keeps pointer capture while crossing remote panel content", () => {
  assert.match(source, /resizer\.addEventListener\("pointerdown", this\.#onResizeStart/);
  assert.match(source, /this\.window\.addEventListener\("pointercancel", this\.#onPointerUp/);
  assert.match(
    source,
    /captureTarget:\s*event\.currentTarget,[\s\S]*?pointerId:\s*event\.pointerId,[\s\S]*?event\.currentTarget\.setPointerCapture\?\.\(event\.pointerId\);/
  );
  assert.match(
    source,
    /resize\.captureTarget\?\.hasPointerCapture\?\.\(resize\.pointerId\)[\s\S]*?resize\.captureTarget\.releasePointerCapture\(resize\.pointerId\);/
  );
  assert.match(
    styles,
    /#browser:has\(#sine-web-panels-root\[resizing\]\)[^{]*\.browserSidebarContainer\.sine-web-panel-native-overlay[^{]*\.browserContainer\s*\{[^}]*pointer-events:\s*none\s*!important;/s
  );
});

test("drag and resize ignore unrelated pointers and cancel reordering safely", () => {
  assert.match(
    source,
    /#onItemPointerDown\(event, item\) \{\s*if \(event\.button !== 0 \|\| this\.#dragState \|\| this\.#resizeState\) \{/s
  );
  assert.match(
    source,
    /startY:\s*event\.clientY,\s*pointerId:\s*event\.pointerId,\s*dragging:/s
  );
  assert.match(
    source,
    /if \(event\.pointerId !== this\.#resizeState\.pointerId\) \{\s*return;\s*\}[\s\S]*?if \(!this\.#dragState \|\| event\.pointerId !== this\.#dragState\.pointerId\) \{/s
  );
  assert.match(
    source,
    /if \(drag\.dragging && event\.type !== "pointercancel"\) \{/s
  );
  assert.match(
    source,
    /#onResizeStart = event => \{\s*if \(this\.#resizeState \|\| this\.#dragState\) \{/s
  );
});

test("normal close keeps the browser presented through the existing animation", () => {
  const closeStart = source.indexOf("#closePanel({ animate = true } = {}) {");
  const closeEnd = source.indexOf("#bindBrowserTitle", closeStart);
  const closeSource = source.slice(closeStart, closeEnd);
  const timeoutStart = closeSource.indexOf("this.window.setTimeout");
  const detachIndex = closeSource.indexOf("this.#runtime?.detach();", timeoutStart);

  assert.ok(closeStart >= 0);
  assert.ok(timeoutStart >= 0);
  assert.ok(detachIndex > timeoutStart);
  assert.match(
    closeSource,
    /if \(!this\.#activeId\) \{\s*this\.#runtime\?\.detach\(\);\s*this\.#surfaceShell\.hidden = true;/s
  );
  assert.match(
    closeSource,
    /\} else \{\s*this\.#runtime\?\.detach\(\);\s*this\.#surfaceShell\.hidden = true;/s
  );
  assert.match(closeSource, /this\.#clearCloseTransitionTimer\(\);/);
  assert.match(
    closeSource,
    /this\.#closeTransitionTimer = this\.window\.setTimeout\(\(\) => \{\s*this\.#closeTransitionTimer = null;/s
  );
});

test("rapid reopen removes closing styles before layout and preserves failed-close finalization", () => {
  const openStart = source.indexOf("#openPanel(item) {");
  const openEnd = source.indexOf("#closePanel", openStart);
  const openSource = source.slice(openStart, openEnd);
  const removeClosingIndex = openSource.indexOf('this.#root.removeAttribute("closing");');
  const attachIndex = openSource.indexOf("this.#runtime.attach(item);");
  const clearCloseTimerIndex = openSource.indexOf("this.#clearCloseTransitionTimer();");

  assert.ok(openStart >= 0);
  assert.ok(removeClosingIndex >= 0);
  assert.ok(attachIndex > removeClosingIndex);
  assert.ok(clearCloseTimerIndex > attachIndex);
  assert.match(
    openSource,
    /const wasClosing = this\.#root\.hasAttribute\("closing"\);[\s\S]*?if \(wasClosing\) \{\s*this\.#root\.removeAttribute\("closing"\);\s*\}[\s\S]*?const browser = this\.#runtime\.attach\(item\);/s
  );
  assert.match(
    openSource,
    /if \(!browser\) \{[\s\S]*?if \(wasClosing\) \{\s*this\.#root\.setAttribute\("closing", "true"\);\s*\}[\s\S]*?return;\s*\}\s*this\.#clearCloseTransitionTimer\(\);/s
  );
});

test("external backing-tab invalidation closes only the matching active panel", () => {
  assert.match(source, /WEB_PANEL_RUNTIME_INVALIDATED_EVENT/);
  assert.match(
    source,
    /if \(event\.detail\?\.panelId === this\.#activeId\) \{\s*this\.#closePanel\(\{ animate: false \}\);/s
  );
});

test("module reinitialization destroys the previous singleton before mounting", () => {
  assert.match(source, /const MODULE_VERSION = new URL\(import\.meta\.url\)\.search;/);
  assert.match(
    source,
    /await import\(`\.\/web-panels-runtime\.uc\.mjs\$\{MODULE_VERSION\}`\)/
  );
  assert.match(
    source,
    /await import\(`\.\/web-panels-store\.uc\.mjs\$\{MODULE_VERSION\}`\)/
  );
  assert.match(runtime, /const MODULE_VERSION = new URL\(import\.meta\.url\)\.search;/);
  assert.match(
    runtime,
    /await import\(\s*`\.\/web-panels-store\.uc\.mjs\$\{MODULE_VERSION\}`\s*\)/
  );
  assert.doesNotMatch(
    runtime,
    /^import\s+\{\s*normalizeWebPanelUrl\s*\}\s+from\s+"\.\/web-panels-store\.uc\.mjs";/m
  );
  assert.match(source, /const INSTANCE_KEY = "__sineWebPanelsInstance";/);
  assert.match(
    source,
    /window\[INSTANCE_KEY\]\?\.destroy\?\.\(\);\s*const instance = new SineWebPanels\(window\);/s
  );
  assert.match(source, /window\[INSTANCE_KEY\] = instance;/);
  assert.match(
    source,
    /if \(window\[INSTANCE_KEY\] !== instance\) \{\s*return;\s*\}/s
  );
});

test("microphone permission routing follows panel lifecycle without selecting backing tabs", () => {
  const initStart = source.indexOf("  init() {");
  const initEnd = source.indexOf("  destroyExistingRoot() {", initStart);
  const initSource = source.slice(initStart, initEnd);
  const openSource = privateMethodSource("openPanel(item)");
  const closeSource = privateMethodSource("closePanel({ animate = true } = {})");
  const destroyStart = source.indexOf("  destroy() {");
  const destroyEnd = source.indexOf("  #mount() {", destroyStart);
  const destroySource = source.slice(destroyStart, destroyEnd);

  assert.match(
    source,
    /await import\(\s*`\.\/web-panels-permissions\.uc\.mjs\$\{MODULE_VERSION\}`\s*\)/
  );
  assert.ok(
    initSource.indexOf("new WebPanelsRuntime") <
      initSource.indexOf("new WebPanelPermissionRouter")
  );
  assert.ok(
    openSource.indexOf("this.#render();") <
      openSource.indexOf("this.#permissions?.activate({")
  );
  assert.match(
    openSource,
    /activate\(\{\s*browser,\s*getAnchor: \(\) => this\.#findItemElement\(item\.id\),\s*\}\)/s
  );
  assert.ok(
    closeSource.indexOf("this.#permissions?.deactivate();") <
      closeSource.indexOf("this.#activeId = null;")
  );
  assert.ok(
    destroySource.indexOf("this.#permissions?.destroy();") <
      destroySource.indexOf("this.#runtime?.destroy();")
  );
  assert.match(permissions, /new PopupNotificationsClass\(/);
  assert.match(
    permissions,
    /anchorId === WEBRTC_MICROPHONE_ANCHOR_ID/
  );
  assert.doesNotMatch(permissions, /gBrowser\.selected(?:Browser|Tab)\s*=/);
  assert.doesNotMatch(permissions, /\.showTab\s*\(/);
  assert.doesNotMatch(permissions, /Services\.perms|SitePermissions/);
  assert.doesNotMatch(
    permissions,
    /Object\.defineProperty\([^)]*,\s*"_isActiveBrowser"/
  );
});

test("render and animation completion resynchronize native geometry", () => {
  const renderStart = source.indexOf("#render() {");
  const renderEnd = source.indexOf("#renderPanelButton(item, index) {", renderStart);
  const renderSource = source.slice(renderStart, renderEnd);
  const timerStart = source.indexOf("this.#openTransitionTimer = this.window.setTimeout");
  const timerEnd = source.indexOf("}, 90);", timerStart);
  const timerSource = source.slice(timerStart, timerEnd);

  assert.match(
    renderSource,
    /this\.#root\.setAttribute\("side", this\.#placementSide\(\)\);[\s\S]*?this\.#syncChromeLayout\(\);[\s\S]*?this\.#runtime\?\.syncGeometry\(\);/s
  );
  assert.match(
    timerSource,
    /this\.#root\?\.removeAttribute\("opening"\);\s*this\.#runtime\?\.syncGeometry\(\);/s
  );
});

test("only the active native panel can render or receive pointer input", () => {
  assert.match(
    styles,
    /\.sine-web-panels-browser\s*\{[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none;/s
  );
  assert.match(
    styles,
    /#browser:has\(#sine-web-panels-root\[open\]\)[^{]*\.sine-web-panels-browser\[sine-web-panel-active\],[^{]*#browser:has\(#sine-web-panels-root\[closing\]\)[^{]*\.sine-web-panels-browser\[sine-web-panel-active\]\s*\{[^}]*visibility:\s*visible;/s
  );
  assert.match(
    styles,
    /\.browserSidebarContainer\[sine-web-panel-container="true"\]\s*\{[^}]*visibility:\s*hidden\s*!important;[^}]*pointer-events:\s*none;/s
  );
  assert.match(
    styles,
    /#browser:has\(#sine-web-panels-root\[open\]\)[^{]*\.browserSidebarContainer\.sine-web-panel-native-overlay[^{]*\.browserContainer\s*\{[^}]*pointer-events:\s*auto\s*!important;/s
  );
});

test("switching panel content suppresses shell and native-browser animation", () => {
  assert.match(source, /this\.#root\.toggleAttribute\("switching", switching\);/);
  assert.match(source, /this\.#root\.toggleAttribute\("opening", !switching\);/);
  assert.match(source, /this\.#clearOpenTransitionTimer\(\);/);
  assert.match(
    styles,
    /#sine-web-panels-root\[switching\] #sine-web-panels-shell,[^{]*\{\s*animation:\s*none;/s
  );
  assert.match(
    styles,
    /#browser:has\(#sine-web-panels-root\[switching\]\)[^{]*\.browserSidebarContainer\.sine-web-panel-native-overlay[^{]*\.browserContainer,[^{]*#browser:has\(#sine-web-panels-root\[resizing\]\)[^{]*\{\s*animation:\s*none;/s
  );
  assert.match(
    styles,
    /#browser:has\(#sine-web-panels-root\[opening\]\[side="right"\]\)[^{]*\.browserSidebarContainer\.sine-web-panel-native-overlay/s
  );
  assert.doesNotMatch(
    styles,
    /#browser:has\(#sine-web-panels-root\[side="right"\]\)[^{]*\.browserSidebarContainer\.sine-web-panel-native-overlay/s
  );
});

test("native extension identity uses supported tabs without browser reparenting or Glance", () => {
  assert.match(runtime, /this\.#gBrowser\.addWebTab\(item\.url,/);
  assert.match(runtime, /createLazyBrowser:\s*false/);
  assert.match(runtime, /inBackground:\s*true/);
  assert.match(runtime, /this\.#gBrowser\.getTabForBrowser\?\.\(browser\) !== tab/);
  assert.match(runtime, /this\.#gBrowser\.hideTab\(tab, TAB_HIDE_OWNER\);/);
  assert.doesNotMatch(runtime, /append(?:Child)?\(browser\)/);
  assert.doesNotMatch(runtime, /gZenGlanceManager|openGlance/);
  assert.doesNotMatch(runtime, /\.linkedBrowser\s*=(?!=)/);
  assert.doesNotMatch(runtime, /_tabForBrowser|TabTracker|permanentKey/);
});
