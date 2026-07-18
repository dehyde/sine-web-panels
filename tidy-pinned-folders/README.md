# Tidy Pinned Folders for Sine

Tidy Pinned Folders is an always-on Sine mod for Zen Browser.

When you expand a native Zen pinned folder, the mod collapses its open pinned-folder siblings. For nested folders, it does this at every level of the opened folder's path: the opened folder and all of its parents remain open, while sibling branches close. Unpinned folders are not affected.

Selecting a tab follows the same rule. The selected tab's pinned-folder path remains open and every other pinned folder branch closes. Selecting a tab outside a pinned folder closes all pinned folders.

When collapsed folders are temporarily showing active tabs, selecting another tab unloads every stale native active-tab marker so only the current selection can keep a folder branch visible.

The mod also includes an enabled-by-default **Collapse child folders when a parent closes** setting. Disable it from the mod's **Open settings** panel when you want a parent folder to remember which nested folders were open.

The mod uses Zen's own folder-collapse behavior, supports both the current and legacy Zen folder APIs, and does not modify Zen source files.

## Install

1. Install Sine for Zen Browser.
2. Open Sine Mods in browser settings.
3. Add the `tidy-pinned-folders` folder as a custom or unpublished mod.
4. Enable unsafe JavaScript if Sine requires it for local mods.
5. Restart Zen if the mod does not hot-load chrome scripts.

## Validate

```bash
node --test scripts/tests/tidy-pinned-folders-core.test.mjs
node scripts/validate-package.mjs
```

Manual checks:

- Expand one root pinned folder and confirm its open root-level pinned-folder siblings collapse.
- Expand a nested pinned folder and confirm its parents stay open while each open sibling branch closes.
- Expand another nested sibling folder and confirm the previously open sibling closes.
- Select a tab in another pinned folder and confirm the previously selected tab no longer keeps its folder visibly open.
- Select a regular tab and confirm all pinned folders close.
- Close a parent pinned folder and confirm all of its nested folders close; disable the setting and confirm they keep their open state.
- Expand or collapse an unpinned folder and confirm this mod does nothing.
