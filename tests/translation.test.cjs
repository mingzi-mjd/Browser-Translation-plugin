const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const core = require("../core.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(html, translator = async m => ({ ok: true, text: "译：" + m.text })) {
  const dom = new JSDOM(html, { url: "https://example.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const listeners = [], calls = [];
  let shadow;
  const originalAttach = w.Element.prototype.attachShadow;
  w.Element.prototype.attachShadow = function(options) { shadow = originalAttach.call(this, options); return shadow; };
  w.chrome = {
    runtime: { id: "test", onMessage: { addListener(fn) { listeners.push(fn); } },
      async sendMessage(m) { calls.push(m); return translator(m); } },
    storage: { local: { get: async () => ({ settings: core.defaults }) }, onChanged: { addListener() {} } }
  };
  w.eval(fs.readFileSync(require.resolve("../core.js"), "utf8"));
  w.eval(fs.readFileSync(require.resolve("../floating.js"), "utf8"));
  w.eval(fs.readFileSync(require.resolve("../content.js"), "utf8"));
  await sleep(0);
  return { dom, w, calls, shadow, async message(type) {
    return new Promise(resolve => listeners[0]({ type }, { id: "test" }, resolve));
  } };
}
test("providers build fixed endpoints and map Microsoft Chinese language codes", () => {
  const [url, init] = core.request("microsoft", "hello", "zh-TW");
  assert.equal(new URL(url).searchParams.get("to"), "zh-Hant");
  assert.deepEqual(JSON.parse(init.body), ["hello"]);
  const [google] = core.request("google", "a&b 中文", "en");
  assert.equal(new URL(google).searchParams.get("q"), "a&b 中文");
  assert.throws(() => core.request("other", "hello", "en"));
  assert.throws(() => core.request("google", "x".repeat(4001), "en"));
});
test("provider parsing and service errors", async () => {
  assert.equal(core.parse("google", { sentences: [{ trans: "你" }, { trans: "好" }] }), "你好");
  assert.equal(core.parse("microsoft", [{ translations: [{ text: "你好" }] }]), "你好");
  assert.equal(core.parse("microsoft", ["你好"]), "你好");
  assert.throws(() => core.parse("microsoft", {}), /格式异常/);
  await assert.rejects(core.translate("google", "hello", "en", async () => ({ ok: false, status: 429 })), /频繁/);
  await assert.rejects(core.translate("google", "hello", "en", async () => { throw new TypeError("network"); }), /无法连接/);
});
test("bilingual translation preserves original markup, skips protected text and restores cleanly", async t => {
  const f = await fixture('<p id="p">Hello <strong>world</strong></p><pre>private code</pre><p translate="no">skip</p><p hidden>hidden</p><textarea>draft</textarea>');
  t.after(() => f.dom.window.close());
  await f.message("page-start"); await sleep(250);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].text, /Hello.*world/);
  assert.equal(f.w.document.querySelector("strong").textContent, "world");
  assert.equal(f.w.document.querySelectorAll('[data-light-translator="translation"]').length, 1);
  await f.message("page-stop");
  assert.equal(f.w.document.querySelector("#p").innerHTML, "Hello <strong>world</strong>");
});
test("restore discards late translation responses", async t => {
  let finish;
  const f = await fixture("<p>Hello</p>", () => new Promise(resolve => { finish = resolve; }));
  t.after(() => f.dom.window.close());
  await f.message("page-start"); await sleep(0);
  await f.message("page-stop");
  finish({ ok: true, text: "你好" }); await sleep(30);
  assert.equal(f.w.document.querySelectorAll('[data-light-translator="translation"]').length, 0);
});
test("dynamic paragraphs are translated once and updated source is refreshed", async t => {
  const f = await fixture("<p>Hello</p>");
  t.after(() => f.dom.window.close());
  await f.message("page-start"); await sleep(200);
  const p = f.w.document.createElement("p"); p.textContent = "New text"; f.w.document.body.append(p);
  await sleep(850);
  assert.equal(f.calls.length, 2);
  p.firstChild.textContent = "Updated text";
  await sleep(850);
  assert.equal(f.calls.length, 3);
  assert.equal(p.querySelectorAll('[data-light-translator="translation"]').length, 1);
  assert.equal(p.lastChild.textContent, "译：Updated text");
  await f.message("page-stop");
});
test("input preview does not replace automatically; replacement and undo emit input events", async t => {
  const f = await fixture('<textarea id="field">Hello</textarea>');
  t.after(() => f.dom.window.close());
  const field = f.w.document.querySelector("#field");
  let events = 0; field.addEventListener("input", () => events++);
  field.focus(); f.shadow.querySelector("#input").click(); await sleep(20);
  assert.equal(field.value, "Hello");
  const buttons = [...f.shadow.querySelectorAll("#operations button")];
  buttons.find(b => b.textContent === "替换输入内容").click(); await sleep(0);
  assert.equal(field.value, "译：Hello");
  buttons.find(b => b.textContent === "撤销替换").click(); await sleep(0);
  assert.equal(field.value, "Hello"); assert.equal(events, 2);
});
test("editing while translation is in progress prevents stale replacement", async t => {
  let finish;
  const f = await fixture('<input id="field" value="Hello">', () => new Promise(resolve => { finish = resolve; }));
  t.after(() => f.dom.window.close());
  const field = f.w.document.querySelector("#field");
  field.focus(); f.shadow.querySelector("#input").click(); await sleep(0);
  field.value = "My new draft";
  finish({ ok: true, text: "你好" }); await sleep(10);
  [...f.shadow.querySelectorAll("#operations button")].find(b => b.textContent === "替换输入内容").click();
  await sleep(0);
  assert.equal(field.value, "My new draft");
  assert.match(f.shadow.querySelector("#result").textContent, /变化/);
});
test("password fields are excluded and selected text requires explicit click", async t => {
  const f = await fixture('<input type="password" value="secret"><p>Hello world</p>');
  t.after(() => f.dom.window.close());
  f.w.document.querySelector("input").focus();
  assert.equal(f.shadow.querySelector("#input").hidden, true);
  f.w.document.querySelector("input").blur();
  const range = f.w.document.createRange(); range.selectNodeContents(f.w.document.querySelector("p"));
  f.w.getSelection().addRange(range);
  f.w.document.dispatchEvent(new f.w.Event("selectionchange"));
  assert.equal(f.calls.length, 0);
  f.shadow.querySelector("#selection").click(); await sleep(20);
  assert.equal(f.calls[0].text, "Hello world");
  assert.equal(f.shadow.querySelector("#result").textContent, "译：Hello world");
});
test("service failure produces a readable error and no fabricated translation", async t => {
  const f = await fixture("<p>Hello</p>", async () => ({ ok: false, error: "服务限流" }));
  t.after(() => f.dom.window.close());
  await f.message("page-start"); await sleep(20);
  assert.match(f.shadow.querySelector("#notice").textContent, /服务限流/);
  assert.equal(f.w.document.querySelectorAll('[data-light-translator="translation"]').length, 0);
});

