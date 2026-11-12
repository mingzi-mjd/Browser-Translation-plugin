/* Page-world Bilibili adapter. Only current-video metadata and known subtitle URLs.
 * Protocol reference: yt-dlp BilibiliBaseIE._get_subtitles (independent implementation). */
(() => {
  "use strict";
  const protocol = "bilingual-bilibili-v1", nativeFetch = window.fetch.bind(window);
  const metadata = new Map(), controllers = new Set();
  let allowedTracks = [], allowedVideo = "";
  function context() {
    const url = new URL(location.href), match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/);
    if (!match) return null;
    const page = Math.max(1, Number(url.searchParams.get("p")) || 1), ident = match[1];
    return { ident, page, key: ident + ":" + page,
      query: ident.startsWith("BV") ? { bvid: ident } : { aid: ident.slice(2) } };
  }
  function belongs(data, ctx) {
    return ctx.ident.startsWith("BV") ? data?.bvid === ctx.ident : String(data?.aid) === ctx.ident.slice(2);
  }
  function cidFrom(data, ctx) {
    if (!belongs(data, ctx)) return null;
    const entry = data.pages?.find(p => Number(p.page) === ctx.page);
    const cid = entry?.cid || (ctx.page === 1 ? data.cid : null);
    return /^\d+$/.test(String(cid)) ? String(cid) : null;
  }
  function subtitleURL(value) {
    try {
      const url = new URL(value, "https://www.bilibili.com");
      return url.protocol === "https:" && !url.username && !url.password && !url.port &&
        (url.hostname === "aisubtitle.hdslb.com" || url.hostname === "i0.hdslb.com" ||
         url.hostname === "i1.hdslb.com" || url.hostname === "i2.hdslb.com" || url.hostname === "subtitle.bilibili.com") ? url : null;
    } catch { return null; }
  }
  function tracksFrom(data) {
    const list = data?.subtitle?.subtitles;
    return (Array.isArray(list) ? list : []).slice(0, 100).flatMap(item => {
      const url = typeof item.subtitle_url === "string" && subtitleURL(item.subtitle_url);
      return url ? [{ url: url.href, lang: String(item.lan || "und"),
        name: String(item.lan_doc || item.lan || "字幕"),
        kind: Number(item.ai_type) > 0 || String(item.lan).startsWith("ai-") ? "asr" : "" }] : [];
    });
  }
  function playerURL(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === "https://api.bilibili.com" && ["/x/player/v2", "/x/player/wbi/v2"].includes(url.pathname) ? url : null;
    } catch { return null; }
  }
  function remember(url, data, ctx) {
    if (!ctx || context()?.key !== ctx.key || data?.code !== 0) return;
    const requestMatches = ctx.ident.startsWith("BV") ? url.searchParams.get("bvid") === ctx.ident : url.searchParams.get("aid") === ctx.ident.slice(2);
    const state = window.__INITIAL_STATE__?.videoData;
    // Requests using aid are also valid on a BV URL when the page confirms their identity.
    if (!requestMatches && !(belongs(state, ctx) && url.searchParams.get("aid") === String(state.aid))) return;
    const cid = url.searchParams.get("cid");
    if (!/^\d+$/.test(cid || "")) return;
    metadata.set(ctx.key + ":" + cid, { tracks: tracksFrom(data.data), needLogin: Boolean(data.data?.need_login_subtitle), time: Date.now() });
    while (metadata.size > 8) metadata.delete(metadata.keys().next().value);
  }
  // Capture only small subtitle-track metadata from the player's own signed requests.
  // No cookies, unrelated response data or subtitle text are retained here.
  window.fetch = function (...args) {
    const url = playerURL(typeof args[0] === "string" ? args[0] : args[0]?.url || String(args[0]));
    const ctx = context(), result = nativeFetch(...args);
    if (url && ctx) result.then(response => {
      if (response.ok) response.clone().json().then(data => remember(url, data, ctx)).catch(() => {});
    }).catch(() => {});
    return result;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, value, ...args) {
    const url = playerURL(value), ctx = context();
    if (url && ctx) this.addEventListener("load", () => {
      try { if (this.status === 200) remember(url, this.responseType === "json" ? this.response : JSON.parse(this.responseText), ctx); } catch { /* unavailable response */ }
    }, { once: true });
    return open.call(this, method, value, ...args);
  };
  async function json(url, signal) {
    const response = await nativeFetch(url, { credentials: "include", signal });
    if (!response.ok) throw new Error("B 站字幕信息获取失败（HTTP " + response.status + "），请在网站登录后重试");
    const result = await response.json();
    if (result.code !== 0) throw new Error("B 站接口拒绝请求（" + result.code + "）。请先登录并打开播放器字幕，随后重试或刷新页面。");
    return result.data;
  }
  async function snapshot(ctx, signal) {
    let cid = cidFrom(window.__INITIAL_STATE__?.videoData, ctx);
    if (!cid) cid = cidFrom(await json("https://api.bilibili.com/x/web-interface/view?" + new URLSearchParams(ctx.query), signal), ctx);
    if (!cid) throw new Error("无法确定当前分 P，请刷新视频页后重试");
    let saved = metadata.get(ctx.key + ":" + cid);
    if (!saved || !saved.tracks.length || Date.now() - saved.time > 5 * 60 * 1000) {
      const data = await json("https://api.bilibili.com/x/player/wbi/v2?" + new URLSearchParams({ ...ctx.query, cid }), signal);
      saved = { tracks: tracksFrom(data), needLogin: Boolean(data.need_login_subtitle) };
    }
    if (context()?.key !== ctx.key) throw new Error("视频或分 P 已切换，请重新开启");
    if (!saved.tracks.length) throw new Error(saved.needLogin
      ? "当前字幕需要登录哔哩哔哩。请登录后刷新页面重试。"
      : "当前分 P 没有可读取的字幕。请确认已登录并在播放器中开启字幕；画面内烧录字幕暂不支持。");
    allowedVideo = ctx.key; allowedTracks = saved.tracks;
    return { videoId: ctx.key, ready: true, live: false, tracks: saved.tracks, captures: [] };
  }
  window.addEventListener("message", async event => {
    const msg = event.data;
    if (event.source !== window || event.origin !== location.origin || msg?.protocol !== protocol || msg.type !== "request" || typeof msg.id !== "string" || msg.id.length > 100) return;
    if (msg.action === "stop") { controllers.forEach(c => c.abort()); allowedTracks = []; allowedVideo = ""; return; }
    if (!["snapshot", "fetch"].includes(msg.action)) return;
    const reply = payload => window.postMessage({ protocol, type: "response", id: msg.id, videoId: msg.videoId, ...payload }, location.origin);
    const ctx = context();
    if (!ctx || ctx.key !== msg.videoId) { reply({ error: "视频或分 P 已切换，请重新开启" }); return; }
    if (controllers.size >= 2) { reply({ error: "字幕请求正在处理中，请稍后重试" }); return; }
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      if (msg.action === "snapshot") { reply({ result: await snapshot(ctx, controller.signal) }); return; }
      const url = subtitleURL(msg.url);
      if (!url || allowedVideo !== ctx.key || !allowedTracks.some(track => track.url === url.href)) throw new Error("字幕地址不属于当前视频");
      const response = await nativeFetch(url.href, { credentials: "omit", signal: controller.signal });
      if (!response.ok) {
        for (const key of metadata.keys()) if (key.startsWith(ctx.key + ":")) metadata.delete(key);
        throw new Error("字幕文件读取失败（HTTP " + response.status + "），请重新开启字幕翻译");
      }
      const body = await response.text();
      if (body.length > 8 * 1024 * 1024) throw new Error("字幕文件过大");
      if (context()?.key !== ctx.key) throw new Error("视频或分 P 已切换");
      reply({ result: { body } });
    } catch (error) {
      reply({ error: error.name === "AbortError" ? "字幕获取超时或已取消，请重试" : error instanceof TypeError ? "无法连接 B 站字幕服务，请登录网站、打开播放器字幕后重试" : error.message });
    } finally { clearTimeout(timer); controllers.delete(controller); }
  });
})();
