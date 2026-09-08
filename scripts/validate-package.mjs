import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`);
  }
}

function assertFile(relativePath) {
  const fullPath = join(root, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing referenced file: ${relativePath}`);
  }
  return fullPath;
}

function checkScript(relativePath) {
  const fullPath = assertFile(relativePath);
  const result = spawnSync(process.execPath, ["--check", fullPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${relativePath} failed syntax check:\n${result.stderr || result.stdout}`);
  }
}

function runRegressionTests() {
  const testPaths = [
    "scripts/tests/web-panels-css.test.mjs",
    "scripts/tests/web-panels-permissions.test.mjs",
    "scripts/tests/web-panels-runtime.test.mjs",
    "scripts/tests/web-panels-security.test.mjs",
    "scripts/tests/web-panels-ui.test.mjs",
  ].map(relativePath => join(root, relativePath));
  const result = spawnSync(process.execPath, ["--test", ...testPaths], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("Web Panels regression tests failed.");
  }
}

const theme = readJson(join(root, "theme.json"));

for (const field of ["id", "name", "description", "version", "style", "scripts"]) {
  if (!theme[field]) {
    throw new Error(`theme.json is missing required field: ${field}`);
  }
}

assertFile(theme.style.chrome);
if (theme.preferences) {
  readJson(assertFile(theme.preferences));
}

for (const [scriptPath, config] of Object.entries(theme.scripts)) {
  checkScript(scriptPath);
  if (!Array.isArray(config.include) || !config.include.includes("chrome://browser/content/browser.xhtml")) {
    throw new Error(`${scriptPath} must include chrome://browser/content/browser.xhtml`);
  }
}

runRegressionTests();

console.log("Sine Web Panels package validation passed.");
