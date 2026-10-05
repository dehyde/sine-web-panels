// Frame script, loaded only into panel <browser>s. Reads nothing from the page
// beyond what sits on top of it; sends one message per Escape saying whether
// the page used the key to close something of its own.
//
// Measured on Zen 1.22.3b (2026-10-02):
// - chrome receives a keydown aimed at remote content BEFORE the page does,
//   exactly once, with defaultPrevented=false whatever the page later does;
//   no reply event reaches chrome in either event group. Only the content
//   side can see what Escape did.
// - Gmail calls preventDefault on EVERY Escape, with or without a preview
//   open, so "the page cancelled it" says nothing. What differs is the page:
//   closing the attachment preview made 63 DOM mutations before the key's
//   task ended; an Escape with nothing to close made 1.
// - It is a frame script, not a JSWindowActor: actors registered at runtime
//   never attach to web content — getActor() throws "doesn't match remote
//   type 'webIsolated=…'" even for a clone of a built-in actor.
(function () {
  if (this.sineWebPanelsEscape) {
    return;
  }
  this.sineWebPanelsEscape = true;

  const OVERLAY_SELECTOR =
    'dialog[open],[aria-modal="true"],[role="dialog"],[role="alertdialog"]';
  // Long enough for a close that runs one task or a short animation later.
  const SETTLE_MS = 150;

  const visibleOverlays = document => {
    let count = 0;
    for (const element of document.querySelectorAll(OVERLAY_SELECTOR)) {
      if (element.getClientRects().length) {
        count++;
      }
    }
    return count;
  };

  // Whatever is painted on top at the centre of the viewport. A preview or a
  // modal covers it; closing one changes it. Cheap: one hit test.
  const topAtCentre = win =>
    win.document.elementFromPoint(win.innerWidth / 2, win.innerHeight / 2);

  // The frame message manager is the content docshell's chrome event handler,
  // so this capture listener runs before any of the page's own listeners.
  addEventListener("keydown", event => {
    try {
      reportEscape(event);
    } catch {
      // A page torn down mid-key (navigation, closed frame) throws dead-object
      // errors; chrome then falls back to its own timeout and closes as before.
    }
  }, true);

  function reportEscape(event) {
    if (event.key !== "Escape" || event.repeat) {
      return;
    }
    const win = event.target?.ownerGlobal ?? content;
    const document = win?.document;
    if (!document) {
      return;
    }

    const overlaysBefore = visibleOverlays(document);
    const topBefore = topAtCentre(win);

    win.setTimeout(() => {
      try {
        const overlaysAfter = visibleOverlays(document);
        const topAfter = topAtCentre(win);
        const topChanged = topAfter !== topBefore;
        sendAsyncMessage("SineWebPanels:Escape", {
          consumed: topChanged || overlaysAfter < overlaysBefore,
          topChanged,
          overlaysBefore,
          overlaysAfter,
        });
      } catch {
        // The page went away while it settled; the chrome timeout covers it.
      }
    }, SETTLE_MS);
  }
}).call(this);
