/* Shared video caption translation, independently implemented with reference to KISS Translator.
 * Existing caption tracks only; no audio capture or transcription. */
(() => {
  "use strict";
  if (!["www.youtube.com", "www.bilibili.com"].includes(location.hostname)) return;
  const isBili = location.hostname === "www.bilibili.com";
  const siteName = isBili ? "哔哩哔哩" : "YouTube";
  const preferenceKey = isBili ? "bilibiliSubtitleSettings" : "youtubeSubtitleSettings";
  const unsupported = isBili ? "请打开哔哩哔哩普通视频页（/video/BV…），暂不支持番剧、直播和嵌入播放器。" : "请打开 YouTube 普通视频播放页，暂不支持直播和 Shorts。";
  const api = globalThis.browser || globalThis.chrome, core = globalThis.TranslatorCore;
  const protocol = isBili ? "bilingual-bilibili-v1" : "bilingual-youtube-v1", pending = new Map();
  let sequence = 0, generation = 0, currentId = "", enabled = false, loading = false;
  let cues = [], tracks = [], player = null, video = null, activeRequests = 0;
  let config = null, lastError = "", cacheHits = 0, rendered = "", preferences = {};
  const translated = new Map(), failed = new Set(), inFlight = new Set();
  const idNow = () => {
    const url = new URL(location.href);
    if (!isBili) return url.pathname === "/watch" ? url.searchParams.get("v") || "" : "";
    const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/);
    return match ? match[1] + ":" + Math.max(1, Number(url.searchParams.get("p")) || 1) : "";
  };
  const host = document.createElement("div");
  host.dataset.lightTranslator = "video-subtitles"; host.setAttribute("translate", "no");
  host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:60;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    :host{all:initial}*{box-sizing:border-box}[hidden]{display:none!important}
    button,select,input{font:13px system-ui}button,select{border:1px solid #bed3c6;border-radius:7px;padding:7px 10px;background:#fff;color:#164c38}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}
    #shortcut{position:absolute;right:16px;top:12px;pointer-events:auto;background:#163f32e8;color:white;border-color:#ffffff66}
    #panel{pointer-events:auto;position:absolute;right:12px;top:52px;width:min(330px,calc(100% - 24px));max-height:calc(100% - 64px);overflow:auto;background:#f8faf7;color:#223e30;border:1px solid #c6d9cc;border-radius:12px;padding:15px;font:13px/1.5 system-ui;box-shadow:0 8px 35px #0005}
    header{display:flex;align-items:center;justify-content:space-between;font-size:16px;font-weight:600}label{display:block;margin:9px 0}select{display:block;width:100%;margin-top:4px}input[type=range]{width:100%}.actions{display:flex;gap:8px;margin-top:12px}.primary{background:#176c51;color:white}p{margin:8px 0}#status{overflow-wrap:anywhere;font-size:12px}progress{width:100%;height:7px}small{color:#53695a}#captions{position:absolute;left:5%;width:90%;text-align:center;pointer-events:none;white-space:pre-line;font:22px/1.45 system-ui;color:white;text-shadow:0 1px 3px #000;overflow-wrap:anywhere}#captions span{display:inline;box-decoration-break:clone;-webkit-box-decoration-break:clone;padding:2px 7px;border-radius:4px}#translation{color:#ffeb9b}#hint{font-size:14px}
    </style>
    <button id="shortcut" aria-label="打开视频字幕翻译" aria-expanded="false">双语字幕</button>
    <section id="panel" hidden role="dialog" aria-label="${siteName}双语字幕">
      <header>${siteName}双语字幕<button id="close" aria-label="关闭字幕设置">×</button></header>
      <label>原字幕<select id="track"><option value="">自动选择（开启后获取）</option></select></label>
      <label>翻译引擎<select id="engine"><option value="microsoft">Microsoft 微软翻译</option><option value="google">Google 谷歌翻译</option><option value="openai">OpenAI / 兼容接口</option><option value="anthropic">Anthropic Claude</option></select></label>
      <label>译为<select id="target"></select></label>
      <label><input id="bypass" type="checkbox"> 忽略缓存重新翻译</label>
      <div class="actions"><button id="start" class="primary">开启 / 重新翻译</button><button id="stop">关闭字幕</button><button id="retry">重试失败</button></div>
      <p id="status" role="status" aria-live="polite">点击开启，读取当前视频已有字幕。</p><progress id="progress" max="100" value="0" aria-label="字幕翻译进度"></progress>
      <details><summary>字幕样式</summary>
        <label>字号 <output id="size-value">22</output> px<input id="size" type="range" min="14" max="40" value="22"></label>
        <label>背景不透明度 <output id="opacity-value">65</output>%<input id="opacity" type="range" min="0" max="100" value="65"></label>
        <label>距离底部 <output id="bottom-value">12</output>%<input id="bottom" type="range" min="5" max="65" value="12"></label>
      </details>
      <small>仅支持${siteName}普通视频的已有字幕。获取失败时，请打开播放器字幕，再点击重试。${isBili ? "部分字幕需要先登录 B 站。" : ""}AI 引擎请先在插件设置中配置。</small>
    </section><div id="captions" hidden><span id="source"></span><br><span id="translation"></span><div id="hint"></div></div>`;
  const $ = id => shadow.getElementById(id);
  for (const [value, name] of Object.entries(core.languages)) {
    const option = document.createElement("option"); option.value = value; option.textContent = name; $("target").append(option);
  }
  const ready = api.storage.local.get(["settings", preferenceKey]).then(data => {
    preferences = data[preferenceKey] || {};
    const settings = core.settings({ ...core.settings(data.settings), ...preferences });
    $("engine").value = settings.engine; $("target").value = settings.target;
    for (const [key, min, max, fallback] of [["size", 14, 40, 22], ["opacity", 0, 100, 65], ["bottom", 5, 65, 12]]) {
      $(key).value = Number.isFinite(preferences[key]) ? Math.min(max, Math.max(min, preferences[key])) : fallback;
    }
    style();
  }).catch(() => { $("target").value = core.defaults.target; style(); });
  function save() {
    preferences = { engine: $("engine").value, target: $("target").value,
      size: +$("size").value, opacity: +$("opacity").value, bottom: +$("bottom").value };
    api.storage.local.set({ [preferenceKey]: preferences }).catch(() => status("字幕偏好保存失败，本页仍可使用。"));
  }
  function style() {
    $("captions").style.fontSize = $("size").value + "px";
    $("captions").style.bottom = $("bottom").value + "%";
    for (const key of ["size", "opacity", "bottom"]) $(key + "-value").value = $(key).value;
    for (const key of ["source", "translation"]) $(key).style.background = `rgba(0,0,0,${+$("opacity").value / 100})`;
  }
  for (const key of ["size", "opacity", "bottom"]) $(key).oninput = () => { style(); save(); };
  function status(text) { if ($("status").textContent !== text) $("status").textContent = text; }
  function showPanel(show) { $("panel").hidden = !show; $("shortcut").setAttribute("aria-expanded", String(show)); }
  globalThis.VideoSubtitles = { siteName, open() { attach(); showPanel(true); if (!idNow()) status(unsupported); } };
  $("shortcut").onclick = () => showPanel($("panel").hidden);
  $("close").onclick = () => showPanel(false);
  // Keep YouTube's keyboard shortcuts from handling form input.
  for (const event of ["keydown", "keyup", "keypress"]) $("panel").addEventListener(event, e => e.stopPropagation());
  $("panel").addEventListener("keydown", e => { if (e.key === "Escape") showPanel(false); });
  window.addEventListener("message", event => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || message?.protocol !== protocol || message.type !== "response") return;
    const task = pending.get(message.id);
    if (!task || message.videoId !== task.videoId) return;
    clearTimeout(task.timer); pending.delete(message.id);
    message.error ? task.reject(new Error(String(message.error).slice(0, 300))) : task.resolve(message.result);
  });
  function bridge(action, extra = {}) {
    const id = "sub-" + ++sequence, videoId = idNow();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("字幕获取超时。请打开 CC 字幕后重试；更新插件后需刷新页面。")); }, 15000);
      pending.set(id, { resolve, reject, timer, videoId });
      window.postMessage({ protocol, type: "request", id, videoId, action, ...extra }, location.origin);
    });
  }
  function reset(message = "字幕已关闭，恢复播放器原字幕。", keepBridge = false) {
    generation++; enabled = false; loading = false;
    if (!keepBridge) window.postMessage({ protocol, type: "request", id: "stop-" + ++sequence, action: "stop" }, location.origin);
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("已取消")); }
    pending.clear(); cues = []; translated.clear(); failed.clear(); inFlight.clear(); cacheHits = 0; lastError = "";
    player?.classList.remove("bilingual-subtitles-active");
    $("captions").hidden = true; $("progress").value = 0; $("start").disabled = false;
    $("shortcut").textContent = "双语字幕"; status(message); rendered = "";
  }
  $("stop").onclick = () => reset();
  function attach() {
    const next = isBili ? document.querySelector(".bpx-player-container, .bilibili-player") : document.getElementById("movie_player");
    if (player !== next) {
      player?.classList.remove("bilingual-subtitles-active");
      player = next;
      if (enabled && cues.length) player?.classList.add("bilingual-subtitles-active");
    }
    video = player?.querySelector("video") || null;
    const parent = player || document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
    host.style.position = player ? "absolute" : "fixed";
    $("shortcut").hidden = !idNow() || !video;
  }
  const nativeStyle = document.createElement("style");
  nativeStyle.textContent = ".bilingual-subtitles-active .ytp-caption-window-container,.bilingual-subtitles-active .bpx-player-subtitle-wrap,.bilingual-subtitles-active .bilibili-player-video-subtitle{visibility:hidden!important}";
  document.documentElement.append(nativeStyle);

  function clean(text) { return text.replace(/\s+/g, " ").trim(); }
  function parse(body) {
    if (typeof body !== "string" || body.length > 8 * 1024 * 1024) throw new Error("字幕响应无效");
    let rows = [];
    if (body.trim().startsWith("{")) {
      const data = JSON.parse(body);
      rows = isBili ? (Array.isArray(data.body) ? data.body : []).map(e => ({
        start: Number(e.from), end: Number(e.to), text: clean(typeof e.content === "string" ? e.content : "")
      })) : (data.events || []).filter(e => Array.isArray(e.segs)).map(e => ({
        start: +e.tStartMs / 1000, end: (+e.tStartMs + (+e.dDurationMs || 2000)) / 1000,
        text: clean(e.segs.map(s => s.utf8 || "").join(""))
      }));
    } else {
      const xml = new DOMParser().parseFromString(body, "text/xml");
      if (xml.querySelector("parsererror")) throw new Error("字幕格式无法解析");
      rows = [...xml.querySelectorAll("text, p[t]")].map(node => {
        const timed = node.tagName === "p", scale = timed ? 1000 : 1;
        const start = +(node.getAttribute(timed ? "t" : "start")) / scale;
        const duration = +(node.getAttribute(timed ? "d" : "dur")) / scale;
        return { start, end: start + (duration || 2), text: clean(node.textContent || "") };
      });
    }
    rows = rows.filter(c => c.text && Number.isFinite(c.start) && c.start >= 0 && Number.isFinite(c.end) && c.end > c.start)
      .sort((a, b) => a.start - b.start);
    if (!rows.length) throw new Error("没有读到字幕内容。请打开播放器 CC 字幕后重试。");
    if (rows.length > 50000) throw new Error("字幕过长，当前版本暂不支持");
    // ASR tracks often emit overlapping rolling captions. Keep one copy of the overlap.
    const deduped = [];
    for (const row of rows) {
      const previous = deduped[deduped.length - 1];
      if (previous && row.start < previous.end) {
        if (previous.text === row.text) { previous.end = Math.max(previous.end, row.end); continue; }
        if (row.text.startsWith(previous.text)) { previous.text = row.text; previous.end = Math.max(previous.end, row.end); continue; }
        previous.end = Math.min(previous.end, row.start);
      }
      deduped.push({ ...row });
    }
    const result = [];
    for (const row of deduped) {
      const previous = result[result.length - 1];
      if (previous && row.start - previous.end <= 0.8 && row.end - previous.start <= 8 &&
          previous.text.length + row.text.length < 350 && !/[.!?。！？]["'”’]?$/u.test(previous.text)) {
        previous.text += " " + row.text; previous.end = row.end;
      } else result.push({ ...row });
    }
    // Bound pathological tracks to the existing translation API's per-item limit.
    if (result.some(row => row.text.length > 4000)) throw new Error("字幕单段超过 4000 字符，暂时无法翻译此轨道");
    return result;
  }
  function matchesCapture(capture, track) {
    try {
      const a = new URL(capture.url), b = new URL(track.url);
      if (isBili) return a.href === b.href;
      return ["v", "lang", "kind", "name"].every(key => a.searchParams.get(key) === b.searchParams.get(key)) && !a.searchParams.has("tlang");
    } catch { return false; }
  }
  async function start() {
    const selected = $("track").value;
    reset("正在获取字幕…", true); currentId = idNow();
    if (!currentId) { status(unsupported); return; }
    enabled = true; loading = true; const token = generation;
    $("start").disabled = true; $("progress").removeAttribute("value");
    try {
      await ready; if (token !== generation) return;
      config = { engine: $("engine").value, target: $("target").value, bypassCache: $("bypass").checked };
      save();
      let snapshot;
      for (let attempt = 0; attempt < 4; attempt++) {
        snapshot = await bridge("snapshot");
        if (token !== generation) return;
        if (snapshot?.ready) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!snapshot?.ready) throw new Error("播放器尚未就绪，请开始播放后重试。");
      if (snapshot.live) throw new Error("第一版暂不支持直播，请选择普通视频。");
      tracks = Array.isArray(snapshot.tracks) ? snapshot.tracks.filter(t => typeof t.url === "string" && typeof t.lang === "string") : [];
      if (!tracks.length) throw new Error("当前视频没有可读取的字幕。本功能暂不支持无字幕视频语音识别。");
      const trackKey = t => [t.lang, t.kind, t.name].join("|");
      const track = tracks.find(t => trackKey(t) === selected) || tracks.find(t => t.kind !== "asr") || tracks[0];
      $("track").replaceChildren();
      for (const item of tracks) {
        const option = document.createElement("option"); option.value = trackKey(item);
        option.textContent = item.name + (item.kind === "asr" ? "（自动字幕）" : ""); $("track").append(option);
      }
      $("track").value = trackKey(track);
      let parsed = null;
      for (const capture of (snapshot.captures || []).slice().reverse()) {
        if (matchesCapture(capture, track)) { try { parsed = parse(capture.body); break; } catch { /* use fresh request */ } }
      }
      if (!parsed) {
        try { parsed = parse((await bridge("fetch", { url: track.url }))?.body); }
        catch (error) {
          if (token !== generation) return;
          // A signed player request may become available while the metadata request was pending.
          const fresh = await bridge("snapshot");
          for (const capture of (fresh?.captures || []).slice().reverse()) {
            if (matchesCapture(capture, track)) { try { parsed = parse(capture.body); break; } catch { /* next capture */ } }
          }
          if (!parsed) throw error;
        }
      }
      if (token !== generation) return;
      cues = parsed; loading = false; attach();
      player?.classList.add("bilingual-subtitles-active"); $("shortcut").textContent = "双语字幕 · 已开启";
      updateProgress(); pump(); render();
    } catch (error) {
      if (token !== generation) return;
      loading = false; enabled = false; lastError = error.message;
      status("无法获取字幕：" + error.message); $("progress").value = 0;
      // Keep the bridge observer active for an explicit CC + retry by the user.
    } finally { if (token === generation) $("start").disabled = false; }
  }
  $("start").onclick = start;
  for (const key of ["track", "engine", "target"]) $(key).onchange = () => { save(); if (enabled) start(); };
  $("retry").onclick = () => {
    if (!enabled || !cues.length) { start(); return; }
    failed.clear(); lastError = ""; updateProgress(); pump();
  };
  function cursor(time) {
    let low = 0, high = cues.length;
    while (low < high) { const middle = (low + high) >> 1; if (cues[middle].end <= time) low = middle + 1; else high = middle; }
    return low;
  }
  function updateProgress() {
    const done = cues.reduce((sum, cue) => sum + Number(translated.has(cue.text)), 0);
    $("progress").value = cues.length ? done / cues.length * 100 : 0;
    status(`已翻译 ${done} / ${cues.length} 段 · 缓存命中 ${cacheHits} 段` +
      (failed.size ? ` · ${failed.size} 段失败：${lastError}（可重试）` : " · 优先缓冲播放位置之后约 90 秒"));
  }
  function pump() {
    if (!enabled || loading || !cues.length || !video || activeRequests >= 2 || failed.size) return;
    if (player?.classList.contains("ad-showing") || player?.classList.contains("ad-interrupting")) return;
    const time = video.currentTime, index = cursor(time), candidates = [];
    const seen = new Set();
    for (let i = index; i < cues.length && cues[i].start <= time + 90; i++) {
      const text = cues[i].text;
      if (!seen.has(text) && !translated.has(text) && !inFlight.has(text) && !failed.has(text)) { candidates.push(text); seen.add(text); }
    }
    const ai = ["openai", "anthropic"].includes(config.engine);
    while (candidates.length && activeRequests < 2) {
      const texts = [candidates.shift()]; let length = texts[0].length;
      while (ai && candidates.length && texts.length < 8 && length + candidates[0].length <= 3000) {
        const text = candidates.shift(); texts.push(text); length += text.length;
      }
      const token = generation, requestConfig = { ...config };
      texts.forEach(text => inFlight.add(text)); activeRequests++;
      const message = ai && texts.length > 1 ? { type: "translate-batch", texts } : { type: "translate", text: texts[0] };
      api.runtime.sendMessage({ ...message, ...requestConfig }).then(result => {
        if (token !== generation) return;
        if (!result?.ok) throw new Error(result?.error || "翻译服务无响应");
        const values = message.type === "translate-batch" ? result.texts : [result.text];
        if (!Array.isArray(values) || values.length !== texts.length || values.some(v => typeof v !== "string" || !v.trim())) throw new Error("字幕译文不完整");
        texts.forEach((text, i) => translated.set(text, values[i])); cacheHits += result.cacheHits || 0;
      }).catch(error => {
        if (token !== generation) return;
        texts.forEach(text => failed.add(text)); lastError = error.message;
      }).finally(() => {
        activeRequests--;
        if (token === generation) { texts.forEach(text => inFlight.delete(text)); updateProgress(); render(); }
        pump();
      });
    }
  }
  function render() {
    if (!enabled || !cues.length || !video || player?.classList.contains("ad-showing") || player?.classList.contains("ad-interrupting")) { $("captions").hidden = true; return; }
    const time = video.currentTime, cue = cues[cursor(time)];
    if (!cue || time < cue.start || time >= cue.end) { $("captions").hidden = true; return; }
    $("captions").hidden = false;
    const translation = translated.get(cue.text) || "";
    const hint = translation ? "" : failed.size ? "翻译已暂停，可打开双语字幕设置重试" : "正在翻译…";
    const key = cue.start + "|" + translation + "|" + hint;
    if (key !== rendered) {
      $("source").textContent = cue.text; $("translation").textContent = translation;
      $("translation").hidden = !translation; $("hint").textContent = hint; rendered = key;
    }
  }
  currentId = idNow(); attach();
  const monitor = setInterval(() => {
    const nextId = idNow();
    if (nextId !== currentId) {
      reset("视频已切换，点击开启翻译当前视频。"); currentId = nextId;
      tracks = []; $("track").replaceChildren(new Option("自动选择（开启后获取）", "")); showPanel(false);
    }
    attach(); pump(); render();
  }, 200);
  window.addEventListener("pagehide", event => { reset(); if (!event.persisted) clearInterval(monitor); });
})();
