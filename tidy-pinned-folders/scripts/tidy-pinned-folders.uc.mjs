import {
  collapsePinnedFolders,
  getPinnedActiveFolderRoots,
  getPinnedActiveTabsToUnload,
  getPinnedFolderDescendants,
  getPinnedFolderForTab,
  getPinnedFolderToUnload,
  getPinnedFolderUnloadController,
  getPinnedFoldersToCollapse,
  getPinnedFoldersToCollapseForSelection,
  isPinnedZenFolder,
} from "./tidy-pinned-folders-core.uc.mjs";

const INSTANCE_KEY = "__sineTidyPinnedFolders";
const LOG_PREFIX = "[Tidy Pinned Folders]";
const COLLAPSE_CHILDREN_PREF =
  "sine.tidy-pinned-folders.collapse-children-with-parent";

export class SineTidyPinnedFolders {
  #abortController = new AbortController();
  #pendingFrames = new Set();
  #selectedTab;

  constructor(windowRef, preferences = Services.prefs) {
    this.window = windowRef;
    this.preferences = preferences;
    this.#selectedTab = windowRef.gBrowser?.selectedTab ?? null;
  }

  init() {
    this.window.addEventListener("TabGroupExpand", this.#onFolderExpand, {
      signal: this.#abortController.signal,
    });
    this.window.addEventListener("TabGroupCollapse", this.#onFolderCollapse, {
      signal: this.#abortController.signal,
    });
    this.window.addEventListener("TabSelect", this.#onTabSelect, {
      capture: true,
      signal: this.#abortController.signal,
    });
  }

  destroy() {
    this.#abortController.abort();

    for (const frameId of this.#pendingFrames) {
      this.window.cancelAnimationFrame(frameId);
    }
    this.#pendingFrames.clear();
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
      !this.preferences.getBoolPref(COLLAPSE_CHILDREN_PREF, true)
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
    const previousTab = this.#selectedTab;
    const previousFolder = getPinnedFolderForTab(previousTab);
    this.#selectedTab = selectedTab;

    const frameId = this.window.requestAnimationFrame(() => {
      this.#pendingFrames.delete(frameId);
      return this.#tidyAfterTabSelection(
        selectedTab,
        previousTab,
        previousFolder
      );
    });
    this.#pendingFrames.add(frameId);
  };

  async #tidyAfterTabSelection(selectedTab, previousTab, previousFolder) {
    if (this.#abortController.signal.aborted) {
      return;
    }

    try {
      const pinnedFolders = Array.from(
        this.window.document.querySelectorAll("zen-folder")
      ).filter(isPinnedZenFolder);
      const foldersToCollapse = getPinnedFoldersToCollapseForSelection(
        selectedTab,
        pinnedFolders,
        previousFolder
      );
      const activeFolderRoots = getPinnedActiveFolderRoots(foldersToCollapse);
      const previousFolderToUnload = getPinnedFolderToUnload(
        previousFolder,
        selectedTab
      );
      const folderRootsToUnload = [
        ...new Set(
          [previousFolderToUnload, ...activeFolderRoots].filter(Boolean)
        ),
      ];
      const activeTabs = Array.from(
        this.window.document.querySelectorAll("[folder-active]")
      );
      const tabsToUnload = getPinnedActiveTabsToUnload(selectedTab, [
        ...new Set([previousTab, ...activeTabs].filter(Boolean)),
      ]);
      const unloadController = getPinnedFolderUnloadController(this.window);
      collapsePinnedFolders(foldersToCollapse);

      if ((folderRootsToUnload.length || tabsToUnload.length) && !unloadController) {
        console.error(`${LOG_PREFIX} Zen folder unload API is unavailable.`);
      } else if (
        folderRootsToUnload.length &&
        typeof unloadController?.animateUnloadAll === "function"
      ) {
        for (const activeFolder of folderRootsToUnload) {
          if (this.#abortController.signal.aborted) {
            return;
          }

          try {
            await unloadController.animateUnloadAll(activeFolder);
          } catch (error) {
            console.error(
              `${LOG_PREFIX} Could not hide a stale active folder:`,
              error
            );
          }
        }
      } else {
        for (const activeTab of tabsToUnload) {
          if (this.#abortController.signal.aborted) {
            return;
          }

          try {
            await unloadController.animateUnload(
              getPinnedFolderForTab(activeTab),
              activeTab
            );
          } catch (error) {
            console.error(
              `${LOG_PREFIX} Could not hide a stale active tab:`,
              error
            );
          }
        }
      }
    } catch (error) {
      console.error(
        `${LOG_PREFIX} Could not tidy folders after tab selection:`,
        error
      );
    }
  }
}

export function installSineTidyPinnedFolders(
  windowRef,
  preferences = Services.prefs
) {
  windowRef[INSTANCE_KEY]?.destroy();

  const mod = new SineTidyPinnedFolders(windowRef, preferences);
  mod.init();
  windowRef[INSTANCE_KEY] = mod;

  let destroyed = false;
  return () => {
    if (destroyed) {
      return;
    }

    destroyed = true;
    mod.destroy();
    if (windowRef[INSTANCE_KEY] === mod) {
      delete windowRef[INSTANCE_KEY];
    }
  };
}
