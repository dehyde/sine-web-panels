(() => {
  const moduleUrl =
    "chrome://sine/content/sine-tidy-pinned-folders/scripts/tidy-pinned-folders.uc.mjs";
  let unloadRequested = false;
  let teardown = null;

  const loadPromise = import(moduleUrl)
    .then(module => {
      if (unloadRequested) {
        return null;
      }

      teardown = module.installSineTidyPinnedFolders(window);
      return teardown;
    })
    .catch(error => {
      console.error("[Tidy Pinned Folders] Failed to load module:", error);
      return null;
    });

  const unload = async () => {
    unloadRequested = true;
    const loadedTeardown = teardown ?? (await loadPromise);
    loadedTeardown?.();
    teardown = null;
  };

  if (typeof window.addUnloadListener === "function") {
    window.addUnloadListener(unload);
  } else {
    window.addEventListener("unload", () => void unload(), { once: true });
  }
})();
