const { chromium } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
(async () => {
  execFileSync(process.execPath, ["scripts/build.cjs"], { stdio: "inherit" });
  const root = path.resolve(__dirname, "..");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "light-translate-test-"));
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end('<!doctype html><html><head><title>Translation test</title><style>body{max-width:760px;margin:80px auto;font:20px/1.8 system-ui;background:#f4f7f4;color:#253c32}textarea{display:block;width:100%;height:90px;font:inherit}</style></head><body><h1>Read the world, in two languages.</h1><p id="article">Hello world. Keep the original text and read the translation below.</p><textarea id="draft">Good morning</textarea><p translate="no">This paragraph must stay unchanged.</p></body></html>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ignoreDefaultArgs: ["--disable-extensions"], channel: "chromium", executablePath: process.env.LIGHT_TRANSLATE_BROWSER || undefined, headless: true, viewport: { width: 1180, height: 820 },
      args: ["--enable-unsafe-extension-debugging", "--disable-extensions-except=" + path.join(root, "dist/chrome"), "--load-extension=" + path.join(root, "dist/chrome")]
    });
    context.setDefaultTimeout(10000);
    if (process.env.LIGHT_TRANSLATE_CDP) {
      const session = await context.newCDPSession(context.pages()[0]);
      await session.send("Extensions.loadUnpacked", { path: path.join(root, "dist/chrome") });
    }
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    // Deterministic UI checks; real provider tests are separate.
    await worker.evaluate(() => { TranslatorCore.translate = async (engine, text) => "译：" + text; });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.locator('[data-light-translator="ui"]').waitFor({ state: "attached" });
    const popup = await context.newPage();
    await popup.goto("chrome-extension://" + id + "/popup.html");
    await popup.locator("#engine").selectOption("google");
    await popup.locator("#status").filter({ hasText: "设置已保存" }).waitFor();
    await page.bringToFront();
    await popup.locator("#page").evaluate(button => button.click());
    await page.locator('#article [data-light-translator="translation"]').waitFor();
    assert.match(await page.locator("#article").innerText(), /Hello world/);
    assert.equal(await page.locator('[translate="no"] [data-light-translator]').count(), 0);
    await page.locator("#draft").focus();
    await page.getByRole("button", { name: "译输入", exact: true }).click();
    await page.getByRole("button", { name: "替换输入内容" }).waitFor();
    assert.equal(await page.locator("#draft").inputValue(), "Good morning");
    await page.getByRole("button", { name: "替换输入内容" }).click();
    assert.equal(await page.locator("#draft").inputValue(), "译：Good morning");
    await page.getByRole("button", { name: "撤销替换" }).click();
    assert.equal(await page.locator("#draft").inputValue(), "Good morning");
    await page.getByRole("button", { name: "关闭翻译预览" }).click();
    await page.locator("#article").evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element.firstChild);
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await page.getByRole("button", { name: "译选中", exact: true }).click();
    await page.locator('[data-light-translator="ui"] #result').filter({ hasText: "译：Hello world" }).waitFor();
    fs.mkdirSync(path.join(__dirname, "artifacts"), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, "artifacts/bilingual.png") });
    await popup.screenshot({ path: path.join(__dirname, "artifacts/popup.png") });
    await page.bringToFront();
    await popup.locator("#restore").evaluate(button => button.click());
    await page.waitForFunction(() => document.querySelectorAll('[data-light-translator="translation"]').length === 0);
    assert.deepEqual(errors, []);
    console.log("PASS: extension loaded; settings, bilingual rendering, restore, selection, input preview/replace/undo");
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    // Only remove the exact temporary directory created by this test.
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith("light-translate-test-")) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });





