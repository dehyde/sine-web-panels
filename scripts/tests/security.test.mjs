import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

globalThis.Services = {
  scriptSecurityManager: {
    createContentPrincipal: (uri, originAttributes) => ({
      kind: "content",
      origin: new URL(uri.spec).origin,
      originAttributes,
    }),
  },
  io: { newURI: spec => ({ spec }) },
};

const { loadPrincipalFor } = await import("../web-panels-store.uc.mjs");

test("http(s) URLs load with the destination's own content principal", () => {
  const principal = loadPrincipalFor("https://mail.example/u/1/inbox");
  assert.equal(principal.kind, "content");
  assert.equal(principal.origin, "https://mail.example");
  assert.deepEqual(principal.originAttributes, {});
  assert.equal(loadPrincipalFor("http://intranet.local/").origin, "http://intranet.local");
});

test("nothing but http(s) gets a principal, so it cannot be loaded at all", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "file:///C:/Windows/win.ini",
    "about:config",
    "chrome://browser/content/browser.xhtml",
    "view-source:https://mail.example/",
    "blob:https://mail.example/0f2c",
    "moz-extension://abc/page.html",
    "mail.example",
    "",
    null,
  ]) {
    assert.equal(loadPrincipalFor(url), null, String(url));
  }
});

test("a private window's loads carry its private-browsing origin attributes", () => {
  const privateWindow = { PrivateBrowsingUtils: { isWindowPrivate: () => true } };
  assert.deepEqual(loadPrincipalFor("https://mail.example/", privateWindow).originAttributes, { privateBrowsingId: 1 });
});

// The one source-text assertion in this suite, on purpose: "the shipped code
// never asks for the system principal" is a property of the source itself.
test("shipped scripts never request the system principal or its Trusted helpers", () => {
  const dir = new URL("../", import.meta.url);
  for (const name of readdirSync(dir).filter(file => /\.(mjs|js)$/.test(file))) {
    const code = readFileSync(new URL(name, dir), "utf8")
      .split("\n")
      .filter(line => !line.trim().startsWith("//"))
      .join("\n");
    for (const banned of ["getSystemPrincipal", "addTrustedTab(", "openTrustedLinkIn("]) {
      assert.equal(code.includes(banned), false, `${name} uses ${banned}`);
    }
  }
});

test("chrome UI never gets an event-handler attribute, whatever a caller passes", async () => {
  const { setElementAttributes } = await import("../web-panels.uc.mjs");
  const set = [];
  const element = { setAttribute: (name, value) => set.push(`${name}=${value}`) };
  const warn = console.warn;
  console.warn = () => {};
  try {
    setElementAttributes(element, { onclick: "x", ONLOAD: "y", onoverflow: "z", class: "rail", title: "Mail", open: "true" });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(set, ["class=rail", "title=Mail", "open=true"]);
});
