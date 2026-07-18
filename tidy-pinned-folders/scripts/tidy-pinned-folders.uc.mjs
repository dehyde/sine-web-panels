import {
  collapsePinnedFolders,
  getPinnedActiveTabsToUnload,
  getPinnedFolderDescendants,
  getPinnedFolderForTab,
  getPinnedFolderUnloadController,
  getPinnedFoldersToCollapse,
  getPinnedFoldersToCollapseForSelection,
  isPinnedZenFolder,
} from "./tidy-pinned-folders-core.uc.mjs";

const INSTANCE_KEY = "__sineTidyPinnedFolders";
const LOG_PREFIX = "[Tidy Pinned Folders]";
const COLLAPSE_CHILDREN_PREF =
  "sine.tidy-pinned-folders.collapse-children-with-parent";

class SineTidyPinnedFolders {
  #abortController = new AbortController();

  constructor(windowRef) {
    this.window = windowRef;
  }

  init() {
    this.window.addEventListener("TabGroupExpand", this.#onFolderExpand, {
      signal: this.#abortController.signal,
    });
    this.window.addEventListener("TabGroupCollapse", this.#onFolderCollapse, {
      signal: this.#abortController.signal,
    });
    this.window.addEventListener("TabSelect", this.#onTabSelect, {
      signal: this.#abortController.signal,
    });
  }

  destroy() {
    this.#abortController.abort();
  }

  #onFolderExpand = event => {
    const openedFolder = event.target;
    if (!isPinnedZenFolder(openedFolder)) {
      return;
    }

    try {
      collapsePinnedFolders(getPinnedFoldersToCollapse(openedFolder));
    } catch (error) {
      console.error(`${LOG_PREFIX} Could not collapse sibling folders:`, error);
    }
  };

  #onFolderCollapse = event => {
    const closedFolder = event.target;
    if (
      !isPinnedZenFolder(closedFolder) ||
      !Services.prefs.getBoolPref(COLLAPSE_CHILDREN_PREF, true)
    ) {
      return;
    }

    try {
      collapsePinnedFolders(getPinnedFolderDescendants(closedFolder));
    } catch (error) {
      console.error(LOG_PREFIX + " Could not collapse child folders:", error);
    }
  };

  #onTabSelect = event => {
    const selectedTab = event.target;

    this.window.requestAnimationFrame(async () => {
      try {
        const activeTabs = Array.from(
          this.window.document.querySelectorAll(
            ".tabbrowser-tab[folder-active]"
          )
        );
        const tabsToUnload = getPinnedActiveTabsToUnload(
          selectedTab,
          activeTabs
        );
        const unloadController = getPinnedFolderUnloadController(this.window);

        if (tabsToUnload.length && !unloadController) {
          console.error(`${LOG_PREFIX} Zen folder unload API is unavailable.`);
        } else {
          for (const activeTab of tabsToUnload) {
            try {
              await unloadController.animateUnload(
                getPinnedFolderForTab(activeTab),
                activeTab
              );
            } catch (error) {
              console.error(`${LOG_PREFIX} Could not hide a stale active tab:`, error);
            }
          }
        }

        const pinnedFolders = Array.from(
          this.window.document.querySelectorAll("zen-folder")
        ).filter(isPinnedZenFolder);
        collapsePinnedFolders(
          getPinnedFoldersToCollapseForSelection(selectedTab, pinnedFolders)
        );
      } catch (error) {
        console.error(
          `${LOG_PREFIX} Could not tidy folders after tab selection:`,
          error
        );
      }
    });
  };
}

window[INSTANCE_KEY]?.destroy();

const mod = new SineTidyPinnedFolders(window);
mod.init();
window[INSTANCE_KEY] = mod;

const destroy = () => {
  mod.destroy();
  if (window[INSTANCE_KEY] === mod) {
    delete window[INSTANCE_KEY];
  }
};

if (typeof window.addUnloadListener === "function") {
  window.addUnloadListener(destroy);
} else {
  window.addEventListener("unload", destroy, { once: true });
}
