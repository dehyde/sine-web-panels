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
    throw new Error(
      `${relativePath} failed syntax check:\n${result.stderr || result.stdout}`
    );
  }
}

const theme = readJson(join(root, "theme.json"));

for (const field of ["id", "name", "description", "version", "style", "scripts"]) {
  if (!theme[field]) {
    throw new Error(`theme.json is missing required field: ${field}`);
  }
}

if (Object.hasOwn(theme, "js")) {
  throw new Error("theme.json must not use the legacy js property");
}

if (theme.author !== "dehyde") {
  throw new Error("theme.json author must be the GitHub username: dehyde");
}

assertFile(theme.style.chrome);

for (const [scriptPath, config] of Object.entries(theme.scripts)) {
  const fullPath = assertFile(scriptPath);
  checkScript(scriptPath);
  if (
    !Array.isArray(config.include) ||
    !config.include.includes("chrome://browser/content/browser.xhtml")
  ) {
    throw new Error(`${scriptPath} must include chrome://browser/content/browser.xhtml`);
  }

  if (
    theme.supportsUnload &&
    !readFileSync(fullPath, "utf8").includes("addUnloadListener")
  ) {
    throw new Error(
      `${scriptPath} must register an unload callback when supportsUnload is true`
    );
  }
}

checkScript("scripts/tidy-pinned-folders.uc.mjs");
checkScript("scripts/tidy-pinned-folders-core.uc.mjs");

console.log("Tidy Pinned Folders package validation passed.");
