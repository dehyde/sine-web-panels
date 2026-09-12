import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  join(dirname(dirname(fileURLToPath(import.meta.url))), "web-panels.css"),
  "utf8"
);

// Anchored at the start of a line, so a selector that also appears as the tail
// of a compound rule elsewhere (`:root[inFullscreen] #sine-web-panels-resizer`)
// cannot be mistaken for the standalone one.
function rule(selector) {
  const needle = `${selector} {`;
  const start = css.startsWith(needle) ? 0 : css.indexOf(`\n${needle}`) + 1;
  assert.ok(start > 0 || css.startsWith(needle), `missing rule: ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

// The regression: the handle was pointer-events: none, so :hover could never
// fire. Both sides of it are remote content, and chrome sees no pointer moves
// over that, so the JS hover state alone left the affordance invisible.
test("the resize handle stays hit-testable", () => {
  const resizer = rule("#sine-web-panels-resizer");

  assert.match(resizer, /pointer-events:\s*auto/);
  assert.doesNotMatch(resizer, /pointer-events:\s*none/);
  assert.match(resizer, /cursor:\s*ew-resize/, "the cursor is half the affordance");
});

test("the resize indicator spans the panel edge rather than a stub of it", () => {
  const indicator = rule("#sine-web-panels-resizer::before");

  assert.match(indicator, /inset-block:\s*0/);
  assert.doesNotMatch(indicator, /height:\s*\d+px/, "no fixed height");
});

test("the resize indicator follows a theme colour, not a hard-coded one", () => {
  const indicator = rule("#sine-web-panels-resizer::before");

  assert.match(indicator, /background:\s*var\(--sine-web-panels-accent\)/);
});

// A var() chain that resolves to nothing paints nothing, which is exactly the
// failure being fixed — so the last link must be a colour that always exists.
test("the accent chain ends in a colour that cannot fail to resolve", () => {
  const root = rule(":root");

  assert.match(root, /--sine-web-panels-accent:/);
  assert.match(root, /--zen-primary-color/, "prefers Zen's own theme colour");
  assert.match(root, /AccentColor\s*\)/, "falls back to the system accent");
});

// --------------------------------------------------------------------------
// Navigation controls: Tom's condition for merging was that the gradient
// header over the panel's content goes. His decision (2026-09-09): a few
// floating controls beside the panel, always there, nothing appearing and
// disappearing.
// --------------------------------------------------------------------------

test("the navigation controls float beside the panel, not over it", () => {
  const nav = rule(".sine-web-panels-nav");

  assert.doesNotMatch(nav, /gradient/, "no gradient");
  assert.doesNotMatch(nav, /opacity:\s*0\b/, "not hidden until hovered");
  assert.doesNotMatch(nav, /inset-inline:\s*0/, "does not span the panel's width");
  assert.match(nav, /flex-direction:\s*column/, "a vertical stack");
  assert.match(nav, /background:\s*var\(--zen-themed-toolbar-bg/, "opaque, themed");

  const right = rule(':root[sine-web-panels-side="right"] .sine-web-panels-nav');
  const left = rule(':root[sine-web-panels-side="left"] .sine-web-panels-nav');
  assert.match(right, /inset-inline-end:\s*calc\(100%/, "outside the panel's edge on the right");
  assert.match(left, /inset-inline-start:\s*calc\(100%/, "and on the left");
  assert.match(right, /--sine-web-panels-resizer-width/, "clear of the resize handle");
});

test("the navigation controls do not come and go with the pointer", () => {
  assert.doesNotMatch(css, /:hover\s*>\s*\.sine-web-panels-nav/);
});

test("the navigation controls leave when a panel's video goes fullscreen", () => {
  const fullscreen = rule(":root[sine-web-panels-panel-fullscreen] .sine-web-panels-nav");
  assert.match(fullscreen, /display:\s*none/);
});

// --------------------------------------------------------------------------
// Add / Edit popup. Tom's #3: Add is URL-only with the button on the right,
// the name lives in Edit, and the popup is opaque.
// --------------------------------------------------------------------------

test("every popup of ours is opaque", () => {
  // Sine loads the sheet at user level, so beating Zen's translucent
  // --panel-background-color on the arrow panel takes !important.
  const editor = rule("#sine-web-panels-editor");
  assert.match(editor, /--panel-background-color:\s*var\(--sine-web-panels-opaque-surface\)\s*!important/);
  // The transparent shadow ring toolkit keeps around an arrow panel is what
  // let the page show around the fields; the host is painted too, so the
  // popup is opaque whether or not ::part(content) matches.
  assert.match(editor, /--panel-box-shadow-margin:\s*0px\s*!important/);
  assert.match(editor, /\n  background:\s*var\(--sine-web-panels-opaque-surface\)\s*!important/);
  assert.match(editor, /border:\s*1px solid/);
  const content = rule("#sine-web-panels-editor::part(content)");
  assert.match(content, /background:\s*var\(--sine-web-panels-opaque-surface\)\s*!important/);
  assert.match(content, /backdrop-filter:\s*none/);

  for (const selector of ["#sine-web-panels-menu", "#sine-web-panels-finder"]) {
    const popup = rule(selector);
    assert.match(popup, /background:\s*var\(--sine-web-panels-opaque-surface\)/, selector);
    assert.doesNotMatch(popup, /backdrop-filter:\s*blur/, `${selector} has no blur`);
  }

  const token = css.match(/--sine-web-panels-opaque-surface:\s*var\(\s*--zen-dialog-background,\s*light-dark\(([^)]*)\)/);
  assert.ok(token, "the surface follows Zen's dialog colour with a solid fallback");
  assert.doesNotMatch(token[1], /rgba|transparent/, "the fallback is solid");
});

test("the popup surface is defined where the Add/Edit panel can see it", () => {
  // The panel hangs off mainPopupSet, outside the rail, so a token declared
  // on #sine-web-panels-root is invalid there and the background paints
  // transparent — which is exactly how the page came to show through the
  // fields.
  assert.match(rule(":root"), /--sine-web-panels-opaque-surface:/);
  const editor = rule("#sine-web-panels-editor");
  for (const token of editor.matchAll(/var\(--sine-web-panels-([a-z-]+)/g)) {
    assert.ok(
      ["opaque-surface", "panel-color"].includes(token[1]),
      `the editor uses rail-scoped token --sine-web-panels-${token[1]}`
    );
  }
});

test("the name field takes no room when it is not shown", () => {
  assert.match(rule("#sine-web-panels-name-input[hidden]"), /display:\s*none/);
  assert.match(rule("#sine-web-panels-editor-submit"), /justify-self:\s*end/, "Add sits on the right");
});

test("in Edit the URL and the name are the same width", () => {
  const span = rule('#sine-web-panels-editor[mode="edit"] #sine-web-panels-url-input,\n#sine-web-panels-name-input');
  assert.match(span, /grid-column:\s*1 \/ -1/);
  assert.match(rule("#sine-web-panels-editor-submit"), /grid-column:\s*2/, "Save drops to its own row");
});
