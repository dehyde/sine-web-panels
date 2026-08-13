import { WebPanelsRuntime } from "./web-panels-runtime.uc.mjs";
import {
  MIN_PANEL_WIDTH,
  PANEL_TYPE,
  SEPARATOR_TYPE,
  WebPanelsStore,
  normalizeWebPanelUrl,
  parseWebPanelUnreadCount,
} from "./web-panels-store.uc.mjs";

const ROOT_ID = "sine-web-panels-root";
const RAIL_ID = "sine-web-panels-rail";
const LIST_ID = "sine-web-panels-list";
const ADD_BUTTON_ID = "sine-web-panels-add-button";
const BACKDROP_ID = "sine-web-panels-backdrop";
const MENU_ID = "sine-web-panels-menu";
const EDITOR_ID = "sine-web-panels-editor";
const TAB_MENU_ITEM_ID = "sine-web-panels-tab-context-add";
const RESIZER_ID = "sine-web-panels-resizer";

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

class SineWebPanels {
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
  #resizeState = null;
  #resizeHovering = false;
  #dragState = null;

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
    if (this.#closeTimer) {
      this.window.clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
    this.#setResizeHover(false);
    this.#closeSurface({ selectParent: false });
    if (this.#prefObserver) {
      Services.prefs.removeObserver(WebPanelsStore.prefs.enabled, this.#prefObserver);
    }
    this.#runtime?.destroy();
    this.#resetChromeLayout();
    this.#editor?.remove();
    this.#tabContextMenuItem?.remove();
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
    this.#root.style.setProperty("--sine-web-panels-width", `${this.#store.width}px`);
    this.document.documentElement.style.setProperty("--sine-web-panels-width", `${this.#store.width}px`);

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

    this.#root.append(this.#backdrop, this.#rail, this.#menu);
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
    this.#rail.addEventListener("contextmenu", this.#onRailContextMenu, { signal });
    this.window.addEventListener("pointerdown", this.#onWindowPointerDown, { signal, capture: true });
    this.window.addEventListener("pointermove", this.#onPointerMove, { signal });
    this.window.addEventListener("pointerup", this.#onPointerUp, { signal });
    this.window.addEventListener("resize", this.#onWindowResize, { signal });
    this.document.addEventListener("click", this.#onDocumentClick, { signal });
    this.document.addEventListener("keydown", this.#onKeyDown, { signal });
    this.window.gBrowser?.tabContainer?.addEventListener("TabSelect", this.#onTabSelect, { signal });
    this.window.gBrowser?.tabContainer?.addEventListener("TabClose", this.#onTabClose, { signal });
    this.window.gBrowser?.tabContainer?.addEventListener("TabAttrModified", this.#onTabAttrModified, { signal });
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

    this.#closePanel({ animate: false });
    this.#runtime?.destroy();
    this.#runtime = new WebPanelsRuntime(this.window);
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
    this.#browserChrome?.removeAttribute("sine-web-panels-side");
    this.document?.documentElement?.removeAttribute("sine-web-panels-side");
    this.document?.documentElement?.style.removeProperty("--sine-web-panels-width");
    this.#browserChrome?.style.removeProperty("--sine-web-panels-reserved-inline-size");
    this.#contentContainer?.style.removeProperty("margin-inline-start");
    this.#contentContainer?.style.removeProperty("margin-inline-end");
    this.#contentContainer = null;
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
    this.#closeEditor();
    if (this.#closeTimer) {
      this.window.clearTimeout(this.#closeTimer);
      this.#closeTimer = null;
    }
    const switching = Boolean(this.#activeId && this.#activeId !== item.id);
    const parentTab = this.#currentVisibleTab() ?? this.#activeParentTab;
    const panelTab = this.#runtime.ensurePanelTab(item, parentTab);
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
    panelFrame.append(this.#resizer);
    panelBrowser.setAttribute("sine-web-panel-selected", "true");
    parentBrowser.zenModeActive = true;
    parentBrowser.docShellIsActive = true;
    panelBrowser.zenModeActive = true;
    panelBrowser.docShellIsActive = true;
    // Select the PANEL tab, not the parent. WebExtensions resolve context via
    // tabs.query({active:true}); with the parent selected, password managers
    // offer credentials for the page BEHIND the panel instead of the panel's
    // own site. The parent stays _visuallySelected so the sidebar still
    // highlights it, which is what the original behaviour was really after.
    if (this.window.gBrowser && this.window.gBrowser.selectedTab !== panelTab) {
      this.window.gBrowser.selectedTab = panelTab;
    }
    if (parentTab) {
      parentTab._visuallySelected = true;
    }
    this.#surfaceState = {
      parentTab,
      panelTab,
      parentBrowser,
      panelBrowser,
      parentContainer,
      panelContainer,
      panelFrame,
    };
    return true;
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
      this.#render();
    };
    browser.addEventListener("DOMTitleChanged", update, { signal: this.#abortController.signal });
    browser.addEventListener("load", update, { signal: this.#abortController.signal });
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
        this.#unloadPanel(updated.id);
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
    const railRect = this.#rail.getBoundingClientRect();
    const gap = Number.parseFloat(this.window.getComputedStyle(this.#root).getPropertyValue("--sine-web-panels-gap")) || 8;
    const max = Math.max(MIN_PANEL_WIDTH, this.window.innerWidth - railRect.width - gap * 3);
    return Math.min(max, Math.max(MIN_PANEL_WIDTH, Math.round(width)));
  }

  #onWindowResize = () => {
    const width = this.#clampWidth(this.#store.width);
    this.#store.width = width;
    this.#root.style.setProperty("--sine-web-panels-width", `${width}px`);
    this.document.documentElement.style.setProperty("--sine-web-panels-width", `${width}px`);
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
    if (event.key === "Escape") {
      this.#closeMenu();
      this.#closeEditor();
      this.#closePanel();
    }
  };

  #onTabSelect = () => {
    if (!this.#activeId) {
      return;
    }

    const selectedTab = this.window.gBrowser?.selectedTab;
    const panelTab = this.#runtime?.get(this.#activeId)?.tab;
    // The panel tab is intentionally the selected tab while a panel is open,
    // so do not bounce selection back to the parent.
    if (selectedTab === panelTab) {
      if (this.#activeParentTab && !this.#activeParentTab.closing) {
        this.#activeParentTab._visuallySelected = true;
      }
      return;
    }

    if (selectedTab && selectedTab !== this.#activeParentTab && !this.#isPanelTab(selectedTab)) {
      this.#closePanel({ animate: false });
    }
  };

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
    return this.document.documentElement.getAttribute("zen-right-side") === "true" ? "left" : "right";
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

    return null;
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

const instance = new SineWebPanels(window);
instance.init();

if (typeof window.addUnloadListener === "function") {
  window.addUnloadListener(() => instance.destroy());
} else {
  window.addEventListener("unload", () => instance.destroy(), { once: true });
}
