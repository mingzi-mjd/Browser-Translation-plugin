const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "listen-background.js"), "utf8");

function harness({ incognito = true, targetId = 7, controlId = 99, windowId = 42 } = {}) {
  let listener;
  const calls = { windowsCreate: [], tabsCreate: [], storage: {} };
  const target = { id: targetId, windowId, incognito, url: "https://example.test/video" };
  const control = { id: controlId, windowId, incognito, url: "chrome-extension://ext/buffer.html" };
  const chrome = {
    runtime: {
      id: "ext",
      getURL: name => `chrome-extension://ext/${name}`,
      onMessage: { addListener: fn => { listener = fn; } },
    },
    storage: {
      session: {
        get: async key => ({ [key]: calls.storage[key] }),
        set: async values => Object.assign(calls.storage, values),
        remove: async key => { delete calls.storage[key]; },
      },
    },
    tabs: {
      get: async id => (id === targetId ? target : id === controlId ? control : null),
      sendMessage: async (id, data) => {
        if (data.type === "listen-ping") return { ok: true };
        if (data.type === "buffer-player") return { ok: true, time: 0, duration: 600, revision: 0, paused: true, ready: true, rate: 1 };
        return { ok: true };
      },
      create: async options => {
        calls.tabsCreate.push(options);
        return { id: 200, windowId: options.windowId || windowId };
      },
      update: async id => ({ id }),
      remove: async () => {},
      onRemoved: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    windows: {
      create: async options => {
        calls.windowsCreate.push(options);
        return { id: 300 };
      },
      update: async () => {},
    },
    tabCapture: { getMediaStreamId: async () => "stream-id" },
  };
  const context = {
    console, Promise, Number, String, URL, crypto: { randomUUID: () => "session-id" },
    chrome,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    calls,
    send(message, sender) {
      return new Promise(resolve => listener(message, sender, resolve));
    },
  };
}

test("opens the listening control window in the incognito profile", async () => {
  const app = harness({ incognito: true, targetId: 7 });
  const result = await app.send(
    { type: "listen-open", tabId: 7 },
    { id: "ext", url: "chrome-extension://ext/popup.html" },
  );
  assert.equal(result.ok, true);
  assert.equal(app.calls.windowsCreate[0].incognito, true);
});

test("does not force incognito when the target tab is normal", async () => {
  const app = harness({ incognito: false, targetId: 7 });
  await app.send(
    { type: "listen-open", tabId: 7 },
    { id: "ext", url: "chrome-extension://ext/popup.html" },
  );
  assert.equal(app.calls.windowsCreate[0].incognito, undefined);
});

test("creates the buffered background tab in the target incognito window", async () => {
  const app = harness({ incognito: true, targetId: 7, controlId: 99, windowId: 42 });
  const result = await app.send(
    { type: "listen-claim", control: 99 },
    { id: "ext", url: "chrome-extension://ext/buffer.html?tab=7", tab: { id: 99, windowId: 42 } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.id, "session-id");
  assert.equal(app.calls.tabsCreate[0].url, "about:blank");
  assert.equal(app.calls.tabsCreate[0].windowId, 42);
});
