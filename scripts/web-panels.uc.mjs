import { WebPanelsRuntime } from "./web-panels-runtime.uc.mjs";
import {
  MIN_PANEL_WIDTH,
  PANEL_TYPE,
  SEPARATOR_TYPE,
  WebPanelsStore,
  clampWebPanelWidth,
  normalizeWebPanelUrl,
  normalizeResizerColor,
  webPanelSideForSidebar,
  panelMaxWidthFromViewport,
  parseWebPanelUnreadCount,
} from "./web-panels-store.uc.mjs";

// Digit -> panel position. 1..9 map to the first nine panels, 0 to the tenth,
// matching how browsers number tabs. event.code is used rather than event.key
// because on several layouts Ctrl+Alt behaves as AltGr and rewrites event.key.
// Page titles are mostly noise plus the site name at the end:
//   "Inbox (1,140) - diego88aku@gmail.com - Gmail"  -> "Gmail"
//   "(2) WhatsApp"                                  -> "WhatsApp"
// Take the trailing segment after a separator, minus any unread-count prefix,
// so panels name themselves without anyone typing anything.
function prettyPanelName(rawTitle) {
  const stripped = String(rawTitle ?? "")
    .replace(/^\s*[([]\d{1,4}[)\]]\s*/, "")
    .trim();
  if (!stripped) {
    return null;
  }

  const parts = stripped
    .split(/\s+[-–—|·:]\s+/)
    .map(part => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return stripped;
  }

  const last = parts[parts.length - 1];
  // A long trailing segment is a headline, not a site name.
  return last.length <= 40 ? last : parts[0];
}

function panelIndexFromEvent(event) {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(event.code || "");
  const digit = match ? Number(match[1]) : NaN;
  if (Number.isNaN(digit)) {
    return -1;
  }
  return digit === 0 ? 9 : digit - 1;
}

// The accelerator is Cmd on macOS and Ctrl everywhere else, so the two flags
// swap roles by platform. Whichever one is NOT the accelerator must be unheld,
// otherwise Ctrl+Cmd+1 would also fire on macOS.
const IS_MACOS = globalThis.Services?.appinfo?.OS === "Darwin";

function shortcutMatches(event, spec) {
  if (!spec || spec === "disabled" || event.repeat) {
    return false;
  }

  const accelHeld = IS_MACOS ? event.metaKey : event.ctrlKey;
  const nonAccelHeld = IS_MACOS ? event.ctrlKey : event.metaKey;

  return (
    !nonAccelHeld &&
    accelHeld === spec.includes("accel") &&
    event.altKey === spec.includes("alt") &&
    event.shiftKey === spec.includes("shift")
  );
}

const ROOT_ID = "sine-web-panels-root";
const RAIL_ID = "sine-web-panels-rail";
const LIST_ID = "sine-web-panels-list";
const ADD_BUTTON_ID = "sine-web-panels-add-button";
const BACKDROP_ID = "sine-web-panels-backdrop";
const MENU_ID = "sine-web-panels-menu";
const EDITOR_ID = "sine-web-panels-editor";
const TAB_MENU_ITEM_ID = "sine-web-panels-tab-context-add";
const RESIZER_ID = "sine-web-panels-resizer";
const FINDER_ID = "sine-web-panels-finder";
const TOGGLE_ID = "sine-web-panels-toggle";
const EDGE_ID = "sine-web-panels-edge";

// How long the peeked rail waits after the pointer leaves before sliding back
// out. Long enough to cross the gap to a panel button without chasing it.
const PEEK_OUT_DELAY = 320;

// Firefox stamps the chrome root when the window goes fullscreen: `inFullscreen`
// for either flavour (F11 or a page/video calling requestFullscreen), and
// `inDOMFullscreen` only for the content-driven one. Watching the attributes
// rather than guessing at event names keeps this working across Zen versions.
const FULLSCREEN_ATTRIBUTES = ["inFullscreen", "inDOMFullscreen"];

// Fired once the session's windows and their tabs are back.
const SESSION_RESTORED_TOPIC = "sessionstore-windows-restored";

// Zen stamps this on the chrome root when its sidebar sits on the right.
const ZEN_SIDEBAR_SIDE_ATTRIBUTE = "zen-right-side";


function isPanel(item) {
  return item?.type === PANEL_TYPE;
}

function isSeparator(item) {
  return item?.type === SEPARATOR_TYPE;
}

function displayCount(count) {
  return Number.isInteger(count) && count > 0 ? (count > 99 ? "99+" : String(count)) : "";
}

function fallbackFaviconUrl(panelUrl) {
  try {
    return new URL("/favicon.ico", panelUrl).href;
  } catch {
    return "";
  }
}

export class SineWebPanels {
  #store = new WebPanelsStore();
  #root;
  #rail;
  #list;
  #resizer;
  #backdrop;
  #editor;
  #menu;
  #browserChrome;
  #contentContainer;
  #tabContextMenuItem;
  #runtime;
  #items = [];
  #activeId = null;
  #activeParentTab = null;
  #surfaceState = null;
  #closeTimer = null;
  #editorState = null;
  #railInsertIndex = null;
  #unreadCounts = new Map();
  #menuOpenedAt = 0;
  #ignoreOutsideClicksUntil = 0;
  #abortController = new AbortController();
  #prefObserver;
  #sessionRestoreObserver;
  #correctingSelection = false;
  #resizeState = null;
  #resizeHovering = false;
  #dragState = null;
  #navBar;
  #finder;
  #finderInput;
  #finderList;
  #finderIndex = 0;
  #tabsProgressListener;
  #toggle;
  #edge;
  #collapsed = false;
  #peeking = false;
  #peekTimer = null;
  #fullscreen = false;
  #fullscreenObserver;
  #sidebarSideObserver;
  #restoreAfterFullscreen = null;
  #navBack;
  #navForward;
  #navReload;
  #navHome;

  constructor(windowRef) {
    this.window = windowRef;
    this.document = windowRef.document;
  }

  init() {
    this.destroyExistingRoot();
    this.#items = this.#store.loadItems({ persistNormalized: true });
    this.#mount();
    this.#runtime = new WebPanelsRuntime(this.window);
    this.#applyEnabledState();
    this.#observePrefs();
    this.#adoptRestoredPanelTabs();
    this.#observeSessionRestore();
  }

  destroyExistingRoot() {
    this.document.getElementById(ROOT_ID)?.remove();
    this.document.getElementById(RESIZER_ID)?.remove();
    this.document.getElementById(EDITOR_ID)?.remove();
    this.document.getElementById(TAB_MENU_ITEM_ID)?.remove();
    this.#clearOrphanedOverlayState();
  }

