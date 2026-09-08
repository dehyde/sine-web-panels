import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const theme = JSON.parse(
  await readFile(resolve(packageRoot, "theme.json"), "utf8")
);
const privilegedScriptPaths = new Set([
  ...Object.keys(theme.scripts),
  ...(await readdir(resolve(packageRoot, "scripts")))
    .filter(name => name.endsWith(".uc.mjs"))
    .map(name => `scripts/${name}`),
]);
const privilegedScripts = await Promise.all(
  [...privilegedScriptPaths].map(async relativePath => ({
    relativePath,
    source: await readFile(resolve(packageRoot, relativePath), "utf8"),
  }))
);
const controllerSource = privilegedScripts.find(
  ({ relativePath }) => relativePath === "scripts/web-panels.uc.mjs"
)?.source;

const FORBIDDEN_SCRIPT_PATTERNS = [
  ["dynamic eval", /\beval\b/, 'eval("code")'],
  ["Function constructor", /\bFunction\b/, 'new Function("return code")'],
  [
    "string callback timer",
    /\bset(?:Timeout|Interval)\s*\(\s*["'`]/,
    'window.setTimeout("code", 0)',
  ],
  ["innerHTML assignment", /\binnerHTML\s*=/, "node.innerHTML = markup"],
  ["outerHTML assignment", /\bouterHTML\s*=/, "node.outerHTML = markup"],
  [
    "insertAdjacentHTML",
    /\binsertAdjacentHTML\s*\(/,
    'node.insertAdjacentHTML("beforeend", markup)',
  ],
  ["document.write", /\bdocument\.write\s*\(/, "document.write(markup)"],
  [
    "contextual fragment parsing",
    /\bcreateContextualFragment\s*\(/,
    "range.createContextualFragment(markup)",
  ],
  [
    "XUL fragment parsing",
    /\bparseXULToFragment\s*\(/,
    "MozXULElement.parseXULToFragment(markup)",
  ],
  [
    "literal inline event attribute",
    /\bsetAttribute\s*\(\s*["'`]on[a-z0-9_-]*/i,
    'node.setAttribute("onoverflow", code)',
  ],
  [
    "event-handler property assignment",
    /\.on[a-z][a-z0-9_]*\s*=/i,
    "node.onclick = handler",
  ],
  [
    "browser XHTML CSP override",
    /security\.browser_xhtml_csp\.enabled/,
    'Services.prefs.setBoolPref("security.browser_xhtml_csp.enabled", false)',
  ],
];

test("privileged scripts avoid executable markup and dynamic-code sinks", () => {
  for (const { relativePath, source } of privilegedScripts) {
    for (const [label, pattern] of FORBIDDEN_SCRIPT_PATTERNS) {
      assert.doesNotMatch(source, pattern, `${relativePath} contains ${label}`);
    }
  }
});

test("security patterns detect representative forbidden constructs", () => {
  for (const [label, pattern, example] of FORBIDDEN_SCRIPT_PATTERNS) {
    assert.match(example, pattern, `${label} detector must match its example`);
  }
});

test("revalidates the URL at the trusted-tab sink", () => {
  assert.ok(controllerSource, "scripts/web-panels.uc.mjs must be a privileged script");
  const methodStart = controllerSource.indexOf("  #openInNewTab(url) {");
  const methodEnd = controllerSource.indexOf("\n  #findItemElement", methodStart);
  const methodSource = controllerSource.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0 && methodEnd > methodStart);
  assert.match(methodSource, /const safeUrl = normalizeWebPanelUrl\(url\);/);
  assert.match(methodSource, /if \(!safeUrl\) \{\s*return;\s*\}/s);
  assert.match(methodSource, /openTrustedLinkIn\(safeUrl, "tab",/);
  assert.match(methodSource, /addTrustedTab\?\.\(safeUrl,/);
  assert.doesNotMatch(methodSource, /(?:openTrustedLinkIn|addTrustedTab\?\.)\(url,/);
});

test("element construction rejects event-handler attribute names", () => {
  assert.ok(controllerSource, "scripts/web-panels.uc.mjs must be a privileged script");
  assert.match(
    controllerSource,
    /#setAttributes\(element, attrs = \{\}\) \{\s*for \(const \[name, value\] of Object\.entries\(attrs\)\) \{\s*if \(\/\^on\/i\.test\(name\)\) \{\s*throw new TypeError\(/s
  );
});
