// A DOM attribute does not survive a restart — SessionStore persists only what
// it is told to keep — so the tab that comes back has none of our marks and
// reads as an ordinary tab. A custom tab value does survive, and carries the
// panel id, which is what lets a restored tab be matched back to its panel.
const PANEL_SESSION_KEY = "sineWebPanelBacking";
const PANEL_TAB_ATTRIBUTE = "sine-web-panel-tab";
const PANEL_ID_ATTRIBUTE = "sine-web-panel-id";
const TAB_HIDE_OWNER = "sine-web-panels";

// skipSessionStore so closing a panel does not push it into the recently-closed
// tabs list, where it would look like something the user lost.
const TAB_REMOVAL_OPTIONS = Object.freeze({
  animate: false,
  skipPermitUnload: true,
  skipSessionStore: true,
});

export class WebPanelsRuntime {
  #window;
  #panels = new Map();

  constructor(windowRef) {
    this.#window = windowRef;
  }

  get(id) {
    return this.#panels.get(id) ?? null;
  }

  getBrowser(itemOrId) {
    const id = typeof itemOrId === "string" ? itemOrId : itemOrId?.id;
    return this.#panels.get(id)?.tab?.linkedBrowser ?? null;
  }

  ensurePanelTab(item, parentTab = null, url = null) {
    const existing = this.#panels.get(item.id) ?? {};
    if (existing.tab && !existing.tab.closing) {
      existing.item = item;
      existing.parentTab = parentTab;
      this.#setParentTabAttribute(existing.tab, parentTab);
      this.#panels.set(item.id, existing);
      return existing.tab;
    }

    const tab = this.#createPanelTab(item, url ?? item.url);
    this.#claimTab(tab, item, parentTab);
    return tab;
  }

  // Take a tab that came back from session restore and make it this panel's
  // backing again, instead of leaving it loose in the tab strip while a second
  // one gets created beside it.
  //
  // Adopting rather than deleting is deliberate. Sweeping would mean removing
  // tabs automatically at startup on the strength of a marker, and one false
  // positive there destroys a real tab with nothing to show for it. Adoption
  // fails softly: the worst case is a tab that gets hidden and then appears in
  // the rail, which is visible and reversible. Tabs that cannot be adopted —
  // their panel is gone from the rail — are still swept, since nothing can
  // ever surface them again.
  adoptRestoredTabs(items = []) {
    const wanted = new Map(items.filter(item => item?.id).map(item => [item.id, item]));
    const adopted = [];
    const swept = [];

    for (const tab of this.#allTabs()) {
      if (!tab || tab.closing) {
        continue;
      }

      const panelId = this.#backingPanelId(tab);
      if (!panelId) {
        continue;
      }

      const item = wanted.get(panelId);
      const live = this.#panels.get(panelId)?.tab;
      if (!item || (live && live !== tab)) {
        this.#removeTab(tab);
        swept.push(panelId);
        continue;
      }

      if (this.#claimTab(tab, item, this.#panels.get(panelId)?.parentTab ?? null)) {
        adopted.push(panelId);
      }
    }

    return { adopted, swept };
  }

  noteTabClosed(itemId) {
    const runtime = this.#panels.get(itemId);
    if (!runtime) {
      return;
    }
    delete runtime.tab;
    this.#panels.set(itemId, runtime);
  }

  unload(id) {
    const runtime = this.#panels.get(id);
    if (!runtime) {
      return;
    }

    if (runtime.tab && !runtime.tab.closing) {
      this.#removeTab(runtime.tab);
    }
    this.#panels.delete(id);
  }

  unloadMissing(itemIds) {
    const currentIds = new Set(itemIds);
    for (const id of this.#panels.keys()) {
      if (!currentIds.has(id)) {
        this.unload(id);
      }
    }
  }

  destroy() {
    for (const id of [...this.#panels.keys()]) {
      this.unload(id);
    }
    this.#window = null;
  }

  #claimTab(tab, item, parentTab = null) {
    // Opening a panel selects its tab, so that is the state the session is
    // saved in and the state it is restored in. Zen's hideTab returns early on
    // the selected tab — silently, no error — so hiding without checking
    // leaves the window sitting on a panel backing displayed as an ordinary
    // tab. From there nothing works: opening any panel needs a visible tab to
    // anchor the overlay to, and the selected one is the panel itself.
    if (!this.#releaseSelection(tab)) {
      return false;
    }

    tab.owner = null;
    tab.setAttribute(PANEL_TAB_ATTRIBUTE, "true");
    tab.setAttribute(PANEL_ID_ATTRIBUTE, item.id);
    this.#setParentTabAttribute(tab, parentTab);
    this.#markBackingTab(tab, item.id);

    this.#window.gBrowser.hideTab?.(tab, TAB_HIDE_OWNER);
    this.#panels.set(item.id, { item, parentTab, tab });
    return true;
  }

  // Hands the selection to an ordinary tab if this one holds it. False when
  // there is nothing to hand it to — the one case where hiding would strand
  // the window on a tab it cannot show, so the caller leaves the tab alone
  // instead.
  #releaseSelection(tab) {
    const gBrowser = this.#window?.gBrowser;
    if (!gBrowser || gBrowser.selectedTab !== tab) {
      return true;
    }

    const replacement = this.#allTabs().find(
      candidate => candidate !== tab && !candidate.closing && !this.#backingPanelId(candidate)
    );
    if (!replacement) {
      console.warn(
        "[Web Panels] A panel tab holds the selection and there is no other tab " +
          "to move it to, so it stays visible rather than stranding the window."
      );
      return false;
    }

    gBrowser.selectedTab = replacement;
    return true;
  }

  #allTabs() {
    // A snapshot: sweeping mutates the live collection while we walk it.
    return [...(this.#window?.gBrowser?.tabs ?? [])];
  }

  #removeTab(tab) {
    this.#window?.gBrowser?.removeTab?.(tab, TAB_REMOVAL_OPTIONS);
  }

  // The session value is the one that survives a restart, so it is asked first;
  // the attribute answers for tabs this session created.
  #backingPanelId(tab) {
    const sessionStore = this.#window?.SessionStore;
    if (typeof sessionStore?.getCustomTabValue === "function") {
      try {
        const stored = sessionStore.getCustomTabValue(tab, PANEL_SESSION_KEY);
        if (stored) {
          return stored;
        }
      } catch (error) {
        console.error("[Web Panels] Could not read a tab's panel marker.", error);
      }
    }

    return tab?.getAttribute?.(PANEL_ID_ATTRIBUTE) || null;
  }

  #markBackingTab(tab, panelId) {
    const sessionStore = this.#window?.SessionStore;
    if (typeof sessionStore?.setCustomTabValue !== "function") {
      return;
    }

    try {
      sessionStore.setCustomTabValue(tab, PANEL_SESSION_KEY, panelId);
    } catch (error) {
      console.error("[Web Panels] Could not mark a panel tab for session restore.", error);
    }
  }

  #createPanelTab(item, url) {
    const options = {
      inBackground: true,
      skipAnimation: true,
      skipBackgroundNotify: true,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    };

    if (typeof this.#window.gBrowser.addTrustedTab === "function") {
      return this.#window.gBrowser.addTrustedTab(url, options);
    }

    return this.#window.gBrowser.addTab(url, options);
  }

  #setParentTabAttribute(tab, parentTab) {
    if (parentTab?.id) {
      tab.setAttribute("sine-web-panel-parent-id", parentTab.id);
      return;
    }

    tab.removeAttribute("sine-web-panel-parent-id");
  }
}
