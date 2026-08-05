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

  if (isPinnedZenFolder(group)) {
    return group;
  }

  const closestFolder = tab?.closest?.("zen-folder");
  if (isPinnedZenFolder(closestFolder)) {
    return closestFolder;
  }

  return (
    Array.from(
      tab?.ownerDocument?.querySelectorAll?.("zen-folder") ?? []
    ).find(
      folder =>
        isPinnedZenFolder(folder) &&
        (folder.tabs?.includes?.(tab) || folder.contains?.(tab))
    ) ?? null
  );
}

export function getPinnedFolderToUnload(previousFolder, selectedTab) {
  if (!previousFolder) {
    return null;
  }

  const selectedFolderPath = new Set(
    getPinnedFolderAncestors(getPinnedFolderForTab(selectedTab))
  );
  if (selectedFolderPath.has(previousFolder)) {
    return null;
  }

  return previousFolder.rootMostCollapsedFolder ?? previousFolder;
}

export function getPinnedFolderToUnloadForSelection(previousTab, selectedTab) {
  if (!previousTab || previousTab === selectedTab) {
    return null;
  }

  return getPinnedFolderToUnload(
    getPinnedFolderForTab(previousTab),
    selectedTab
  );
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

export function getPinnedActiveFolderRoots(folders) {
  const activeFolders = folders.filter(
    folder =>
      isPinnedZenFolder(folder) &&
      folder.hasAttribute?.("has-active")
  );
  const activeFolderSet = new Set(activeFolders);

  return activeFolders.filter(folder => {
    let parentFolder = folder.group;

    while (isPinnedZenFolder(parentFolder)) {
      if (activeFolderSet.has(parentFolder)) {
        return false;
      }
      parentFolder = parentFolder.group;
    }

    return true;
  });
}

export function getPinnedFolderUnloadController(windowRef) {
  const controllers = [
    windowRef?.gZenFolders,
    windowRef?.gZenLiveFoldersUI,
  ];

  return (
    controllers.find(
      controller =>
        typeof controller?.animateUnloadAll === "function" ||
        typeof controller?.animateUnload === "function"
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

export function getPinnedFoldersToCollapseForSelection(
  selectedTab,
  folders,
  previousFolder = null
) {
  const selectedFolder = getPinnedFolderForTab(selectedTab);
  const activeFolderPath = new Set(
    getPinnedFolderAncestors(selectedFolder)
  );

  return folders.filter(
    folder =>
      isPinnedZenFolder(folder) &&
      (!activeFolderPath.has(folder) ||
        (folder === previousFolder && folder !== selectedFolder))
  );
}

export function collapsePinnedFolders(folders) {
  for (const folder of folders) {
    folder.collapsed = true;
  }
}
