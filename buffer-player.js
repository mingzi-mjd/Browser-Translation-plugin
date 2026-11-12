/* Narrow, session-scoped HTMLVideoElement adapter for experimental look-ahead mode. */
(() => {
  const api = globalThis.browser || globalThis.chrome;
  let session = null, selected = null, original = null, revision = 0, manualPause = false, commanded = false;
  const handlers = [];
  function pick() {
    const videos = [...document.querySelectorAll("video")].filter(v => v.getBoundingClientRect().width > 80 && v.getBoundingClientRect().height > 40);
    if (videos.length !== 1) throw new Error("提前缓冲仅支持顶层页面中单个可见的普通视频；不支持 iframe 或多个播放器");
    const video = videos[0];
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.seekable.length) throw new Error("视频尚未就绪，或属于直播 / 不可跳转视频，请先手动播放片刻");
    return video;
  }
  function state() {
    if (!selected?.isConnected || selected.currentSrc !== original.src || location.href !== original.url) throw new Error("播放器或视频已改变，请重新建立缓冲");
    return { time: selected.currentTime, duration: selected.duration, paused: selected.paused, ended: selected.ended,
      rate: selected.playbackRate, revision, manualPause, ready: selected.readyState >= 3 };
  }
  async function command(fn) {
    commanded = true;
    try { await fn(); await new Promise(resolve => setTimeout(resolve, 80)); }
    finally { commanded = false; }
  }
  async function release() {
    if (selected && original) {
      const video = selected, saved = original;
      for (const [event, fn] of handlers.splice(0)) video.removeEventListener(event, fn);
      video.playbackRate = saved.rate;
      if (typeof saved.preservesPitch === "boolean") video.preservesPitch = saved.preservesPitch;
      // Restore automatic buffering pauses, but respect a later manual pause.
      if (!saved.paused && !manualPause && video.paused) await video.play().catch(() => {});
      if (saved.paused) video.pause();
    }
    session = selected = original = null;
  }
  api.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== api.runtime.id || msg.type !== "buffer-player") return;
    (async () => {
      if (msg.action === "probe") {
        const video = pick(); return { time: video.currentTime, duration: video.duration };
      }
      if (msg.action === "prepare") {
        if (session === msg.id) return state();
        if (session) await release();
        selected = pick(); session = msg.id; revision = 0; manualPause = false;
        original = { paused: selected.paused, rate: selected.playbackRate, preservesPitch: selected.preservesPitch, src: selected.currentSrc, url: location.href };
        for (const event of ["seeking", "ratechange", "pause", "play"]) {
          const fn = () => { if (commanded) return; if (event === "pause") manualPause = true; else if (event === "play") manualPause = false; else revision++; };
          selected.addEventListener(event, fn); handlers.push([event, fn]);
        }
        await command(() => selected.pause()); return state();
      }
      if (session !== msg.id) throw new Error("播放器会话已结束");
      if (msg.action === "release") { await release(); return {}; }
      state();
      if (msg.action === "pause") await command(() => selected.pause());
      if (msg.action === "play") await command(() => selected.play());
      if (msg.action === "seek") {
        if (!Number.isFinite(msg.time) || msg.time < 0 || msg.time > selected.duration) throw new Error("无效播放位置");
        const rate = msg.rate === undefined ? 1 : msg.rate;
        if (![1, 1.25, 1.5, 2].includes(rate)) throw new Error("无效后台倍速");
        await command(async () => {
          selected.pause(); selected.playbackRate = rate;
          if ("preservesPitch" in selected) selected.preservesPitch = true;
          if (Math.abs(selected.currentTime - msg.time) < 0.03) return;
          await new Promise((resolve, reject) => {
            const done = () => { clearTimeout(timer); selected?.removeEventListener("seeked", done); resolve(); };
            const timer = setTimeout(() => { selected?.removeEventListener("seeked", done); reject(new Error("视频跳转超时")); }, 8000);
            selected.addEventListener("seeked", done, { once: true }); selected.currentTime = msg.time;
          });
        });
      }
      return state();
    })().then(result => respond({ ok: true, ...result }), error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