  destroy() {
    this.#abortController.abort();
    this.#fullscreenObserver?.disconnect();
    this.#fullscreenObserver = null;
    this.#sidebarSideObserver?.disconnect();
    this.#sidebarSideObserver = null;
    if (this.#closeTimer) {
      this.window.clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
    this.#setResizeHover(false);
    this.#closeSurface({ selectParent: false });
    if (this.#peekTimer) {
      this.window.clearTimeout(this.#peekTimer);
      this.#peekTimer = null;
    }
    if (this.#sessionRestoreObserver) {
      Services.obs.removeObserver(this.#sessionRestoreObserver, SESSION_RESTORED_TOPIC);
      this.#sessionRestoreObserver = null;
    }
    if (this.#prefObserver) {
      Services.prefs.removeObserver(WebPanelsStore.prefs.enabled, this.#prefObserver);
      Services.prefs.removeObserver(WebPanelsStore.prefs.resizerColor, this.#prefObserver);
    }
    if (this.#tabsProgressListener) {
      this.window.gBrowser?.removeTabsProgressListener?.(this.#tabsProgressListener);
      this.#tabsProgressListener = null;
    }
    this.#runtime?.destroy();
    this.#resetChromeLayout();
    this.document?.documentElement?.style.removeProperty("--sine-web-panels-accent");
    this.#editor?.remove();
    this.#tabContextMenuItem?.remove();
    this.#finder?.remove();
    this.#finder = null;
    this.#navBar?.remove();
    this.#navBar = null;
    this.#resizer?.remove();
    this.#root?.remove();
    this.#activeId = null;
    this.#activeParentTab = null;
    this.#surfaceState = null;
    this.#editor = null;
    this.#tabContextMenuItem = null;
    this.#resizer = null;
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
    this.#syncDisplayWidth();

    this.#backdrop = this.#el("div", { id: BACKDROP_ID, hidden: "true" });
    this.#resizer = this.#el("div", {
      id: RESIZER_ID,
      role: "separator",
      "aria-orientation": "vertical",
      title: "Resize Web Panel",
      hidden: "true",
    });

    this.#rail = this.#el("div", {
      id: RAIL_ID,
      role: "toolbar",
      "aria-label": "Web Panels",
    });
    this.#list = this.#el("div", { id: LIST_ID });
    this.#toggle = this.#button({
      id: TOGGLE_ID,
      className: "sine-web-panels-toggle",
    });
    const addButton = this.#button({
      id: ADD_BUTTON_ID,
      label: "",
      title: "New Web Panel",
      className: "sine-web-panels-add-button",
    });
    addButton.setAttribute("aria-label", "New Web Panel");
    this.#rail.append(this.#toggle, this.#list, addButton);

    // The strip the pointer has to reach to bring a collapsed rail back. It is
    // an element rather than a pointermove test on the window because chrome
    // never sees pointer moves over remote content — only chrome DOM stacked
    // above the content browser does.
    this.#edge = this.#el("div", { id: EDGE_ID, hidden: "true" });

    this.#editor = this.#buildEditor();
    this.#menu = this.#el("div", { id: MENU_ID, hidden: "true", role: "menu" });

    this.#finder = this.#buildFinder();
    this.#root.append(this.#backdrop, this.#edge, this.#rail, this.#menu, this.#finder);
    this.#browserChrome.append(this.#root, this.#resizer);
    (this.document.getElementById("mainPopupSet") ?? this.#browserChrome).append(this.#editor);
    this.#mountTabContextMenuItem();
    this.#syncChromeLayout();

    const signal = this.#abortController.signal;
    addButton.addEventListener("click", event => {
      event.stopPropagation();
      this.#openEditor({ mode: "add", anchor: addButton, insertIndex: this.#items.length });
    }, { signal });
    this.#backdrop.addEventListener("click", event => {
      if (!this.#isPointInsideActivePanel(event.clientX, event.clientY)) {
        this.#closePanel();
      }
    }, { signal });
    this.#toggle.addEventListener("click", event => {
      event.stopPropagation();
      this.#setCollapsed(!this.#collapsed);
    }, { signal });
    this.#edge.addEventListener("pointerenter", () => this.#setPeeking(true), { signal });
    this.#edge.addEventListener("pointerleave", () => this.#schedulePeekOut(), { signal });
    this.#rail.addEventListener("pointerenter", () => this.#cancelPeekTimer(), { signal });
    this.#rail.addEventListener("pointerleave", () => this.#schedulePeekOut(), { signal });
    this.#rail.addEventListener("contextmenu", this.#onRailContextMenu, { signal });
    this.window.addEventListener("pointerdown", this.#onWindowPointerDown, { signal, capture: true });
    this.window.addEventListener("pointermove", this.#onPointerMove, { signal });
    this.window.addEventListener("pointerup", this.#onPointerUp, { signal });
    this.window.addEventListener("resize", this.#onWindowResize, { signal });
    this.document.addEventListener("click", this.#onDocumentClick, { signal });
    this.document.addEventListener("keydown", this.#onKeyDown, { signal });
    this.#tabsProgressListener = {
      onLocationChange: (browser, _webProgress, _request, _location, _flags) => {
        const tab = this.window.gBrowser?.getTabForBrowser?.(browser);
        const panelId = tab?.getAttribute?.("sine-web-panel-id");
        if (!panelId) {
          return;
        }

        const item = this.#items.find(entry => entry.id === panelId);
        if (item) {
          this.#rememberLocation(item, browser);
        }
        if (panelId === this.#activeId) {
          this.#updateNavState();
        }
      },
    };
    this.window.gBrowser?.addTabsProgressListener?.(this.#tabsProgressListener);
    this.window.gBrowser?.tabContainer?.addEventListener("TabSelect", this.#onTabSelect, { signal });
    this.window.gBrowser?.tabContainer?.addEventListener("TabClose", this.#onTabClose, { signal });
    this.window.gBrowser?.tabContainer?.addEventListener("TabAttrModified", this.#onTabAttrModified, { signal });
    this.#observeFullscreen();
    this.#observeSidebarSide();
    this.#applyResizerColor();
    this.#applyCollapsedState(this.#store.collapsed);
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

  // Panel tabs are ordinary tabs as far as session restore is concerned, so a
  // restart hands them back — visible, unclaimed, and about to be duplicated by
  // the first panel that opens. Claim them before that happens.
  //
  // Run twice on purpose. A cold start reaches here before restore has
  // finished, so the observer catches it; a mod hot-loaded into a window that
  // is already up has missed that notification entirely, so the call in init
  // catches that. Both are idempotent.
  #adoptRestoredPanelTabs() {
    if (!this.#runtime || !this.#store.enabled) {
      return;
    }

    const { adopted, swept } = this.#runtime.adoptRestoredTabs(this.#items);
    if (adopted.length || swept.length) {
      console.log(
        `[Web Panels] Reclaimed ${adopted.length} restored panel tab(s), ` +
          `removed ${swept.length} with no panel left to open them.`
      );
    }
  }

  #observeSessionRestore() {
    this.#sessionRestoreObserver = { observe: () => this.#adoptRestoredPanelTabs() };
    Services.obs.addObserver(this.#sessionRestoreObserver, SESSION_RESTORED_TOPIC);
  }

  #observePrefs() {
    this.#prefObserver = {
      observe: (_subject, topic, prefName) => {
        if (topic !== "nsPref:changed") {
          return;
        }
        if (prefName === WebPanelsStore.prefs.enabled) {
          this.#applyEnabledState();
        } else if (prefName === WebPanelsStore.prefs.resizerColor) {
          this.#applyResizerColor();
        }
      },
    };
    // Deliberately NOT observing `collapsed`: it is per-window state that is
    // merely persisted, so hiding the rail in one window must not travel to
    // the others.
    Services.prefs.addObserver(WebPanelsStore.prefs.enabled, this.#prefObserver);
    // Unlike `collapsed`, this one is appearance and belongs to every window.
    Services.prefs.addObserver(WebPanelsStore.prefs.resizerColor, this.#prefObserver);
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

    this.#closePanel({ animate: false });
    if (this.#tabsProgressListener) {
      this.window.gBrowser?.removeTabsProgressListener?.(this.#tabsProgressListener);
      this.#tabsProgressListener = null;
    }
    this.#runtime?.destroy();
    this.#runtime = new WebPanelsRuntime(this.window);
    this.#root.setAttribute("disabled", "true");
    this.#resetChromeLayout();
  }

  #syncChromeLayout() {
    if (!this.#browserChrome || !this.#root || !this.#store.enabled) {
      return;
    }

    // Fullscreen belongs to the page, and a collapsed rail has no strip of
    // window to reserve. Releasing here rather than only at the transition
    // means every caller re-asserts the right layout.
    if (this.#fullscreen || this.#collapsed) {
      this.#releaseChromeLayout();
      return;
    }

    const side = this.#placementSide();
    const styles = this.window.getComputedStyle(this.#root);
    const railSize = Number.parseFloat(styles.getPropertyValue("--sine-web-panels-rail-size")) || 36;
    const gap = Number.parseFloat(styles.getPropertyValue("--sine-web-panels-gap")) || 8;
    const reservedSize = `${railSize + gap}px`;
    this.#browserChrome.setAttribute("sine-web-panels-side", side);
    this.document.documentElement.setAttribute("sine-web-panels-side", side);
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
  }

  #resetChromeLayout() {
    this.#releaseChromeLayout();
    this.document?.documentElement?.style.removeProperty("--sine-web-panels-width");
  }

  // Give the reserved inline space back to the content without forgetting how
  // wide the panel is. The margin is written inline with `!important`, so no
  // stylesheet can override it — fullscreen has to take it off in script.
  #releaseChromeLayout() {
    this.#browserChrome?.removeAttribute("sine-web-panels-side");
    this.document?.documentElement?.removeAttribute("sine-web-panels-side");
    this.#browserChrome?.style.removeProperty("--sine-web-panels-reserved-inline-size");
    this.#contentContainer?.style.removeProperty("margin-inline-start");
    this.#contentContainer?.style.removeProperty("margin-inline-end");
    this.#contentContainer = null;
  }

  // --------------------------------------------------------------------------
  // Collapse / peek
  //
  // Collapsed, the rail slides out and hands its reserved strip back to the
  // content. It comes in again as an OVERLAY while the pointer rests at that
  // window edge, so peeking never moves the page underneath.
  // --------------------------------------------------------------------------

  #setCollapsed(collapsed) {
    const next = Boolean(collapsed);
    if (next === this.#collapsed) {
      return;
    }

    // Per window. The pref is written to remember how the rail was last left —
    // it seeds the next window and the next session — but nothing observes it,
    // so hiding the rail here leaves every other window alone.
    this.#store.collapsed = next;
    this.#applyCollapsedState(next);
  }

  #applyCollapsedState(collapsed) {
    const changed = collapsed !== this.#collapsed;
    this.#collapsed = collapsed;
    if (!this.#root) {
      return;
    }

    if (collapsed && changed) {
      // An open panel would keep covering the very edge the rail hides behind,
      // and a panel anchored to a rail that is not there reads as a bug.
      this.#closePanel({ animate: false });
      this.#closeMenu();
      this.#closeEditor();
      this.#closeFinder();
    }

    this.#setPeeking(false);
    this.#root.toggleAttribute("collapsed", collapsed);
    this.#edge.hidden = !collapsed;
    this.#updateToggleLabel();
    this.#syncChromeLayout();
    this.#syncDisplayWidth();
  }

  // The handle sits outside #sine-web-panels-root, in the panel frame, so the
  // override goes on the document root like --sine-web-panels-width does.
  // Removing it lets the stylesheet's theme chain take over again, which is
  // what makes "empty" a working reset rather than a blank colour.
  #applyResizerColor() {
    const color = this.#store.resizerColor;
    const root = this.document?.documentElement;
    if (!root) {
      return;
    }

    if (color) {
      root.style.setProperty("--sine-web-panels-accent", color);
    } else {
      root.style.removeProperty("--sine-web-panels-accent");
    }
  }

  #updateToggleLabel() {
    if (!this.#toggle) {
      return;
    }

    const label = this.#collapsed ? "Show the panel rail" : "Hide the panel rail";
    this.#toggle.title = label;
    this.#toggle.setAttribute("aria-label", label);
    this.#toggle.setAttribute("aria-pressed", String(!this.#collapsed));
  }

  #setPeeking(peeking) {
    this.#cancelPeekTimer();
    const next = Boolean(peeking) && this.#collapsed;
    if (next === this.#peeking) {
      return;
    }

    this.#peeking = next;
    this.#root?.toggleAttribute("peeking", next);
  }

  #schedulePeekOut() {
    if (!this.#peeking) {
      return;
    }

    this.#cancelPeekTimer();
    this.#peekTimer = this.window.setTimeout(() => {
      this.#peekTimer = null;
      if (this.#peekHeld()) {
        this.#schedulePeekOut();
        return;
      }
      this.#setPeeking(false);
    }, PEEK_OUT_DELAY);
  }

  #cancelPeekTimer() {
    if (this.#peekTimer) {
      this.window.clearTimeout(this.#peekTimer);
      this.#peekTimer = null;
    }
  }

  // Things the rail owns but that live outside it: sliding away under an open
  // menu, mid-drag, or while the panel it opened covers the edge would leave
  // the user with no way back to it.
  #peekHeld() {
    return Boolean(
      this.#activeId ||
      this.#resizeState ||
      this.#dragState ||
      (this.#menu && !this.#menu.hidden) ||
      (this.#finder && !this.#finder.hidden) ||
      this.#editorState
    );
  }

  // The rail takes whichever side Zen's sidebar is not on, and Zen lets that be
  // changed at runtime. Nothing re-read it: the side is applied at mount, in
  // #render and in #syncChromeLayout, and none of those runs when the sidebar
  // moves — so the two ended up stacked on the same side until the next
  // restart. Same MutationObserver pattern as fullscreen, for the same reason:
  // the attribute is what the layout actually keys off.
  #observeSidebarSide() {
    this.#sidebarSideObserver = new this.window.MutationObserver(() =>
      this.#applyPlacementSide()
    );
    this.#sidebarSideObserver.observe(this.document.documentElement, {
      attributes: true,
      attributeFilter: [ZEN_SIDEBAR_SIDE_ATTRIBUTE],
    });
  }

  #applyPlacementSide() {
    if (!this.#root) {
      return;
    }

    const side = this.#placementSide();
    // The DOM is the cache — no point re-running the layout for an attribute
    // that was rewritten with the value it already had.
    if (this.#root.getAttribute("side") === side) {
      return;
    }

    this.#root.setAttribute("side", side);
    // Swaps the reserved margin from one side to the other; everything else —
    // the rail, the panel overlay, the resizer — is keyed off the attributes
    // this sets.
    this.#syncChromeLayout();
    this.#syncDisplayWidth();
  }

  // The rail is browser chrome, so it has no business sitting on top of a
  // fullscreen video — and neither has the strip of window it reserves.
  #observeFullscreen() {
    this.#fullscreenObserver = new this.window.MutationObserver(() =>
      this.#syncFullscreenState()
    );
    this.#fullscreenObserver.observe(this.document.documentElement, {
      attributes: true,
      attributeFilter: FULLSCREEN_ATTRIBUTES,
    });
    // The attribute is the source of truth, but the chrome-only `fullscreen`
    // event fires on the window for F11 too, and catches the transition a tick
    // earlier. Both funnel into the same idempotent sync.
    this.window.addEventListener("fullscreen", () => this.#syncFullscreenState(), {
      signal: this.#abortController.signal,
      capture: true,
    });
    // Sine can hot-load the mod into a window that is already fullscreen.
    this.#syncFullscreenState();
  }

  #isFullscreen() {
    const root = this.document?.documentElement;
    return Boolean(
      root?.hasAttribute("inDOMFullscreen") ||
      root?.hasAttribute("inFullscreen") ||
      this.window.fullScreen
    );
  }

  #syncFullscreenState() {
    const fullscreen = this.#isFullscreen();
    if (fullscreen === this.#fullscreen || !this.#root) {
      return;
    }
    this.#fullscreen = fullscreen;

    if (fullscreen) {
      this.#closeMenu();
      this.#closeEditor();
      this.#closeFinder();

      // A video fullscreened from inside a panel is the one case where the
      // panel must survive: closing it would tear its browser out of the deck
      // and cancel the fullscreen the user just asked for. Let it take the
      // whole window instead (the rail still goes away).
      if (this.#fullscreenTargetsActivePanel()) {
        this.#restoreAfterFullscreen = null;
        this.document.documentElement.setAttribute("sine-web-panels-panel-fullscreen", "true");
      } else {
        // Remember the open panel so leaving fullscreen puts the window back
        // the way the user left it.
        this.#restoreAfterFullscreen = this.#activeId;
        this.#closePanel({ animate: false });
      }

      this.#root.setAttribute("fullscreen", "true");
      this.#releaseChromeLayout();
      return;
    }

    this.#root.removeAttribute("fullscreen");
    this.document.documentElement.removeAttribute("sine-web-panels-panel-fullscreen");
    this.#syncChromeLayout();

    const restoreId = this.#restoreAfterFullscreen;
    this.#restoreAfterFullscreen = null;
    const item = restoreId ? this.#items.find(entry => entry.id === restoreId) : null;
    if (item) {
      this.#openPanel(item);
    }
  }

  // Gecko sets the chrome document's fullscreenElement to the <browser> hosting
  // the content that went fullscreen, before it stamps `inDOMFullscreen` — so
  // by the time either signal reaches us this answer is already reliable.
  #fullscreenTargetsActivePanel() {
    const browser = this.#activePanelBrowser();
    const element = this.document.fullscreenElement;
    if (!browser || !element) {
      return false;
    }

    return (
      element === browser ||
      element.contains?.(browser) === true ||
      browser.contains?.(element) === true
    );
  }

  #findContentContainer() {
    return (
      this.document.getElementById("zen-appcontent-wrapper") ??
      this.document.getElementById("zen-tabbox-wrapper") ??
      this.document.getElementById("tabbrowser-tabbox") ??
      this.document.getElementById("appcontent")
    );
  }

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
  }

  #renderPanelButton(item, index) {
    const button = this.#button({
      className: "sine-web-panels-item sine-web-panels-panel-button",
      title: this.#panelName(item),
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
    const tabIcon = this.#runtime?.get(item.id)?.tab?.getAttribute("image");
    this.#setFaviconSource(icon, item.url, tabIcon);
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
    if (this.#fullscreen) {
      return;
    }
    this.#closeEditor();
    if (this.#closeTimer) {
      this.window.clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
    const switching = Boolean(this.#activeId && this.#activeId !== item.id);
    const parentTab = this.#currentVisibleTab() ?? this.#activeParentTab;
    const panelTab = this.#runtime.ensurePanelTab(item, parentTab, this.#store.resolveUrl(item));
    if (!this.#openSurface(parentTab, panelTab)) {
      console.warn("[Web Panels] Could not attach managed panel tab to a Zen browser surface.");
      return;
    }

    this.#activeId = item.id;
    this.#activeParentTab = parentTab;
    this.#backdrop.hidden = false;
    this.#resizer.hidden = false;
    this.#root.setAttribute("open", "true");
    this.#root.toggleAttribute("switching", switching);
    this.#root.toggleAttribute("opening", !switching);
    this.#root.removeAttribute("closing");
    this.#root.setAttribute("active", item.id);
    this.#bindBrowserTitle(item, panelTab.linkedBrowser);
    this.#store.rememberTitle(item.id, panelTab.label);
    this.#syncUnreadFromTab(item.id);
    this.#render();
    this.window.setTimeout(() => {
      this.#root?.removeAttribute("switching");
      this.#root?.removeAttribute("opening");
    }, 90);
  }

  #closePanel({ animate = true } = {}) {
    if (!this.#activeId) {
      return;
    }

    this.#root.removeAttribute("active");
    this.#root.removeAttribute("open");
    this.#root.removeAttribute("opening");
    if (this.#closeTimer) {
      this.window.clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }

    if (animate) {
      this.#root.setAttribute("closing", "true");
      this.#closeTimer = this.window.setTimeout(() => this.#finishClosePanel(), 90);
    } else {
      this.#finishClosePanel();
    }
  }

  #finishClosePanel() {
    this.#closeTimer = null;
    this.#closeSurface();
    this.#activeId = null;
    this.#activeParentTab = null;
    this.#backdrop.hidden = true;
    this.#resizer.hidden = true;
    this.#setResizeHover(false);
    this.#root.removeAttribute("active");
    this.#root.removeAttribute("open");
    this.#root.removeAttribute("opening");
    this.#root.removeAttribute("closing");
    this.#render();
  }

  #openSurface(parentTab, panelTab) {
    const parentBrowser = parentTab?.linkedBrowser;
    const panelBrowser = panelTab?.linkedBrowser;
    const parentContainer = parentBrowser?.closest(".browserSidebarContainer");
    const panelContainer = panelBrowser?.closest(".browserSidebarContainer");
    const panelFrame = panelContainer?.querySelector(".browserContainer");
    if (!parentBrowser || !panelBrowser || !parentContainer || !panelContainer || !panelFrame) {
      return false;
    }

    this.#closeSurface({ selectParent: false });
    parentContainer.classList.add("sine-web-panels-parent-background");
    panelContainer.classList.add("deck-selected", "sine-web-panels-overlay");
    panelFrame.append(this.#buildNavBar(), this.#resizer);
    panelBrowser.setAttribute("sine-web-panel-selected", "true");
    parentBrowser.zenModeActive = true;
    parentBrowser.docShellIsActive = true;
    panelBrowser.zenModeActive = true;
    panelBrowser.docShellIsActive = true;
    // Recorded BEFORE the panel tab is selected. Selecting it fires TabSelect
    // synchronously, and #onTabSelect reads this to tell the panel's own
    // backing from a stray one — with it unset, the guard took the selection
    // straight back off the panel that was opening, and every panel "opened"
    // whichever ordinary tab came first in the strip.
    this.#surfaceState = {
      parentTab,
      panelTab,
      parentBrowser,
      panelBrowser,
      parentContainer,
      panelContainer,
      panelFrame,
    };
    // Select the PANEL tab so WebExtensions resolve the panel's site:
    // tabs.query({active:true}) is how password managers pick a context, and
    // with the parent selected they offer credentials for the page behind the
    // panel. Zen's async tab switcher will then move `deck-selected` onto the
    // panel container and strip it from the parent, which would stop the parent
    // painting and turn the overlay into a full replacement — so re-assert it.
    if (this.window.gBrowser && this.window.gBrowser.selectedTab !== panelTab) {
      this.window.gBrowser.selectedTab = panelTab;
    }
    if (parentTab) {
      parentTab._visuallySelected = true;
    }
    this.#keepParentPainted();
    return true;
  }

  // Zen's AsyncTabSwitcher owns `deck-selected` and runs across frames, so the
  // class has to be re-applied after it settles, not just once synchronously.
  #keepParentPainted() {
    const apply = () => {
      const parentContainer = this.#surfaceState?.parentContainer;
      const parentBrowser = this.#surfaceState?.parentBrowser;
      if (!parentContainer) {
        return;
      }
      parentContainer.classList.add("deck-selected");
      if (parentBrowser) {
        parentBrowser.docShellIsActive = true;
      }
    };

    apply();
    this.window.requestAnimationFrame(() => {
      apply();
      this.window.requestAnimationFrame(apply);
    });
  }

  #closeSurface({ selectParent = true } = {}) {
    if (!this.#surfaceState) {
      return;
    }

    const { parentTab, panelTab, parentBrowser, panelBrowser, parentContainer, panelContainer } = this.#surfaceState;
    panelContainer.classList.remove("deck-selected", "sine-web-panels-overlay");
    parentContainer.classList.remove("sine-web-panels-parent-background");
    panelBrowser.removeAttribute("sine-web-panel-selected");
    panelBrowser.zenModeActive = false;
    panelBrowser.docShellIsActive = false;
    if (selectParent && parentTab && this.window.gBrowser?.selectedTab === panelTab) {
      this.window.gBrowser.selectedTab = parentTab;
    }
    if (parentBrowser && this.window.gBrowser?.selectedTab !== parentTab) {
      parentBrowser.zenModeActive = false;
      parentBrowser.docShellIsActive = false;
    }
    if (parentTab) {
      parentTab._visuallySelected = this.window.gBrowser?.selectedTab === parentTab;
    }
    this.#surfaceState = null;
  }

  #clearOrphanedOverlayState() {
    this.document
      .querySelectorAll(".browserSidebarContainer.sine-web-panels-overlay")
      .forEach(container => container.classList.remove("deck-selected", "sine-web-panels-overlay"));
    this.document
      .querySelectorAll(".browserSidebarContainer.sine-web-panels-parent-background")
      .forEach(container => container.classList.remove("sine-web-panels-parent-background"));
    this.document
      .querySelectorAll('browser[sine-web-panel-selected="true"]')
      .forEach(browser => browser.removeAttribute("sine-web-panel-selected"));
  }

  #isPointInsideActivePanel(clientX, clientY) {
    const panelElement = this.#activePanelSurface();
    if (!panelElement) {
      return false;
    }

    const rect = panelElement.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  #eventIsOnResizeEdge(event) {
    const panelElement = this.#activePanelSurface();
    if (!panelElement || this.#resizer?.hidden) {
      return false;
    }

    const rect = panelElement.getBoundingClientRect();
    if (event.clientY < rect.top || event.clientY > rect.bottom) {
      return false;
    }

    const hitWidth = this.#resizeHitWidth();
    if (this.#placementSide() === "right") {
      return event.clientX < rect.left && event.clientX >= rect.left - hitWidth;
    }

    return event.clientX > rect.right && event.clientX <= rect.right + hitWidth;
  }

  #activePanelSurface() {
    return (
      this.#surfaceState?.panelBrowser ??
      this.#surfaceState?.panelContainer?.querySelector(".browserStack") ??
      this.#surfaceState?.panelContainer?.querySelector(".browserContainer") ??
      null
    );
  }

  #resizeHitWidth() {
    const styles = this.window.getComputedStyle(this.#root);
    const width = Number.parseFloat(styles.getPropertyValue("--sine-web-panels-resizer-width"));
    return Number.isFinite(width) ? width : 8;
  }

  #setResizeHover(isHovering) {
    if (this.#resizeHovering === isHovering) {
      return;
    }

    this.#resizeHovering = isHovering;
    this.document.documentElement.toggleAttribute("sine-web-panels-resizer-hover", isHovering);
    this.window.setCursor?.(isHovering ? "ew-resize" : "auto");
  }

  #bindBrowserTitle(item, browser) {
    if (browser.getAttribute("sine-web-panels-title-bound") === item.id) {
      return;
    }
    browser.setAttribute("sine-web-panels-title-bound", item.id);
    const update = () => {
      this.#syncUnreadFromTab(item.id);
      this.#store.rememberTitle(item.id, this.#runtime?.get(item.id)?.tab?.label);
      this.#render();
    };
    browser.addEventListener("DOMTitleChanged", update, { signal: this.#abortController.signal });
    browser.addEventListener("load", update, { signal: this.#abortController.signal });
  }

  // Only remember same-origin destinations: an auth bounce through a provider
  // must never become the page the panel reopens on.
  #rememberLocation(item, browser) {
    const spec = browser?.currentURI?.spec;
    if (!spec) {
      return;
    }

    let sameOrigin = false;
    try {
      sameOrigin = new URL(spec).origin === new URL(item.url).origin;
    } catch {
      sameOrigin = false;
    }

    if (sameOrigin) {
      this.#store.rememberUrl(item.id, spec);
    }
  }

  #activePanelBrowser() {
    return this.#runtime?.getBrowser(this.#activeId) ?? null;
  }

  #navGoBack() {
    const browser = this.#activePanelBrowser();
    if (browser?.canGoBack) {
      browser.goBack();
    }
  }

  #navGoForward() {
    const browser = this.#activePanelBrowser();
    if (browser?.canGoForward) {
      browser.goForward();
    }
  }

  // Plain reload of wherever the panel is now; Home is the one that resets.
  #navReloadPage() {
    this.#activePanelBrowser()?.reload?.();
  }

  // Home is also the reset: without clearing the memory the panel would drift
  // straight back on the next restart.
  #navGoHome(item = null) {
    const target = item ?? this.#items.find(entry => entry.id === this.#activeId);
    const browser = this.#runtime?.getBrowser(target?.id);
    if (!target || !browser) {
      return;
    }
    this.#store.forgetUrl(target.id);
    browser.loadURI(Services.io.newURI(target.url), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }

  // Promote wherever the panel is now to its configured home. Sites whose URL
  // encodes an account or workspace (Proton's /u/N, for instance) use indexes
  // that drift, so pinning the home by hand is guesswork — this lets the panel
  // record the right one once it is actually there.
  #setHomeToCurrent(item) {
    const browser = this.#runtime?.getBrowser(item.id);
    const spec = browser?.currentURI?.spec;
    if (!spec || !normalizeWebPanelUrl(spec)) {
      return;
    }
    this.#store.updatePanel(item.id, spec, item.name ?? null);
    this.#store.forgetUrl(item.id);
    this.#render();
  }

  #updateNavState() {
    if (!this.#navBar) {
      return;
    }
    const browser = this.#activePanelBrowser();
    this.#navBack.disabled = !browser?.canGoBack;
    this.#navForward.disabled = !browser?.canGoForward;
  }

  #syncUnreadFromTab(itemId) {
    const tab = this.#runtime?.get(itemId)?.tab;
    const browser = tab?.linkedBrowser;
    const title =
      tab?.getAttribute("label") ||
      browser?.contentTitle ||
      browser?.getAttribute("contentTitle") ||
      "";
    const count = parseWebPanelUnreadCount(title);
    if (count) {
      this.#unreadCounts.set(itemId, count);
      return;
    }

    this.#unreadCounts.delete(itemId);
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

  #setFaviconSource(icon, panelUrl, tabIcon = "") {
    const fallbackUrl = fallbackFaviconUrl(panelUrl);
    icon.src = tabIcon || `page-icon:${panelUrl}`;
    icon.addEventListener("error", () => {
      if (fallbackUrl && icon.src !== fallbackUrl) {
        icon.src = fallbackUrl;
        return;
      }

      icon.removeAttribute("src");
      icon.setAttribute("fallback", "true");
    });
  }

  // A slim bar pinned to the top of the panel. It stays out of the way until
  // the panel is hovered (see .sine-web-panels-nav in the stylesheet), so it
  // costs no space while reading.
  #buildNavBar() {
    if (this.#navBar) {
      this.#updateNavState();
      return this.#navBar;
    }

    // Floats beside the panel's outer edge (see the CSS), a vertical stack of
    // back / forward / home. Nothing here overlaps the panel's page.
    const bar = this.#el("div", {
      class: "sine-web-panels-nav",
      role: "toolbar",
      "aria-label": "Web panel navigation",
      "aria-orientation": "vertical",
    });

    const mk = (name, label, handler) => {
      const button = this.#button({
        className: `sine-web-panels-nav-button sine-web-panels-nav-${name}`,
        title: label,
      });
      button.setAttribute("aria-label", label);
      button.addEventListener("click", event => {
        event.stopPropagation();
        handler();
        this.#updateNavState();
      }, { signal: this.#abortController.signal });
      return button;
    };

    this.#navBack = mk("back", "Back", () => this.#navGoBack());
    this.#navForward = mk("forward", "Forward", () => this.#navGoForward());
    this.#navReload = mk("reload", "Reload", () => this.#navReloadPage());
    this.#navHome = mk("home", "Home (reset this panel)", () => this.#navGoHome());

    bar.append(this.#navBack, this.#navForward, this.#navReload, this.#navHome);
    this.#navBar = bar;
    this.#updateNavState();
    return bar;
  }

  // A filter over the rail: type to narrow the panel list, Enter opens the
  // highlighted one. Self-contained — it reads the same #items the rail draws,
  // so panels never opened this session are searchable too.
  #buildFinder() {
    const finder = this.#el("div", { id: FINDER_ID, hidden: "true", role: "dialog" });
    const input = this.#el("input", {
      type: "text",
      placeholder: "Search web panels…",
      "aria-label": "Search web panels",
    });
    const list = this.#el("div", { class: "sine-web-panels-finder-list", role: "listbox" });

    input.addEventListener("input", () => this.#renderFinder(), {
      signal: this.#abortController.signal,
    });
    finder.addEventListener("keydown", event => this.#onFinderKeyDown(event), {
      signal: this.#abortController.signal,
      capture: true,
    });

    finder.append(input, list);
    this.#finderInput = input;
    this.#finderList = list;
    return finder;
  }

  // Everything the finder can act on, grouped: web panels first, then the
  // tabs of each space. Panels come from #items (so panels never opened this
  // session are included); tabs come from gBrowser, minus the hidden tabs the
  // mod owns.
  #finderGroups() {
    const query = (this.#finderInput?.value ?? "").trim().toLowerCase();
    const hit = (...fields) =>
      !query || fields.some(f => (f ?? "").toLowerCase().includes(query));

    const groups = [];

    const titles = this.#store.lastTitles;
    const panels = this.#items
      .filter(isPanel)
      .filter(item =>
        hit(
          this.#panelName(item),
          item.name,
          item.title,
          item.url,
          titles[item.id],
          this.#runtime?.get(item.id)?.tab?.label
        )
      )
      .map(item => ({
        kind: "panel",
        item,
        folder: item.title,
        label: this.#panelName(item),
      }));
    if (panels.length) {
      groups.push({ id: "panels", title: "Web panels", icon: "◧", entries: panels });
    }

    // tabs, bucketed by the space they live in
    const spaces = new Map();
    const seen = new Set();
    for (const tab of this.#allTabs()) {
      if (this.#isPanelTab(tab) || tab.closing) {
        continue;
      }
      const label = tab.label ?? "";
      const url = tab.linkedBrowser?.currentURI?.spec ?? "";
      if (!hit(label, url)) {
        continue;
      }
      const spaceId = tab.getAttribute("zen-workspace-id") || "";
      // Only collapse rows that genuinely point at the same page. Lazily
      // restored tabs have no currentURI yet, and falling back to the title
      // there merges distinct tabs whose titles happen to match — which is how
      // a whole space's worth of results disappeared.
      if (url) {
        const dedupeKey = `${spaceId}|${url}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
      }
      if (!spaces.has(spaceId)) {
        spaces.set(spaceId, []);
      }
      const group = tab.group;
      const folder = group?.isZenFolder ? group.label || null : null;
      spaces.get(spaceId).push({ kind: "tab", tab, folder, label: label || url });
    }

    for (const [spaceId, entries] of spaces) {
      const space = this.#spaceInfo(spaceId);
      groups.push({ id: `space:${spaceId}`, title: space.name, icon: space.icon, entries });
    }

    // nothing matched: offer to open it instead of dead-ending
    if (!groups.length && query) {
      groups.push({
        id: "open",
        title: "Open",
        icon: "＋",
        entries: [{ kind: "open", query, label: this.#openLabel(query) }],
      });
    }

    return groups;
  }

  // gBrowser.tabs only holds the spaces that have actually been visited — Zen
  // materialises a space's tabs on first switch. _allStoredTabs carries every
  // tab, which is what makes unvisited spaces searchable at all.
  #allTabs() {
    const stored = this.window.gZenWorkspaces?._allStoredTabs;
    const live = [...(this.window.gBrowser?.tabs ?? [])];
    if (!Array.isArray(stored) || !stored.length) {
      return live;
    }
    return [...new Set([...stored, ...live])];
  }

  // Precedence: a name the user typed, then one derived from the page title
  // (remembered across restarts), then the hostname we started with.
  #panelName(item) {
    if (item.name) {
      return item.name;
    }
    const live = this.#runtime?.get(item.id)?.tab?.label;
    const remembered = this.#store.lastTitles[item.id];
    return prettyPanelName(live || remembered) || item.title || item.url;
  }

  #spaceInfo(spaceId) {
    const fallback = { name: "Other tabs", icon: "▤" };
    if (!spaceId) {
      return fallback;
    }
    try {
      // _workspaceCache IS the array of {uuid, name, icon, position, theme}.
      const cache = this.window.gZenWorkspaces?._workspaceCache;
      const all = Array.isArray(cache) ? cache : (cache?.workspaces ?? []);
      const found = all.find(w => w.uuid === spaceId);
      if (found) {
        return { name: found.name || "Space", icon: found.icon || "▤" };
      }
    } catch {
      // Zen internals move between versions; the fallback keeps the finder usable.
    }
    return fallback;
  }

  #openLabel(query) {
    return normalizeWebPanelUrl(query) ? `Open ${query}` : `Search for “${query}”`;
  }

  #finderEntries() {
    return this.#finderGroups().flatMap(group => group.entries);
  }

  #activateFinderEntry(entry) {
    this.#closeFinder();
    if (!entry) {
      return;
    }
    if (entry.kind === "panel") {
      this.#togglePanel(entry.item);
      return;
    }
    if (entry.kind === "tab") {
      this.#closePanel({ animate: false });
      this.window.gBrowser.selectedTab = entry.tab;
      return;
    }
    if (entry.kind === "open") {
      const url = normalizeWebPanelUrl(entry.query);
      if (url) {
        this.#openInNewTab(url);
      } else {
        this.window.openTrustedLinkIn?.(
          this.window.BrowserSearch?.searchURL?.(entry.query) ?? entry.query,
          "tab"
        );
      }
    }
  }

  #renderFinder() {
    if (!this.#finderList) {
      return;
    }

    const groups = this.#finderGroups();
    const entries = groups.flatMap(group => group.entries);
    this.#finderIndex = Math.max(0, Math.min(this.#finderIndex, entries.length - 1));
    this.#finderList.replaceChildren();

    let flat = 0;
    for (const group of groups) {
      const header = this.#el("div", { class: "sine-web-panels-finder-group" });
      header.append(
        this.#el("span", { class: "sine-web-panels-finder-group-icon" }, group.icon),
        this.#el("span", { class: "sine-web-panels-finder-group-title" }, group.title)
      );
      this.#finderList.append(header);

      for (const entry of group.entries) {
        const index = flat++;
        const row = this.#button({
          className: `sine-web-panels-finder-row sine-web-panels-finder-${entry.kind}`,
        });
        // Space is the group header; the folder rides on the row so the full
        // Space / Folder / tab path is visible without nesting the list.
        if (entry.folder) {
          row.append(this.#el("span", { class: "sine-web-panels-finder-folder" }, entry.folder));
        }
        row.append(this.#el("span", { class: "sine-web-panels-finder-label" }, entry.label));
        row.setAttribute("role", "option");
        if (index === this.#finderIndex) {
          row.setAttribute("selected", "true");
          this.window.requestAnimationFrame(() =>
            row.scrollIntoView({ block: "nearest" })
          );
        }

        // Panels keep their favicon; tabs reuse the one Zen already resolved;
        // the open-new row gets the group glyph instead.
        if (entry.kind === "panel") {
          const icon = this.#el("img", { class: "sine-web-panels-favicon", alt: "", draggable: "false" });
          this.#setFaviconSource(icon, entry.item.url, this.#runtime?.get(entry.item.id)?.tab?.getAttribute("image"));
          row.prepend(icon);
        } else if (entry.kind === "tab") {
          const image = entry.tab.getAttribute("image");
          if (image) {
            const icon = this.#el("img", { class: "sine-web-panels-favicon", alt: "", draggable: "false", src: image });
            row.prepend(icon);
          }
        }

        row.addEventListener("click", event => {
          event.stopPropagation();
          this.#activateFinderEntry(entry);
        }, { signal: this.#abortController.signal });
        this.#finderList.append(row);
      }
    }
  }

  #onFinderKeyDown(event) {
    const entries = this.#finderEntries();
    if (event.key === "Escape") {
      event.preventDefault();
      this.#closeFinder();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!entries.length) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.#finderIndex = (this.#finderIndex + step + entries.length) % entries.length;
      this.#renderFinder();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.#activateFinderEntry(entries[this.#finderIndex]);
    }
  }

  #openFinder() {
    if (!this.#finder) {
      return;
    }
    this.#closeMenu();
    this.#closeEditor();
    this.#finderIndex = 0;
    this.#finderInput.value = "";
    this.#finder.hidden = false;
    this.#renderFinder();
    this.window.requestAnimationFrame(() => this.#finderInput.focus());
  }

  #closeFinder() {
    if (this.#finder) {
      this.#finder.hidden = true;
    }
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
    // The name lives in Edit only. Adding a panel is one field and one
    // click; naming is for the exception — two accounts on the same site
    // auto-name identically — and right-clicking the icon is the moment
    // someone knows they need it. (Tom's call, 2026-09-09.)
    const nameInput = this.#el("input", {
      id: "sine-web-panels-name-input",
      type: "text",
      placeholder: "Name (optional)",
      "aria-label": "Web Panel name",
      hidden: "true",
    });
    nameInput.hidden = true;
    const error = this.#el("div", {
      id: "sine-web-panels-editor-error",
      role: "alert",
      hidden: "true",
    });
    const submit = this.#button({
      id: "sine-web-panels-editor-submit",
      label: "Add",
      className: "sine-web-panels-ghost-button",
    });
    submit.type = "submit";
    form.append(input, nameInput, submit, error);
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
    const input = this.#editor.querySelector("#sine-web-panels-url-input");
    const nameInput = this.#editor.querySelector("#sine-web-panels-name-input");
    const submit = this.#editor.querySelector("button");
    const error = this.#editor.querySelector('[role="alert"]');
    this.#closeMenu();
    this.#editorState = { mode, itemId: item?.id ?? null, insertIndex };
    this.#editor.setAttribute("mode", mode);
    input.value = item?.url ?? this.#currentTabUrl() ?? "";
    nameInput.value = item?.name ?? "";
    nameInput.hidden = mode !== "edit";
    submit.textContent = mode === "edit" ? "Save" : "Add";
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
    const input = this.#editor.querySelector("#sine-web-panels-url-input");
    const nameInput = this.#editor.querySelector("#sine-web-panels-name-input");
    const error = this.#editor.querySelector('[role="alert"]');
    const url = normalizeWebPanelUrl(input.value);
    if (!url) {
      error.textContent = "Enter a valid http or https URL.";
      error.hidden = false;
      return;
    }

    if (this.#editorState?.mode === "edit") {
      const updated = this.#store.updatePanel(this.#editorState.itemId, url, nameInput.value);
      if (updated) {
        this.#unloadPanel(updated.id);
      }
    } else {
      // No name on Add: the field is not shown there, and a stale value must
      // not travel from an earlier Edit.
      this.#store.insert(this.#store.createPanel(url, ""), this.#editorState?.insertIndex ?? this.#items.length);
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
          ["Back", () => this.#navGoBack(), this.#activeId !== item.id],
          ["Forward", () => this.#navGoForward(), this.#activeId !== item.id],
          ["Home (reset)", () => this.#navGoHome(item)],
          ["Set current page as home", () => this.#setHomeToCurrent(item), this.#activeId !== item.id],
          ["separator"],
          ["Open in New Tab", () => this.#openInNewTab(item.url)],
          ["Edit Web Panel", () => this.#openEditor({ mode: "edit", item, anchor: this.#findItemElement(item.id) })],
          ["Move Up", () => this.#moveItem(item.id, index - 1), index <= 0],
          ["Move Down", () => this.#moveItem(item.id, index + 1), index >= this.#items.length - 1],
          ["separator"],
          ["Unload Web Panel", () => this.#unloadPanel(item.id)],
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
    this.#unloadPanel(id);
    this.#store.forgetUrl(id);
    this.#store.forgetTitle(id);
    this.#store.remove(id);
    this.#unreadCounts.delete(id);
    this.#render();
  }

  #unloadPanel(id) {
    if (this.#activeId === id) {
      this.#closePanel({ animate: false });
    }
    this.#runtime.unload(id);
    this.#unreadCounts.delete(id);
  }

  #moveItem(id, targetIndex) {
    this.#store.move(id, targetIndex);
    this.#render();
  }

  #onItemPointerDown(event, item) {
    if (event.button !== 0) {
      return;
    }
    const target = this.#findItemElement(item.id);
    this.#dragState = {
      itemId: item.id,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      target,
    };
    target?.setPointerCapture?.(event.pointerId);
  }

  #onPointerMove = event => {
    if (this.#resizeState) {
      this.#resize(event);
      return;
    }

    this.#setResizeHover(this.#eventIsOnResizeEdge(event));

    if (!this.#dragState) {
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
      this.#finishResize();
      this.#setResizeHover(this.#eventIsOnResizeEdge(event));
      return;
    }

    if (!this.#dragState) {
      return;
    }

    const drag = this.#dragState;
    this.#dragState = null;
    this.#root.removeAttribute("dragging");
    drag.target?.removeAttribute("dragging");
    this.#hideDropIndicator();

    if (drag.dragging) {
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

  #onWindowPointerDown = event => {
    if (event.button !== 0 || !this.#eventIsOnResizeEdge(event)) {
      return;
    }

    this.#onResizeStart(event);
  };

  #onResizeStart(event) {
    const panelElement = this.#surfaceState?.panelContainer?.querySelector(".browserContainer");
    const width = panelElement?.getBoundingClientRect().width ?? this.#store.width;
    this.#resizeState = {
      startX: event.clientX,
      startWidth: width,
      side: this.#placementSide(),
    };
    this.#setResizeHover(true);
    this.#root.setAttribute("resizing", "true");
  }

  #resize(event) {
    const delta = this.#resizeState.side === "right"
      ? this.#resizeState.startX - event.clientX
      : event.clientX - this.#resizeState.startX;
    const width = this.#clampWidth(this.#resizeState.startWidth + delta);
    this.#root.style.setProperty("--sine-web-panels-width", `${width}px`);
    this.document.documentElement.style.setProperty("--sine-web-panels-width", `${width}px`);
  }

  #finishResize() {
    const width = Number.parseInt(
      this.window.getComputedStyle(this.#root).getPropertyValue("--sine-web-panels-width"),
      10
    );
    this.#store.width = this.#clampWidth(width);
    this.#root.style.setProperty("--sine-web-panels-width", `${this.#store.width}px`);
    this.document.documentElement.style.setProperty("--sine-web-panels-width", `${this.#store.width}px`);
    this.#resizeState = null;
    this.#ignoreOutsideClicksUntil = this.window.performance.now() + 250;
    this.window.requestAnimationFrame(() => {
      this.window.requestAnimationFrame(() => {
        this.#root?.removeAttribute("resizing");
      });
    });
  }

  #clampWidth(width) {
    const maxWidth = this.#panelMaxWidth();
    if (maxWidth === null) {
      // Unmeasurable. Apply the floor and nothing else — inventing a maximum
      // is what put the panel over Zen's sidebar in the first place.
      return Math.max(MIN_PANEL_WIDTH, Math.round(Number(width) || MIN_PANEL_WIDTH));
    }

    return clampWebPanelWidth(width, maxWidth);
  }

  // How wide the panel may get, measured from the content container rather
  // than from window.innerWidth — innerWidth is the whole chrome window and
  // knows nothing about the sidebar Zen paints inside it.
  //
  // Deliberately NOT measured from the selected tab's browser: this mod
  // selects the hidden PANEL tab while a panel is open, so that browser is the
  // panel itself and the measurement would be reading back its own output. The
  // content container is the box #syncChromeLayout already reserves against,
  // it is laid out with the chrome rather than with a tab, and it is the same
  // element whichever tab happens to be selected.
  #panelMaxWidth() {
    let rect = null;
    try {
      rect = this.#findContentContainer()?.getBoundingClientRect?.() ?? null;
    } catch (error) {
      console.error("[Web Panels] Could not measure the page viewport.", error);
    }

    return panelMaxWidthFromViewport(rect, {
      top: 0,
      left: 0,
      width: this.document.documentElement.clientWidth || this.window.innerWidth,
      height: this.document.documentElement.clientHeight || this.window.innerHeight,
    });
  }

  // Clamp for DISPLAY only. Persisting here means a temporarily narrow window
  // (a smaller screen, a tiled layout) permanently shrinks the width the user
  // chose, with no way back once the window grows again.
  #syncDisplayWidth() {
    if (!this.#root) {
      return;
    }

    const width = this.#clampWidth(this.#store.width);
    this.#root.style.setProperty("--sine-web-panels-width", `${width}px`);
    this.document.documentElement.style.setProperty("--sine-web-panels-width", `${width}px`);
  }

  #onWindowResize = () => {
    this.#syncDisplayWidth();
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
    if (
      this.#activeId &&
      this.window.performance.now() >= this.#ignoreOutsideClicksUntil &&
      !event.target.closest(`#${ROOT_ID}`) &&
      !this.#isPointInsideActivePanel(event.clientX, event.clientY)
    ) {
      this.#closePanel();
    }
  };

  #onKeyDown = event => {
    // Chrome is hidden in fullscreen, so the panel shortcuts stay dormant —
    // otherwise Ctrl+Alt+1 would open an invisible panel over the video.
    if (this.#fullscreen) {
      return;
    }

    if (event.key === "Escape") {
      // While the finder is open Escape belongs to it, not to the panel.
      if (this.#finder && !this.#finder.hidden) {
        this.#closeFinder();
        return;
      }
      this.#closeMenu();
      this.#closeEditor();
      this.#closePanel();
      return;
    }

    // Same modifier as the panel numbers, on B — hide or show the rail, the
    // binding editors use for their own sidebar.
    if (shortcutMatches(event, this.#store.shortcutModifier) && event.code === "KeyB") {
      event.preventDefault();
      event.stopPropagation();
      this.#setCollapsed(!this.#collapsed);
      return;
    }

    // Same modifier as the panel numbers, on P — "find a panel".
    if (
      shortcutMatches(event, this.#store.shortcutModifier) &&
      (event.code === "KeyD" || event.code === "KeyP")
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.#openFinder();
      return;
    }

    // Toggle the Nth panel on the rail. Separators are skipped, so the
    // numbering follows the visible panel order rather than the raw item
    // index. The modifier combination is configurable in the mod's settings.
    if (!shortcutMatches(event, this.#store.shortcutModifier)) {
      return;
    }

    const index = panelIndexFromEvent(event);
    if (index < 0) {
      return;
    }

    const target = this.#items.filter(isPanel)[index];
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      this.#togglePanel(target);
    }
  };

  #onTabSelect = () => {
    const selected = this.window.gBrowser?.selectedTab ?? null;
    // The surface, not #activeId: #openSurface selects the panel tab before
    // #openPanel gets to assign #activeId, and the TabSelect lands in between.
    const activePanelTab =
      this.#surfaceState?.panelTab ?? (this.#activeId ? this.#runtime?.get(this.#activeId)?.tab : null);

    // The address bar offers hidden tabs as switch-to-tab candidates —
    // UrlbarProviderOpenTabs does not filter on hidden — so searching for a
    // panel's own site lands the window on that panel's backing tab. There is
    // no way out of that state by hand: the page fills the window with no
    // panel around it, and no panel will open, because opening one needs a
    // visible tab to anchor the overlay to and the selected tab is the panel.
    // Restarting with a panel open used to arrive at the same place.
    //
    // Selecting a backing is only ever legitimate when it is the open panel's
    // own, which #openSurface does deliberately so extensions resolve the
    // panel's site.
    if (selected && selected !== activePanelTab && this.#isPanelTab(selected)) {
      this.#takeSelectionOffPanelTab(selected);
      return;
    }

    if (!this.#activeId) {
      return;
    }

    const selectedTab = selected;
    const panelTab = activePanelTab;
    // The panel tab is intentionally selected while a panel is open.
    if (selectedTab === panelTab) {
      if (this.#activeParentTab && !this.#activeParentTab.closing) {
        this.#activeParentTab._visuallySelected = true;
      }
      this.#keepParentPainted();
      return;
    }

    if (selectedTab && selectedTab !== this.#activeParentTab && !this.#isPanelTab(selectedTab)) {
      this.#closePanel({ animate: false });
    }
  };

  // Hand the window back to a real tab. Nothing more.
  //
  // An earlier version also opened the panel the backing belonged to, on the
  // grounds that picking its site out of the address bar is someone asking for
  // exactly that. It span, because the guard then mistook the panel's own
  // selection for another stray backing (see #onTabSelect) and opened it
  // again, forever. The browser crawled and no panel worked at all.
  //
  // Holding the invariant is the job; guessing intent is not worth a loop.
  // Re-entrancy is blocked too, because correcting the selection is itself a
  // selection change.
  #takeSelectionOffPanelTab(tab) {
    if (this.#correctingSelection) {
      return;
    }

    const replacement = this.#firstOrdinaryTab();
    if (!replacement || replacement === tab) {
      return;
    }

    this.#correctingSelection = true;
    try {
      this.window.gBrowser.selectedTab = replacement;
    } finally {
      this.#correctingSelection = false;
    }
  }

  #onTabClose = event => {
    const tab = event.target;
    const panelId = tab?.getAttribute?.("sine-web-panel-id");
    if (panelId) {
      this.#runtime?.noteTabClosed(panelId);
      if (this.#activeId === panelId) {
        this.#closePanel({ animate: false });
      }
      return;
    }

    if (tab === this.#activeParentTab) {
      this.#closePanel({ animate: false });
    }
  };

  #onTabAttrModified = event => {
    const panelId = event.target?.getAttribute?.("sine-web-panel-id");
    if (!panelId) {
      return;
    }

    this.#syncUnreadFromTab(panelId);
    this.#store.rememberTitle(panelId, event.target.label);
    this.#render();
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
    const tab = this.#currentVisibleTab({ preferContext: true });
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
    return webPanelSideForSidebar(
      this.document.documentElement.getAttribute(ZEN_SIDEBAR_SIDE_ATTRIBUTE)
    );
  }

  #currentTabUrl() {
    const spec = this.#currentVisibleTab()?.linkedBrowser?.currentURI?.spec;
    return normalizeWebPanelUrl(spec) ? spec : "";
  }

  #currentVisibleTab({ preferContext = false } = {}) {
    const contextTab = preferContext ? this.window.TabContextMenu?.contextTab : null;
    const selectedTab = this.window.gBrowser?.selectedTab ?? null;
    const tab = contextTab ?? selectedTab;
    if (tab && !this.#isPanelTab(tab)) {
      return tab;
    }

    if (this.#activeParentTab && !this.#activeParentTab.closing) {
      return this.#activeParentTab;
    }

    // Returning null here is what made every panel refuse to open once the
    // window was sitting on a backing tab: #openSurface needs a parent, and
    // without one it bails. Any ordinary tab will do as an anchor.
    return this.#firstOrdinaryTab();
  }

  // A tab the window can actually show: not one of ours, not on its way out.
  #firstOrdinaryTab() {
    const gBrowser = this.window.gBrowser;
    const tabs = gBrowser?.visibleTabs ?? gBrowser?.tabs ?? [];
    return [...tabs].find(tab => tab && !tab.closing && !this.#isPanelTab(tab)) ?? null;
  }

  #isPanelTab(tab) {
    return tab?.getAttribute?.("sine-web-panel-tab") === "true";
  }

  #openInNewTab(url) {
    if (typeof this.window.openTrustedLinkIn === "function") {
      this.window.openTrustedLinkIn(url, "tab", {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return;
    }
    this.window.gBrowser?.addTrustedTab?.(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
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

// Sine loads this into a chrome window, where `window` is a global and mounting
// on import is the point. A test runner has no such window, and importing the
// class there must not try to build a browser UI — so the bootstrap asks first
// rather than assuming, which is what makes the controller testable at all.
const chromeWindow = typeof window === "undefined" ? null : window;

if (chromeWindow?.document) {
  const instance = new SineWebPanels(chromeWindow);
  instance.init();

  if (typeof chromeWindow.addUnloadListener === "function") {
    chromeWindow.addUnloadListener(() => instance.destroy());
  } else {
    chromeWindow.addEventListener("unload", () => instance.destroy(), { once: true });
  }
}
