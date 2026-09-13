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

test("the resize indicator leaves breathing room at the top and bottom", () => {
  const indicator = rule("#sine-web-panels-resizer::before");
  const root = rule(":root");

  assert.match(indicator, /inset-block:\s*var\(--sine-web-panels-resizer-edge-inset\)/);
  assert.doesNotMatch(indicator, /inset-block:\s*0/);
  assert.match(root, /--sine-web-panels-resizer-edge-inset:\s*\d+px/);
});

test("the resize indicator follows a theme colour, not a hard-coded one", () => {
  const indicator = rule("#sine-web-panels-resizer::before");

  assert.match(indicator, /background:\s*var\(--sine-web-panels-accent\)/);
});

// Zen Glance uses the active Zen colour for its controls. The resize cue is
// part of that same interaction surface, but stays short so it does not turn
// back into the old full-height stripe.
test("the default resize cue follows Zen's active colour", () => {
  const root = rule(":root");

  assert.match(root, /--sine-web-panels-accent:/);
  assert.match(root, /--zen-primary-color/, "matches Zen Glance's icon colour");
  assert.match(root, /AccentColor/, "has a resilient fallback");
});

test("the short resize cue remains visible while its edge is hovered", () => {
  const root = rule(":root");

  assert.match(root, /--sine-web-panels-resizer-line-active:\s*2px/);
  assert.match(
    css,
    /#sine-web-panels-resizer:hover::before,[\s\S]*?box-shadow:\s*0 0 \d+px/
  );
});

// --------------------------------------------------------------------------
// Navigation controls: Tom's condition for merging was that the gradient
// header over the panel's content goes. His decision (2026-09-09): a few
// floating controls beside the panel, always there, nothing appearing and
// disappearing.
// --------------------------------------------------------------------------

test("the navigation controls float beside the panel, not over it", () => {
  const nav = rule(".sine-web-panels-nav");
  const root = rule(":root");

  assert.doesNotMatch(nav, /gradient/, "no gradient");
  assert.doesNotMatch(nav, /opacity:\s*0\b/, "not hidden until hovered");
  assert.doesNotMatch(nav, /inset-inline:\s*0/, "does not span the panel's width");
  assert.match(nav, /flex-direction:\s*column/, "a vertical stack");
  assert.match(nav, /background:\s*transparent/, "the buttons, not a pill, own the surface");
  assert.match(root, /--sine-web-panels-navigation-lane:\s*46px/, "the layout reserves room for the controls");

  const right = rule(':root[sine-web-panels-side="right"] .sine-web-panels-nav');
  const left = rule(':root[sine-web-panels-side="left"] .sine-web-panels-nav');
  assert.match(right, /inset-inline-end:\s*calc\(\s*100%/, "outside the panel's edge on the right");
  assert.match(left, /inset-inline-start:\s*calc\(\s*100%/, "and on the left");
  assert.match(right, /--sine-web-panels-navigation-lane/, "clear of the resize handle");
  assert.match(right, /--sine-web-panels-nav-button-size/, "accounts for the button itself");
});

test("the navigation controls use Zen Glance's circular control treatment", () => {
  const button = rule(".sine-web-panels-nav-button");

  assert.match(button, /width:\s*var\(--sine-web-panels-nav-button-size\)/);
  assert.match(button, /height:\s*var\(--sine-web-panels-nav-button-size\)/);
  assert.match(button, /appearance:\s*none/);
  assert.match(button, /-moz-appearance:\s*none/);
  assert.match(button, /border-radius:\s*999px/);
  assert.match(button, /background:\s*color-mix\(/);
  assert.match(button, /--zen-primary-color/);
  assert.match(button, /color:\s*var\(--zen-primary-color\)\s*!important/);
  assert.match(
    css,
    /\.sine-web-panels-nav-button:hover:not\(:disabled\)\s*\{[\s\S]*?scale:\s*1\.02/
  );
});

test("the split action stays at the bottom of the panel and uses Zen's native pin icon", () => {
  const nav = rule(".sine-web-panels-nav");
  const pin = rule(".sine-web-panels-nav-pin");

  assert.match(nav, /inset-block-end:\s*15px/, "the control lane spans the panel height");
  assert.match(pin, /margin-block-start:\s*auto/, "the split action anchors at the bottom");
  assert.match(
    css,
    /\.sine-web-panels-nav-pin::before\s*\{[\s\S]*?zen-icons\/pin\.svg/,
    "the button uses Zen's native pin symbol"
  );
});

test("rail item hover follows Zen's default toolbar button corner radius", () => {
  assert.match(
    css,
    /border-radius:\s*var\(--toolbarbutton-border-radius,\s*var\(--zen-native-inner-radius,\s*8px\)\)/
  );
});

test("the page behind an open panel becomes translucent without a black scrim", () => {
  const viewport = rule(
    ".browserSidebarContainer.sine-web-panels-parent-background .browserContainer > browser"
  );

  assert.match(viewport, /opacity:\s*0\.5/);
  assert.doesNotMatch(css, /#sine-web-panels-backdrop/);
  assert.doesNotMatch(css, /color-mix\(in srgb, black 50%, transparent\)/);
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
