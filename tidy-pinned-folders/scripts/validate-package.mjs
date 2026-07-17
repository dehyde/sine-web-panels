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

assertFile(theme.style.chrome);

for (const [scriptPath, config] of Object.entries(theme.scripts)) {
  checkScript(scriptPath);
  if (
    !Array.isArray(config.include) ||
    !config.include.includes("chrome://browser/content/browser.xhtml")
  ) {
    throw new Error(`${scriptPath} must include chrome://browser/content/browser.xhtml`);
  }
}

console.log("Tidy Pinned Folders package validation passed.");
