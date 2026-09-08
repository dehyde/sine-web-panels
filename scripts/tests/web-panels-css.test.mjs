import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../web-panels.css", import.meta.url), "utf8");

test("keeps the remote browser host composited while the panel is closed", () => {
  const hiddenShellRule = css.slice(
    css.indexOf("#sine-web-panels-shell[hidden] {"),
    css.indexOf("}", css.indexOf("#sine-web-panels-shell[hidden] {") + 1) + 1
  );

  assert.doesNotMatch(
    css,
    /#sine-web-panels-shell\[hidden\][^{]*\{[^}]*display:\s*none/s
  );
  assert.match(hiddenShellRule, /display:\s*flex\s*!important/);
  assert.match(hiddenShellRule, /opacity:\s*0/);
  assert.match(hiddenShellRule, /pointer-events:\s*none/);
});

test("preserves the golden rail, panel, spacing, and animation geometry", () => {
  assert.match(css, /--sine-web-panels-rail-size:\s*40px/);
  assert.match(css, /--sine-web-panels-button-size:\s*32px/);
  assert.match(css, /--sine-web-panels-icon-size:\s*18px/);
  assert.match(css, /--sine-web-panels-resizer-size:\s*8px/);
  assert.match(css, /--sine-web-panels-gap:\s*6px/);
  assert.match(css, /--sine-web-panels-min-width:\s*320px/);
  assert.match(css, /--sine-web-panels-width:\s*420px/);
  assert.match(css, /--sine-web-panels-max-width:\s*95vw/);
  assert.match(css, /--sine-web-panels-viewport-top:\s*8px/);
  assert.match(css, /--sine-web-panels-viewport-height:\s*calc\(100vh - 16px\)/);
  assert.match(css, /--sine-web-panels-animation-duration:\s*75ms/);
  assert.match(
    css,
    /inset-inline-end:\s*calc\(var\(--sine-web-panels-rail-size\) \+ var\(--sine-web-panels-gap\) \* 2\)/
  );
  assert.match(
    css,
    /inset-inline-start:\s*calc\(var\(--sine-web-panels-rail-size\) \+ var\(--sine-web-panels-gap\) \* 2\)/
  );
});

test("sizes the panel within the measured central page viewport", () => {
  const shellStart = css.indexOf("#sine-web-panels-shell {");
  const shellRule = css.slice(shellStart, css.indexOf("}", shellStart) + 1);

  assert.ok(shellStart >= 0);
  assert.match(shellRule, /top:\s*var\(--sine-web-panels-viewport-top\)/);
  assert.match(shellRule, /height:\s*var\(--sine-web-panels-viewport-height\)/);
  assert.match(shellRule, /width:\s*var\(--sine-web-panels-width\)/);
  assert.match(
    shellRule,
    /min-width:\s*min\(var\(--sine-web-panels-min-width\), var\(--sine-web-panels-max-width\)\)/
  );
  assert.match(shellRule, /max-width:\s*var\(--sine-web-panels-max-width\)/);
  assert.doesNotMatch(shellRule, /inset-block:\s*var\(--sine-web-panels-gap\)/);
});

