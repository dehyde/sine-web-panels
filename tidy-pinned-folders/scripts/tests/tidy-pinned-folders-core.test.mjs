import assert from "node:assert/strict";
import test from "node:test";

import {
  collapsePinnedFolders,
  getPinnedActiveFolderRoots,
  getPinnedActiveTabsToUnload,
  getPinnedFolderAncestors,
  getPinnedFolderDescendants,
  getPinnedFolderForTab,
  getPinnedFolderToUnload,
  getPinnedFolderToUnloadForSelection,
  getPinnedFolderSiblings,
  getPinnedFolderUnloadController,
  getPinnedFoldersToCollapse,
  getPinnedFoldersToCollapseForSelection,
  isPinnedZenFolder,
  shouldUnloadPreviousPinnedTab,
} from "../tidy-pinned-folders-core.uc.mjs";
import {
  installSineTidyPinnedFolders,
} from "../tidy-pinned-folders.uc.mjs";

function folder({ active = false, collapsed = false, pinned = true } = {}) {
  const attributes = new Set(active ? ["has-active"] : []);
  return {
    isZenFolder: true,
    pinned,
    collapsed,
    group: null,
    parentElement: { children: [] },
    querySelectorAll() {
      return [];
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
  };
}

function addSiblings(...folders) {
  const parent = { children: folders };
  for (const item of folders) {
    item.parentElement = parent;
  }
}

function createWindow() {
  const listeners = new Map();
  const listenerOptions = new Map();
  const frames = new Map();
  let nextFrameId = 1;

  return {
    frames,
    listeners,
    listenerOptions,
    document: {
      querySelectorAll() {
        return [];
      },
    },
    addEventListener(type, listener, options = {}) {
      listeners.set(type, listener);
      listenerOptions.set(type, options);
      options.signal?.addEventListener(
        "abort",
        () => {
          listeners.delete(type);
          listenerOptions.delete(type);
        },
        { once: true }
      );
    },
    requestAnimationFrame(callback) {
      const frameId = nextFrameId++;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelAnimationFrame(frameId) {
      frames.delete(frameId);
    },
    dispatch(type, target) {
      listeners.get(type)?.({ target });
    },
  };
}

const preferences = {
  getBoolPref() {
    return true;
  },
};

test("recognizes native pinned Zen folders only", () => {
  assert.equal(isPinnedZenFolder(folder()), true);
  assert.equal(isPinnedZenFolder(folder({ pinned: false })), false);
  assert.equal(isPinnedZenFolder({ isZenFolder: false, pinned: true }), false);
  assert.equal(isPinnedZenFolder(null), false);
});

test("finds direct pinned-folder siblings", () => {
  const current = folder();
  const sibling = folder();
  const unpinned = folder({ pinned: false });
  addSiblings(current, sibling, unpinned);

  assert.deepEqual(getPinnedFolderSiblings(current), [sibling]);
});

test("keeps the opened folder and every parent folder in its path", () => {
  const root = folder();
  const child = folder();
  const grandchild = folder();
  child.group = root;
  grandchild.group = child;

  assert.deepEqual(getPinnedFolderAncestors(grandchild), [grandchild, child, root]);
});

test("collapses open siblings at every level of the opened folder path", () => {
  const root = folder();
  const rootSibling = folder();
  const child = folder();
  const childSibling = folder();
  const grandchild = folder();
  const grandchildSibling = folder({ collapsed: true });

  addSiblings(root, rootSibling);
  addSiblings(child, childSibling);
  addSiblings(grandchild, grandchildSibling);
  child.group = root;
  grandchild.group = child;

  assert.deepEqual(getPinnedFoldersToCollapse(grandchild), [childSibling, rootSibling]);
});

test("does not collapse folders that are already closed", () => {
  const current = folder();
  const closedSibling = folder({ collapsed: true });
  addSiblings(current, closedSibling);

  assert.deepEqual(getPinnedFoldersToCollapse(current), []);
});

test("keeps the selected tab's pinned-folder path open", () => {
  const root = folder();
  const rootSibling = folder();
  const child = folder();
  const childSibling = folder();
  const selectedTab = { group: child };
  child.group = root;

  assert.equal(getPinnedFolderForTab(selectedTab), child);
  assert.deepEqual(
    getPinnedFoldersToCollapseForSelection(selectedTab, [
      root,
      rootSibling,
      child,
      childSibling,
    ]),
    [rootSibling, childSibling]
  );
});

test("collapses a previous parent around the newly selected child path", () => {
  const parentFolder = folder();
  const childFolder = folder();
  const unrelatedFolder = folder();
  childFolder.group = parentFolder;
  const selectedTab = { group: childFolder };

  assert.deepEqual(
    getPinnedFoldersToCollapseForSelection(
      selectedTab,
      [parentFolder, childFolder, unrelatedFolder],
      parentFolder
    ),
    [parentFolder, unrelatedFolder]
  );
});

test("collapses all pinned folders when selecting a regular tab", () => {
  const first = folder();
  const second = folder();
  const unpinned = folder({ pinned: false });

  assert.equal(getPinnedFolderForTab({ group: unpinned }), null);
  assert.deepEqual(
    getPinnedFoldersToCollapseForSelection({ group: null }, [
      first,
      second,
      unpinned,
    ]),
    [first, second]
  );
});

test("unloads the previous active tab from a collapsed pinned folder", () => {
  const pinnedFolder = folder();
  const previousTab = {
    group: pinnedFolder,
    hasAttribute(name) {
      return name === "folder-active";
    },
  };
  const selectedTab = { group: null };

  assert.equal(
    shouldUnloadPreviousPinnedTab(previousTab, selectedTab),
    true
  );
  assert.equal(
    shouldUnloadPreviousPinnedTab(previousTab, previousTab),
    false
  );
  assert.equal(
    shouldUnloadPreviousPinnedTab(
      { group: pinnedFolder, hasAttribute: () => false },
      selectedTab
    ),
    false
  );
});

test("unloads the previous folder when selection moves outside its path", () => {
  const root = folder({ collapsed: true });
  const previousFolder = folder();
  const selectedFolder = folder();
  previousFolder.group = root;
  previousFolder.rootMostCollapsedFolder = root;

  assert.equal(
    getPinnedFolderToUnload(previousFolder, { group: selectedFolder }),
    root
  );
  assert.equal(
    getPinnedFolderToUnloadForSelection(
      { group: previousFolder },
      { group: selectedFolder }
    ),
    root
  );
  assert.equal(
    getPinnedFolderToUnloadForSelection(
      { group: previousFolder },
      { group: previousFolder }
    ),
    null
  );
  assert.equal(
    getPinnedFolderToUnloadForSelection(
      { group: root },
      { group: previousFolder }
    ),
    null
  );
});

test("finds every stale active tab outside the current selection", () => {
  const firstFolder = folder();
  const secondFolder = folder();
  const activeTab = group => ({
    group,
    hasAttribute(name) {
      return name === "folder-active";
    },
  });
  const selectedTab = activeTab(secondFolder);
  const staleFirst = activeTab(firstFolder);
  const staleSecond = activeTab(firstFolder);
  const inactiveTab = {
    group: firstFolder,
    hasAttribute() {
      return false;
    },
  };

  assert.deepEqual(
    getPinnedActiveTabsToUnload(selectedTab, [
      staleFirst,
      selectedTab,
      staleSecond,
      inactiveTab,
    ]),
    [staleFirst, staleSecond]
  );
});

test("finds only the highest active folder roots to unload", () => {
  const root = folder({ active: true });
  const child = folder({ active: true });
  const sibling = folder({ active: true });
  const inactive = folder();
  child.group = root;

  assert.deepEqual(
    getPinnedActiveFolderRoots([root, child, sibling, inactive]),
    [root, sibling]
  );
});

test("uses the current Zen folder controller and supports the legacy API", () => {
  const currentController = { animateUnloadAll() {} };
  const legacyController = { animateUnload() {} };

  assert.equal(
    getPinnedFolderUnloadController({
      gZenFolders: currentController,
      gZenLiveFoldersUI: legacyController,
    }),
    currentController
  );
  assert.equal(
    getPinnedFolderUnloadController({
      gZenLiveFoldersUI: legacyController,
    }),
    legacyController
  );
  assert.equal(
    getPinnedFolderUnloadController({
      gZenFolders: {},
      gZenLiveFoldersUI: {},
    }),
    null
  );
});

test("resolves a pinned folder through a split-view group", () => {
  const pinnedFolder = folder();
  const splitViewGroup = {
    group: pinnedFolder,
    hasAttribute(name) {
      return name === "split-view-group";
    },
  };

  assert.equal(getPinnedFolderForTab({ group: splitViewGroup }), pinnedFolder);
});

test("resolves a group-less tab through native folder membership", () => {
  const pinnedFolder = folder();
  const unrelatedFolder = folder();
  const tab = {
    group: null,
    ownerDocument: {
      querySelectorAll() {
        return [unrelatedFolder, pinnedFolder];
      },
    },
  };
  unrelatedFolder.tabs = [];
  pinnedFolder.tabs = [tab];

  assert.equal(getPinnedFolderForTab(tab), pinnedFolder);
});

test("finds all pinned child folders below a parent", () => {
  const parent = folder();
  const child = folder();
  const grandchild = folder();
  const unpinned = folder({ pinned: false });
  parent.querySelectorAll = () => [child, grandchild, unpinned];

  assert.deepEqual(getPinnedFolderDescendants(parent), [child, grandchild]);
});

test("does not find child folders for a non-pinned folder", () => {
  const unpinned = folder({ pinned: false });
  unpinned.querySelectorAll = () => [folder()];

  assert.deepEqual(getPinnedFolderDescendants(unpinned), []);
});

test("closes only the supplied folders", () => {
  const first = folder();
  const second = folder();
  const untouched = folder();

  collapsePinnedFolders([first, second]);

  assert.equal(first.collapsed, true);
  assert.equal(second.collapsed, true);
  assert.equal(untouched.collapsed, false);
});

test("unload removes every listener, pending frame, and singleton", () => {
  const windowRef = createWindow();
  const unload = installSineTidyPinnedFolders(windowRef, preferences);

  assert.deepEqual(
    [...windowRef.listeners.keys()],
    ["TabGroupExpand", "TabGroupCollapse", "TabSelect"]
  );
  assert.ok(windowRef.__sineTidyPinnedFolders);
  assert.equal(windowRef.listenerOptions.get("TabSelect").capture, true);
  windowRef.dispatch("TabSelect", { group: null });
  assert.equal(windowRef.frames.size, 1);

  unload();

  assert.equal(windowRef.listeners.size, 0);
  assert.equal(windowRef.listenerOptions.size, 0);
  assert.equal(windowRef.frames.size, 0);
  assert.equal(windowRef.__sineTidyPinnedFolders, undefined);
  assert.doesNotThrow(unload);
});

test("keeps every rapid tab selection pending until it is processed", () => {
  const windowRef = createWindow();
  let folderQueries = 0;
  windowRef.document.querySelectorAll = selector => {
    if (selector === "zen-folder") {
      folderQueries += 1;
    }
    return [];
  };
  const unload = installSineTidyPinnedFolders(windowRef, preferences);

  windowRef.dispatch("TabSelect", { group: null });
  windowRef.dispatch("TabSelect", { group: null });

  assert.equal(windowRef.frames.size, 2);
  for (const pendingFrame of [...windowRef.frames.values()]) {
    pendingFrame();
  }
  assert.equal(folderQueries, 2);

  unload();
});

test("unloads a stale active folder after selecting another folder tab", async () => {
  const windowRef = createWindow();
  const staleFolder = folder({ active: true });
  const selectedFolder = folder();
  const selectedTab = { group: selectedFolder };
  const unloadedFolders = [];

  windowRef.document.querySelectorAll = selector => {
    if (selector === "zen-folder") {
      return [staleFolder, selectedFolder];
    }
    return [];
  };
  windowRef.gZenFolders = {
    async animateUnloadAll(activeFolder) {
      unloadedFolders.push(activeFolder);
    },
  };

  const unload = installSineTidyPinnedFolders(windowRef, preferences);
  windowRef.dispatch("TabSelect", selectedTab);
  const pendingFrame = [...windowRef.frames.values()][0];
  await pendingFrame();

  assert.deepEqual(unloadedFolders, [staleFolder]);
  assert.equal(staleFolder.collapsed, true);
  assert.equal(selectedFolder.collapsed, false);

  unload();
});

test("falls back to unloading a stale tab before its folder becomes active", async () => {
  const windowRef = createWindow();
  const staleFolder = folder();
  const selectedFolder = folder();
  const staleTab = {
    group: staleFolder,
    hasAttribute(name) {
      return name === "folder-active";
    },
  };
  const selectedTab = { group: selectedFolder };
  const unloadedTabs = [];

  windowRef.document.querySelectorAll = selector => {
    if (selector === "zen-folder") {
      return [staleFolder, selectedFolder];
    }
    if (selector === "[folder-active]") {
      return [staleTab];
    }
    return [];
  };
  windowRef.gZenFolders = {
    async animateUnload() {
      unloadedTabs.push(staleTab);
    },
    async animateUnloadAll() {
      assert.fail("folder-wide unload should wait for an active folder");
    },
  };

  const unload = installSineTidyPinnedFolders(windowRef, preferences);
  windowRef.dispatch("TabSelect", selectedTab);
  const pendingFrame = [...windowRef.frames.values()][0];
  await pendingFrame();

  assert.deepEqual(unloadedTabs, [staleTab]);

  unload();
});

test("unloads the previously selected folder without an active marker", async () => {
  const windowRef = createWindow();
  const previousFolder = folder();
  const selectedFolder = folder();
  const previousTab = { group: previousFolder };
  const selectedTab = { group: selectedFolder };
  const unloadedFolders = [];

  windowRef.gBrowser = { selectedTab: previousTab };
  windowRef.document.querySelectorAll = selector =>
    selector === "zen-folder" ? [previousFolder, selectedFolder] : [];
  windowRef.gZenFolders = {
    async animateUnloadAll(folderToUnload) {
      unloadedFolders.push(folderToUnload);
    },
  };

  const unload = installSineTidyPinnedFolders(windowRef, preferences);
  windowRef.dispatch("TabSelect", selectedTab);
  const pendingFrame = [...windowRef.frames.values()][0];
  await pendingFrame();

  assert.deepEqual(unloadedFolders, [previousFolder]);

  unload();
});

test("installing again destroys the previous runtime", () => {
  const windowRef = createWindow();
  const firstUnload = installSineTidyPinnedFolders(windowRef, preferences);
  const firstRuntime = windowRef.__sineTidyPinnedFolders;

  const secondUnload = installSineTidyPinnedFolders(windowRef, preferences);

  assert.notEqual(windowRef.__sineTidyPinnedFolders, firstRuntime);
  assert.equal(windowRef.listeners.size, 3);

  firstUnload();
  assert.ok(windowRef.__sineTidyPinnedFolders);

  secondUnload();
  assert.equal(windowRef.listeners.size, 0);
  assert.equal(windowRef.__sineTidyPinnedFolders, undefined);
});
