export function isPinnedZenFolder(folder) {
  return Boolean(folder?.isZenFolder && folder?.pinned);
}

export function getPinnedFolderAncestors(folder) {
  const ancestors = [];
  let currentFolder = folder;

  while (isPinnedZenFolder(currentFolder)) {
    ancestors.push(currentFolder);
    currentFolder = currentFolder.group;
  }

  return ancestors;
}

export function getPinnedFolderSiblings(folder) {
  if (!isPinnedZenFolder(folder)) {
    return [];
  }

  return Array.from(folder.parentElement?.children ?? []).filter(
    sibling => sibling !== folder && isPinnedZenFolder(sibling)
  );
}

export function getPinnedFolderDescendants(folder) {
  if (!isPinnedZenFolder(folder)) {
    return [];
  }

  return Array.from(folder.querySelectorAll?.("zen-folder") ?? []).filter(
    isPinnedZenFolder
  );
}

export function getPinnedFolderForTab(tab) {
  let group = tab?.group;
  if (group?.hasAttribute?.("split-view-group")) {
    group = group.group;
  }

  return isPinnedZenFolder(group) ? group : null;
}

export function shouldUnloadPreviousPinnedTab(previousTab, selectedTab) {
  return Boolean(
    previousTab &&
      previousTab !== selectedTab &&
      getPinnedFolderForTab(previousTab) &&
      previousTab.hasAttribute?.("folder-active")
  );
}

export function getPinnedActiveTabsToUnload(selectedTab, tabs) {
  return tabs.filter(tab =>
    shouldUnloadPreviousPinnedTab(tab, selectedTab)
  );
}

export function getPinnedFolderUnloadController(windowRef) {
  const controllers = [
    windowRef?.gZenFolders,
    windowRef?.gZenLiveFoldersUI,
  ];

  return (
    controllers.find(
      controller => typeof controller?.animateUnload === "function"
    ) ?? null
  );
}

export function getPinnedFoldersToCollapse(openedFolder) {
  return [
    ...new Set(
      getPinnedFolderAncestors(openedFolder).flatMap(getPinnedFolderSiblings)
    ),
  ].filter(folder => !folder.collapsed);
}

export function getPinnedFoldersToCollapseForSelection(selectedTab, folders) {
  const activeFolderPath = new Set(
    getPinnedFolderAncestors(getPinnedFolderForTab(selectedTab))
  );

  return folders.filter(
    folder => isPinnedZenFolder(folder) && !activeFolderPath.has(folder)
  );
}

export function collapsePinnedFolders(folders) {
  for (const folder of folders) {
    folder.collapsed = true;
  }
}