test("positions the native browser from the existing surface rectangle", () => {
  const nativeRuleStart = css.indexOf(
    ".browserSidebarContainer.sine-web-panel-native-overlay .browserContainer {"
  );
  const nativeRule = css.slice(
    nativeRuleStart,
    css.indexOf("}", nativeRuleStart) + 1
  );

  assert.ok(nativeRuleStart >= 0);
  assert.match(nativeRule, /position:\s*fixed\s*!important/);
  assert.match(nativeRule, /top:\s*var\(--sine-web-panel-native-top\)\s*!important/);
  assert.match(nativeRule, /left:\s*var\(--sine-web-panel-native-left\)\s*!important/);
  assert.match(nativeRule, /width:\s*var\(--sine-web-panel-native-width\)\s*!important/);
  assert.match(nativeRule, /height:\s*var\(--sine-web-panel-native-height\)\s*!important/);
  assert.doesNotMatch(css, /tab\[sine-web-panel-tab/);
});

test("keeps the native page below panel controls and above the backdrop and shell", () => {
  assert.match(
    css,
    /#sine-web-panels-root\s*\{[\s\S]*?position:\s*static;[\s\S]*?z-index:\s*auto;/
  );
  assert.match(
    css,
    /#sine-web-panels-backdrop\s*\{[^}]*z-index:\s*9999;/s
  );
  assert.match(
    css,
    /#sine-web-panels-shell\s*\{[^}]*z-index:\s*9999;/s
  );
  assert.match(
    css,
    /#tabbrowser-tabpanels\s*>\s*\.browserSidebarContainer\[sine-web-panel-container="true"\]\.sine-web-panel-native-overlay\s*\{[^}]*z-index:\s*10000\s*!important;/s
  );
  assert.match(
    css,
    /#sine-web-panels-rail\s*\{[^}]*z-index:\s*10001;/s
  );
  assert.match(
    css,
    /#sine-web-panels-menu\s*\{[^}]*z-index:\s*10002;/s
  );
});

test("isolates the owned native container from third-party tab animations and hit testing", () => {
  const ruleStart = css.indexOf(
    '#tabbrowser-tabpanels\n  > .browserSidebarContainer[sine-web-panel-container="true"].sine-web-panel-native-overlay {'
  );
  const rule = css.slice(ruleStart, css.indexOf("}", ruleStart) + 1);

  assert.ok(ruleStart >= 0);
  assert.match(rule, /animation:\s*none\s*!important/);
  assert.match(
    rule,
    /clip-path:\s*inset\([\s\S]*var\(--sine-web-panel-native-clip-top\)[\s\S]*var\(--sine-web-panel-native-clip-right\)[\s\S]*var\(--sine-web-panel-native-clip-bottom\)[\s\S]*var\(--sine-web-panel-native-clip-left\)[\s\S]*\)\s*!important/
  );
  assert.match(rule, /filter:\s*none\s*!important/);
  assert.match(rule, /opacity:\s*1\s*!important/);
  assert.match(rule, /pointer-events:\s*auto\s*!important/);
  assert.match(rule, /scale:\s*1\s*!important/);
  assert.match(rule, /transform:\s*none\s*!important/);
  assert.match(rule, /transition:\s*none\s*!important/);
  assert.match(rule, /will-change:\s*auto\s*!important/);
});

test("keeps shell and native page animation synchronized without clipping their travel", () => {
  assert.match(
    css,
    /#sine-web-panels-root\[opening\]\[side="right"\] #sine-web-panels-shell\s*\{[^}]*animation:\s*sine-web-panels-open-right/s
  );
  assert.match(
    css,
    /#sine-web-panels-root\[opening\]\[side="left"\] #sine-web-panels-shell\s*\{[^}]*animation:\s*sine-web-panels-open-left/s
  );
  assert.doesNotMatch(
    css,
    /#sine-web-panels-root\[side="(?:right|left)"\] #sine-web-panels-shell\s*\{[^}]*animation:/s
  );
  assert.match(
    css,
    /#browser:has\(#sine-web-panels-root\[(?:opening|closing)\]\[side="right"\]\)[\s\S]*clip-path:\s*inset\([\s\S]*calc\(var\(--sine-web-panel-native-clip-right\) - 12px\)/
  );
  assert.match(
    css,
    /#browser:has\(#sine-web-panels-root\[(?:opening|closing)\]\[side="left"\]\)[\s\S]*clip-path:\s*inset\([\s\S]*calc\(var\(--sine-web-panel-native-clip-left\) - 12px\)/
  );
});

test("leaves an exact backdrop aperture for native content while preserving outside clicks", () => {
  const backdropStart = css.indexOf("#sine-web-panels-backdrop {");
  const backdropRule = css.slice(
    backdropStart,
    css.indexOf("}", backdropStart) + 1
  );
  const shellStart = css.indexOf("#sine-web-panels-shell {");
  const shellRule = css.slice(shellStart, css.indexOf("}", shellStart) + 1);
  const surfaceStart = css.indexOf("#sine-web-panels-surface {");
  const surfaceRule = css.slice(
    surfaceStart,
    css.indexOf("}", surfaceStart) + 1
  );

  assert.ok(backdropStart >= 0);
  assert.match(backdropRule, /clip-path:\s*polygon\(\s*evenodd,/s);
  assert.match(backdropRule, /var\(--sine-web-panel-surface-top\)/);
  assert.match(backdropRule, /var\(--sine-web-panel-surface-right\)/);
  assert.match(backdropRule, /var\(--sine-web-panel-surface-bottom\)/);
  assert.match(backdropRule, /var\(--sine-web-panel-surface-left\)/);
  assert.match(backdropRule, /pointer-events:\s*auto/);
  assert.match(shellRule, /background:\s*transparent/);
  assert.match(shellRule, /backdrop-filter:\s*none/);
  assert.match(shellRule, /pointer-events:\s*none/);
  assert.match(surfaceRule, /background:\s*transparent/);
  assert.match(surfaceRule, /pointer-events:\s*none/);
  assert.match(
    css,
    /#sine-web-panels-resizer\s*\{[^}]*position:\s*relative;[^}]*width:\s*var\(--sine-web-panels-resizer-size\);[^}]*min-width:\s*var\(--sine-web-panels-resizer-size\);[^}]*align-self:\s*stretch;[^}]*pointer-events:\s*auto;[^}]*z-index:\s*1;/s
  );
  assert.match(
    css,
    /#sine-web-panels-shell::before\s*\{[^}]*inset-block:\s*0;[^}]*inset-inline:\s*1px;[^}]*background:\s*var\(--sine-web-panels-surface-strong\);[^}]*backdrop-filter:\s*blur\(20px\) saturate\(130%\);[^}]*clip-path:\s*polygon\([^}]*var\(--sine-web-panels-resizer-size\)[^}]*pointer-events:\s*none;[^}]*z-index:\s*0;/s
  );
  assert.match(
    css,
    /\.browserSidebarContainer\.sine-web-panel-native-overlay \.browserContainer\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--toolbar-bgcolor, Canvas\) 78%, transparent\)\s*!important;[^}]*border-radius:\s*0 13px 13px 0;/s
  );
  assert.match(
    css,
    /\.browserSidebarContainer\.sine-web-panel-native-overlay \.browserStack\s*\{[^}]*background:\s*Canvas;/s
  );
  assert.match(
    css,
    /#tabbrowser-tabpanels\s*>\s*\.browserSidebarContainer\[sine-web-panel-container="true"\]\.sine-web-panel-native-overlay\s*\{[^}]*-moz-subtree-hidden-only-visually:\s*0\s*!important;/s
  );
  assert.match(
    css,
    /#sine-web-panels-root\[(?:opening|closing)\]\[side="right"\] #sine-web-panels-backdrop[\s\S]*--sine-web-panels-backdrop-hole-right:\s*calc\(var\(--sine-web-panel-surface-right\) \+ 12px\)/
  );
  assert.match(
    css,
    /#sine-web-panels-root\[(?:opening|closing)\]\[side="left"\] #sine-web-panels-backdrop[\s\S]*--sine-web-panels-backdrop-hole-left:\s*calc\(var\(--sine-web-panel-surface-left\) - 12px\)/
  );
});

