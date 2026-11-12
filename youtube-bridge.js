/* YouTube page-world bridge. No extension APIs, credentials or arbitrary URL fetching.
 * Architecture reference: KISS Translator's youtubeAcquisition / youtubeBridge. */
(() => {
  "use strict";
  const protocol = "bilingual-youtube-v1";
  const nativeFetch = window.fetch.bind(window);
  const captures = new Map();
  const controllers = new Map();
  let observing = false;
  const videoId = () => new URL(location.href).searchParams.get("v") || "";
  function captionURL(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === "https://www.youtube.com" && url.pathname === "/api/timedtext" &&
        url.searchParams.get("v") === videoId() && !url.searchParams.has("tlang") ? url : null;
    } catch { return null; }
  }
  function remember(value, body) {
    const url = captionURL(value);
    if (!observing || !url || typeof body !== "string" || !body.trim() || body.length > 8 * 1024 * 1024) return;
    captures.set(url.href, { url: url.href, body });
    while (captures.size > 4) captures.delete(captures.keys().next().value);
  }
  // Observe player responses as a fallback when metadata URLs have expired.
  window.fetch = function (...args) {
    const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || String(args[0]);
    const result = nativeFetch(...args);
    if (observing && captionURL(requestUrl)) result.then(response => {
      if (response.ok) response.clone().text().then(body => remember(requestUrl, body)).catch(() => {});
    }).catch(() => {});
    return result;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    if (observing && captionURL(url)) this.addEventListener("load", () => {
      try { if (this.status === 200) remember(url, this.responseText); } catch { /* binary response */ }
    }, { once: true });
    return originalOpen.call(this, method, url, ...args);
  };
  function snapshot() {
    const player = document.getElementById("movie_player");
    let data;
    try { data = player?.getPlayerResponse?.(); } catch { /* player initializing */ }
    if (data?.videoDetails?.videoId !== videoId()) data = window.ytInitialPlayerResponse;
    if (data?.videoDetails?.videoId !== videoId()) return { videoId: videoId(), tracks: [], ready: false };
    const tracks = (data.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).slice(0, 100)
      .filter(track => captionURL(track.baseUrl)).map(track => ({
        url: track.baseUrl, lang: track.languageCode, kind: track.kind || "",
        name: track.name?.simpleText || track.name?.runs?.map(run => run.text).join("") || track.languageCode
      }));
    return { videoId: videoId(), ready: true, live: data.videoDetails?.isLive === true,
      tracks, captures: [...captures.values()].filter(item => captionURL(item.url)) };
  }
  window.addEventListener("message", async event => {
    const msg = event.data;
    if (event.source !== window || event.origin !== location.origin || msg?.protocol !== protocol ||
        msg.type !== "request" || typeof msg.id !== "string" || msg.id.length > 100) return;
    const reply = payload => window.postMessage({ protocol, type: "response", id: msg.id, videoId: msg.videoId, ...payload }, location.origin);
    try {
      if (msg.action === "stop") {
        observing = false; captures.clear();
        controllers.forEach(c => c.abort()); controllers.clear(); return;
      }
      if (msg.videoId !== videoId() || !msg.videoId) throw new Error("视频已切换，请重新开启");
      if (msg.action === "snapshot") { observing = true; reply({ result: snapshot() }); return; }
      if (msg.action !== "fetch") return;
      const url = captionURL(msg.url);
      if (!url || controllers.size >= 2) throw new Error("字幕请求无效或正在处理中");
      const known = snapshot();
      if (![...known.tracks, ...known.captures].some(item => item.url === url.href)) throw new Error("字幕地址不属于当前视频");
      url.searchParams.set("fmt", "json3");
      const controller = new AbortController(); controllers.set(msg.id, controller);
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await nativeFetch(url.href, { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 429 ? "YouTube 字幕请求过于频繁，请稍后重试" : "获取字幕失败（HTTP " + response.status + "）");
        const body = await response.text();
        if (body.length > 8 * 1024 * 1024) throw new Error("字幕文件过大");
        reply({ result: { body } });
      } finally { clearTimeout(timer); controllers.delete(msg.id); }
    } catch (error) { reply({ error: error.name === "AbortError" ? "字幕获取超时或已取消" : error.message }); }
  });
})();
