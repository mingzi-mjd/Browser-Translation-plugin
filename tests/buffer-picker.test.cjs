const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "buffer-player.js"), "utf8");

function video({ left, top, width, height, duration, paused = false, hidden = false, opacity = 1 }) {
  const style = { display: hidden ? "none" : "block", visibility: "visible", opacity: String(opacity) };
  const element = {
    currentTime: 0, duration, paused, ended: false, readyState: 4, playbackRate: 1, preservesPitch: true,
    currentSrc: "https://example.test/video.mp4", isConnected: true, seekable: { length: 1 },
    getBoundingClientRect: () => ({ left, top, right: left + width, bottom: top + height, width, height }),
    addEventListener() {}, removeEventListener() {},
    pause() { element.paused = true; },
    play() { element.paused = false; return Promise.resolve(); },
    style,
  };
  return element;
}

function harness() {
  let listener, sessionId = 0;
  const videos = [];
  const context = {
    console, setTimeout, clearTimeout, Promise, Number, Math,
    innerWidth: 1920, innerHeight: 1080,
    location: { href: "https://example.test/page" },
    document: { querySelectorAll: () => videos },
    getComputedStyle: element => element.style,
    chrome: { runtime: { id: "extension", onMessage: { addListener: fn => { listener = fn; } } } },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    videos,
    prepare() {
      const id = `session-${++sessionId}`;
      return new Promise(resolve => listener(
        { type: "buffer-player", action: "prepare", id },
        { id: "extension" },
        resolve,
      ));
    },
  };
}

test("prefers the largest visible playable video", async () => {
  const app = harness();
  app.videos.push(
    video({ left: 0, top: 0, width: 320, height: 180, duration: 30 }),
    video({ left: 360, top: 0, width: 1280, height: 720, duration: 7200 }),
  );
  const result = await app.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.duration, 7200);
});

test("ignores hidden videos", async () => {
  const app = harness();
  app.videos.push(
    video({ left: 0, top: 0, width: 1280, height: 720, duration: 7200, hidden: true }),
    video({ left: 0, top: 0, width: 640, height: 360, duration: 600 }),
  );
  const result = await app.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.duration, 600);
});

test("uses a playing video to break a size tie", async () => {
  const app = harness();
  app.videos.push(
    video({ left: 0, top: 0, width: 640, height: 360, duration: 600, paused: true }),
    video({ left: 660, top: 0, width: 640, height: 360, duration: 900, paused: false }),
  );
  const result = await app.prepare();
  assert.equal(result.ok, true);
  assert.equal(result.duration, 900);
});

test("reports when no visible video is available", async () => {
  const app = harness();
  app.videos.push(video({ left: 0, top: 0, width: 100, height: 50, duration: 600 }));
  const result = await app.prepare();
  assert.equal(result.ok, false);
  assert.match(result.error, /未找到可见的普通视频/);
});

test("reports a visible video that is not seekable yet", async () => {
  const app = harness();
  const pending = video({ left: 0, top: 0, width: 640, height: 360, duration: NaN });
  pending.seekable = { length: 0 };
  app.videos.push(pending);
  const result = await app.prepare();
  assert.equal(result.ok, false);
  assert.match(result.error, /视频尚未就绪/);
});