test("matches Glance darkness only on selected background pages while a panel is active", () => {
  const dimRuleStart = css.indexOf(
    "#browser:has(#sine-web-panels-root[opening])"
  );
  const dimRule = css.slice(dimRuleStart, css.indexOf("}", dimRuleStart) + 1);
  const backdropStart = css.indexOf("#sine-web-panels-backdrop {");
  const backdropRule = css.slice(
    backdropStart,
    css.indexOf("}", backdropStart) + 1
  );

  assert.ok(dimRuleStart >= 0);
  for (const state of ["opening", "open", "closing"]) {
    assert.match(
      dimRule,
      new RegExp(`#browser:has\\(#sine-web-panels-root\\[${state}\\]\\)`)
    );
  }
  assert.match(
    dimRule,
    /#tabbrowser-tabpanels\s*>\s*\.browserSidebarContainer\.deck-selected:not\(\[sine-web-panel-container="true"\]\):not\(\.zen-glance-overlay\)/s
  );
  assert.match(dimRule, /opacity:\s*0\.3\s*!important/);
  assert.doesNotMatch(dimRule, /\b(?:filter|scale|transform|pointer-events)\s*:/);
  assert.match(backdropRule, /background:\s*transparent/);
});

test("reduced motion disables animation for both shell and native browser", () => {
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[^{]*\{[\s\S]*#sine-web-panels-shell,[\s\S]*\.browserSidebarContainer\.sine-web-panel-native-overlay \.browserContainer\s*\{\s*animation:\s*none\s*!important;/
  );
});
