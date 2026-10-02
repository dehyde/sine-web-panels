import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../web-panels-escape-frame.js", import.meta.url), "utf8");

// A page the frame script can look at: what is on top at the centre, which
// dialogs are visible, and a task queue the test drains by hand.
function fakePage() {
  const tasks = [];
  const page = {
    top: { id: "content" },
    overlays: [],
    win: null,
  };
  const document = {
    elementFromPoint: () => page.top,
    querySelectorAll: () => page.overlays.map(visible => ({ getClientRects: () => (visible ? [{}] : []) })),
  };
  page.win = {
    innerWidth: 1000,
    innerHeight: 800,
    document,
    setTimeout: fn => tasks.push(fn),
  };
  page.runTasks = () => {
    while (tasks.length) tasks.shift()();
  };
  return page;
}

function loadFrameScript(page) {
  const listeners = [];
  const messages = [];
  const sandbox = {
    content: page.win,
    addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }),
    sendAsyncMessage: (name, data) => messages.push({ name, ...data }),
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  const press = (key = "Escape", extra = {}) => {
    const event = { key, repeat: false, target: { ownerGlobal: page.win }, ...extra };
    for (const { type, listener } of listeners) if (type === "keydown") listener(event);
  };
  return { sandbox, listeners, messages, press, reload: () => vm.runInContext(SOURCE, sandbox) };
}

test("closing a preview (what sits on top changes) is the page's Escape", () => {
  const page = fakePage();
  page.top = { id: "preview" };
  const frame = loadFrameScript(page);

  frame.press();
  page.top = { id: "message" }; // Gmail closes the attachment preview
  page.runTasks();

  assert.equal(frame.messages.length, 1);
  assert.equal(frame.messages[0].name, "SineWebPanels:Escape");
  assert.equal(frame.messages[0].consumed, true);
});

test("an Escape that changes nothing is left to the panel", () => {
  const page = fakePage();
  const frame = loadFrameScript(page);

  frame.press();
  page.runTasks();

  assert.equal(frame.messages[0].consumed, false);
});

test("a dialog going away counts even when the centre stays the same", () => {
  const page = fakePage();
  page.overlays = [true];
  const frame = loadFrameScript(page);

  frame.press();
  page.overlays = [false];
  page.runTasks();

  assert.equal(frame.messages[0].consumed, true);
});

test("the verdict waits for the page to settle before answering", () => {
  const page = fakePage();
  const frame = loadFrameScript(page);

  frame.press();
  assert.equal(frame.messages.length, 0, "nothing is sent while the key is still being handled");
  page.runTasks();
  assert.equal(frame.messages.length, 1);
});

test("other keys and auto-repeat are not reported", () => {
  const page = fakePage();
  const frame = loadFrameScript(page);

  frame.press("Enter");
  frame.press("Escape", { repeat: true });
  page.runTasks();

  assert.equal(frame.messages.length, 0);
});

test("it listens in the capture phase, ahead of the page", () => {
  const frame = loadFrameScript(fakePage());

  assert.deepEqual(frame.listeners.map(({ type, capture }) => `${type}:${capture}`), ["keydown:true"]);
});

test("loading it twice into the same frame does not double the reports", () => {
  const page = fakePage();
  const frame = loadFrameScript(page);
  frame.reload();

  frame.press();
  page.runTasks();

  assert.equal(frame.listeners.length, 1);
  assert.equal(frame.messages.length, 1);
});
