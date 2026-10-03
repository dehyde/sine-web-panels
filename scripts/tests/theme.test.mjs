import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const theme = JSON.parse(readFileSync(join(root, "theme.json"), "utf8"));

test("loads the panel stylesheet directly instead of through a nested import", () => {
  assert.equal(theme.style.chrome, "scripts/web-panels.css");
});
