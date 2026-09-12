import assert from "node:assert/strict";
import { test } from "node:test";

const {
  calculateWebPanelViewportGeometry,
  clampWebPanelWidth,
  formatWebPanelUnreadCount,
  MIN_PANEL_WIDTH,
  normalizeResizerColor,
  normalizeWebPanelUrl,
  PANEL_VIEWPORT_INSET,
  PANEL_VIEWPORT_MAX_WIDTH_RATIO,
  panelMaxWidthFromViewport,
  parseWebPanelUnreadCount,
  titleFromUrl,
  webPanelSideForSidebar,
} = await import("../web-panels-store.uc.mjs");

test("normalizeWebPanelUrl accepts only http and https URLs", () => {
  assert.equal(normalizeWebPanelUrl("example.com"), "https://example.com/");
  assert.equal(normalizeWebPanelUrl("http://example.com/a"), "http://example.com/a");
  assert.equal(normalizeWebPanelUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(normalizeWebPanelUrl("javascript:alert(1)"), null);
  assert.equal(normalizeWebPanelUrl("about:preferences"), null);
  assert.equal(normalizeWebPanelUrl(""), null);
});

test("titleFromUrl derives a readable hostname", () => {
  assert.equal(titleFromUrl("https://www.calendar.google.com/calendar/u/0/r"), "calendar.google.com");
  assert.equal(titleFromUrl("not a url"), "not a url");
});

test("unread helpers parse and format title-prefixed counts", () => {
  assert.equal(parseWebPanelUnreadCount("(3) Inbox"), 3);
  assert.equal(parseWebPanelUnreadCount("[12] Chat"), 12);
  assert.equal(parseWebPanelUnreadCount("Inbox (3)"), null);
  assert.equal(formatWebPanelUnreadCount(0), "");
  assert.equal(formatWebPanelUnreadCount(12), "12");
  assert.equal(formatWebPanelUnreadCount(120), "99+");
});

// --------------------------------------------------------------------------
// Panel geometry. The bug these pin: the maximum width used to come from
// window.innerWidth, so Zen's left sidebar was never subtracted and the panel
// could grow over it — one profile had the width stored at 2009px.
// --------------------------------------------------------------------------

const WINDOW = { top: 0, left: 0, width: 1920, height: 1080 };

test("viewport geometry measures the page area, not the whole window", () => {
  // Zen's sidebar takes the first 320px, so only 1600 are the page's.
  const rect = { top: 40, left: 320, width: 1600, height: 1000 };
  const geometry = calculateWebPanelViewportGeometry(rect, WINDOW);

  assert.equal(geometry.maxWidth, Math.floor(1600 * PANEL_VIEWPORT_MAX_WIDTH_RATIO));
  assert.ok(geometry.maxWidth < WINDOW.width, "must not span the whole window");
  assert.equal(geometry.top, 40 + PANEL_VIEWPORT_INSET);
  assert.equal(geometry.height, 1000 - PANEL_VIEWPORT_INSET * 2);
});

test("viewport geometry clips the rect to the window it sits in", () => {
  // A rect reaching past the window edge must not widen the maximum.
  const rect = { top: 0, left: 1000, width: 4000, height: 1080 };
  const geometry = calculateWebPanelViewportGeometry(rect, WINDOW);

  assert.equal(geometry.maxWidth, Math.floor(920 * PANEL_VIEWPORT_MAX_WIDTH_RATIO));
});

test("viewport geometry falls back to the window when the rect is unusable", () => {
  const expected = Math.floor(WINDOW.width * PANEL_VIEWPORT_MAX_WIDTH_RATIO);

  assert.equal(calculateWebPanelViewportGeometry(null, WINDOW).maxWidth, expected);
  assert.equal(calculateWebPanelViewportGeometry({}, WINDOW).maxWidth, expected);
  assert.equal(
    calculateWebPanelViewportGeometry({ width: Number.NaN, height: 0 }, WINDOW).maxWidth,
    expected
  );
});

test("viewport geometry never returns a negative or zero maximum", () => {
  const geometry = calculateWebPanelViewportGeometry(
    { top: 0, left: 0, width: 0, height: 0 },
    { top: 0, left: 0, width: 0, height: 0 }
  );

  assert.ok(geometry.maxWidth >= 1);
  assert.ok(geometry.height >= 0);
});

test("clampWebPanelWidth keeps a width inside the measured maximum", () => {
  assert.equal(clampWebPanelWidth(600, 1520), 600);
  assert.equal(clampWebPanelWidth(2009, 1520), 1520, "the 2009px regression");
  assert.equal(clampWebPanelWidth(100, 1520), MIN_PANEL_WIDTH);
});

test("clampWebPanelWidth lets the maximum win over the minimum", () => {
  // A window narrower than MIN_PANEL_WIDTH: overflowing is worse than narrow.
  assert.equal(clampWebPanelWidth(400, 200), 200);
  assert.equal(clampWebPanelWidth(50, 200), 200);
});

test("clampWebPanelWidth survives nonsense input", () => {
  assert.equal(clampWebPanelWidth(Number.NaN, 1520), MIN_PANEL_WIDTH);
  assert.equal(clampWebPanelWidth(undefined, 1520), MIN_PANEL_WIDTH);
  assert.equal(clampWebPanelWidth(600, 0), 1);
  assert.equal(clampWebPanelWidth(600, Number.NaN), 1);
  assert.equal(clampWebPanelWidth(600.6, 1520), 601, "rounds rather than truncating");
});

// --------------------------------------------------------------------------
// Trusting a bad measurement is worse than not clamping. Both regressions
// these pin were shipped: measuring an element that was not laid out fell back
// to the whole window and put the panel over Zen's sidebar, and a maximum
// under the minimum pinned every clamp to one value and froze the resizer.
// --------------------------------------------------------------------------

test("a rect that was never laid out yields no maximum, not the whole window", () => {
  assert.equal(panelMaxWidthFromViewport(null, WINDOW), null);
  assert.equal(panelMaxWidthFromViewport({}, WINDOW), null);
  assert.equal(
    panelMaxWidthFromViewport({ top: 0, left: 0, width: 0, height: 0 }, WINDOW),
    null
  );
});

test("a maximum below the minimum panel width is rejected as a bad measurement", () => {
  // 100px of usable width is never a real window — it is the wrong element.
  assert.equal(
    panelMaxWidthFromViewport({ top: 0, left: 0, width: 100, height: 900 }, WINDOW),
    null
  );
});

test("a rejected measurement cannot freeze the resizer", () => {
  // The symptom: with a maximum under the minimum, clamp returns the same
  // value for every input, so dragging the edge changes nothing.
  const frozen = [400, 600, 900].map(w => clampWebPanelWidth(w, 100));
  assert.deepEqual(frozen, [100, 100, 100], "this is what must never be reached");

  // Rejecting the measurement is what keeps the caller off that path.
  assert.equal(
    panelMaxWidthFromViewport({ top: 0, left: 0, width: 100, height: 900 }, WINDOW),
    null
  );
});

test("a good measurement still yields a maximum", () => {
  const rect = { top: 40, left: 0, width: 1600, height: 1000 };

  assert.equal(
    panelMaxWidthFromViewport(rect, WINDOW),
    Math.floor(1600 * PANEL_VIEWPORT_MAX_WIDTH_RATIO)
  );
});

// --------------------------------------------------------------------------
// The resize handle colour is the only setting that becomes CSS, so it is
// validated rather than trusted. Anything rejected becomes "", which is also
// the default and the way back: empty lets the stylesheet's theme chain win.
// --------------------------------------------------------------------------

test("resizer colour accepts the notations a person would actually type", () => {
  for (const value of [
    "#abc",
    "#abcd",
    "#3b82f6",
    "#3b82f680",
    "rebeccapurple",
    "AccentColor",
    "rgb(59 130 246)",
    "rgba(59, 130, 246, 0.5)",
    "hsl(217 91% 60%)",
    "oklch(0.7 0.2 250)",
  ]) {
    assert.equal(normalizeResizerColor(value), value, value);
  }
});

test("resizer colour trims, and treats blank as the default", () => {
  assert.equal(normalizeResizerColor("  #3b82f6  "), "#3b82f6");
  assert.equal(normalizeResizerColor(""), "");
  assert.equal(normalizeResizerColor("   "), "");
  assert.equal(normalizeResizerColor(null), "");
  assert.equal(normalizeResizerColor(undefined), "");
});

test("resizer colour refuses anything that could escape the declaration", () => {
  for (const value of [
    "red; background: url(http://example.com/x)",
    "red}",
    "}",
    "url(http://example.com/x)",
    "var(--something-else)",
    "#12345",
    "#gggggg",
    "expression(alert(1))",
    "rgb(0,0,0);--x:y",
    'rgb(0,0,0)"',
  ]) {
    assert.equal(normalizeResizerColor(value), "", value);
  }
});

test("a rejected colour is indistinguishable from unset, so the theme wins", () => {
  // Both paths end at "", which is what makes the reset a real reset: the
  // caller removes the custom property and the stylesheet chain takes over.
  assert.equal(normalizeResizerColor("nonsense{}"), normalizeResizerColor(""));
});

// --------------------------------------------------------------------------
// The rail takes the side Zen's sidebar is NOT on. The inversion reads
// backwards at a glance, which is exactly why it is pinned.
// --------------------------------------------------------------------------

test("the rail sits opposite Zen's sidebar", () => {
  assert.equal(webPanelSideForSidebar("true"), "left", "sidebar right, rail left");
  assert.equal(webPanelSideForSidebar("false"), "right", "sidebar left, rail right");
});

test("no sidebar attribute means Zen's default, so the rail goes right", () => {
  assert.equal(webPanelSideForSidebar(null), "right");
  assert.equal(webPanelSideForSidebar(undefined), "right");
  assert.equal(webPanelSideForSidebar(""), "right");
});

test("only the exact attribute value flips the rail", () => {
  // Zen writes the string "true"; anything else is not a sidebar on the right.
  for (const value of ["TRUE", "1", "yes", "right", true]) {
    assert.equal(webPanelSideForSidebar(value), value === true ? "left" : "right", String(value));
  }
});
