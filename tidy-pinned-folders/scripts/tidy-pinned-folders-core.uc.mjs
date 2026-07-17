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

export function getPinnedFoldersToCollapse(openedFolder) {
  return [
    ...new Set(
      getPinnedFolderAncestors(openedFolder).flatMap(getPinnedFolderSiblings)
    ),
  ].filter(folder => !folder.collapsed);
}

export function collapsePinnedFolders(folders) {
  for (const folder of folders) {
    folder.collapsed = true;
  }
}
