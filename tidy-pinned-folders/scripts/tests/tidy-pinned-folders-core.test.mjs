import assert from "node:assert/strict";
import test from "node:test";

import {
  collapsePinnedFolders,
  getPinnedActiveTabsToUnload,
  getPinnedFolderAncestors,
  getPinnedFolderDescendants,
  getPinnedFolderForTab,
  getPinnedFolderSiblings,
  getPinnedFolderUnloadController,
  getPinnedFoldersToCollapse,
  getPinnedFoldersToCollapseForSelection,
  isPinnedZenFolder,
  shouldUnloadPreviousPinnedTab,
} from "../tidy-pinned-folders-core.uc.mjs";

function folder({ collapsed = false, pinned = true } = {}) {
  return {
    isZenFolder: true,
    pinned,
    collapsed,
    group: null,
    parentElement: { children: [] },
    querySelectorAll() {
      return [];
    },
  };
}

function addSiblings(...folders) {
  const parent = { children: folders };
  for (const item of folders) {
    item.parentElement = parent;
  }
}

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

test("uses the current Zen folder controller and supports the legacy API", () => {
  const currentController = { animateUnload() {} };
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
