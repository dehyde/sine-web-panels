(async () => {
  try {
    await import(
      "chrome://sine/content/sine-tidy-pinned-folders/scripts/tidy-pinned-folders.uc.mjs"
    );
  } catch (error) {
    console.error("[Tidy Pinned Folders] Failed to load module:", error);
  }
})();
