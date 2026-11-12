/* Continuous look-ahead capture with a bounded, ordered recognition queue. */
const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
const target = Number(new URL(location.href).searchParams.get("tab"));
let controlTab, id, config, stream, audioContext, pcm, running = false, generation = 0;
let capture = null, processing = false, coordinating = false, revision = null, cursor = 0, readyUntil = 0;
let waiting = true, initial = true, cues = [], controller, ticker, lastDisplay = "", misses = 0;
let playbackSpeed = 2, maxAhead = 180, maxPending = 45, pauseReason = "loading", subtitleOffset = 0;
let pending = [], sourcePlaying = false, captureLimit = 0, sourceRevision = null, preparedCursor = null;
const say = text => { $("status").textContent = text; };
const rpc = data => api.runtime.sendMessage({ ...data, control: controlTab?.id, id });
async function media(side, action = "state", time, rate) {
  const result = await rpc({ type: "listen-media", side, action, time, rate });
  if (!result?.ok) throw new Error(result?.error || "无法访问播放器");
  return result;
}
function readConfig() {
  const value = JSON.parse(localStorage.getItem("listenConfig") || "{}");
  const url = new URL(value.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, "").endsWith("/v1") || !value.model) throw new Error("请先在实时听译窗口保存有效的语音识别配置");
  value.baseUrl = url.href.replace(/\/+$/, "");
  value.origin = url.protocol + "//" + url.hostname + "/*";
  value.seconds = Math.min(4, Math.max(2, Number(value.seconds) || 2));
  return value;
}
function bufferSettings() {
  playbackSpeed = Number($("speed").value);
  maxAhead = Number($("capacity").value) * 60;
  if (![1, 1.25, 1.5, 2].includes(playbackSpeed) || ![60, 180, 300].includes(maxAhead)) throw new Error("请选择有效的后台倍速和缓存容量");
  // A segment contains config.seconds of captured sound, or seconds * speed of video.
  maxPending = Math.ceil(maxAhead / (config.seconds * playbackSpeed));
  localStorage.setItem("bufferSettings", JSON.stringify({ speed: playbackSpeed, capacity: maxAhead / 60 }));
}
try {
  const saved = JSON.parse(localStorage.getItem("bufferSettings") || "{}");
  if ([1, 1.25, 1.5, 2].includes(saved.speed)) $("speed").value = String(saved.speed);
  if ([1, 3, 5].includes(saved.capacity)) $("capacity").value = String(saved.capacity);
} catch { /* Invalid saved preferences fall back to the visible defaults. */ }
function wav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true); }
  return new Blob([buffer], { type: "audio/wav" });
}
async function stop(reason = "提前缓冲听译已停止") {
  running = false; generation++; capture = null; pending = []; sourcePlaying = false; preparedCursor = null; controller?.abort(); clearInterval(ticker);
  if (pcm) { pcm.port.onmessage = null; pcm.disconnect(); pcm = null; }
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  const oldContext = audioContext; audioContext = null;
  if (oldContext) await oldContext.close().catch(() => {});
  if (id) await rpc({ type: "listen-release" }).catch(() => {});
  id = null; cues = []; lastDisplay = ""; revision = null; subtitleOffset = 0; pauseReason = "loading";
  $("prepare").disabled = false; $("settings").disabled = false; $("stop").disabled = true; say(reason);
}
async function resetAt(state) {
  generation++; capture = null; pending = []; cues = []; lastDisplay = "";
  cursor = readyUntil = state.time; revision = state.revision;
  waiting = initial || $("auto-pause").checked;
  if (waiting) await media("target", "pause");
  await media("source", "pause"); sourcePlaying = false; sourceRevision = null; preparedCursor = null;
  pauseReason = "loading";
  // Don't abort a server inference on seek: the native CPU model cannot cancel it,
  // so wait for its stale result to finish before issuing the next request.
}
async function display(state) {
  // Positive offset delays subtitles, negative offset shows them earlier.
  const subtitleTime = state.time - subtitleOffset;
  const cue = cues.find(c => c.start <= subtitleTime && subtitleTime < c.end);
  const ahead = Math.max(0, readyUntil - state.time);
  $("progress").value = Math.min(Number($("lead").value), ahead);
  const message = state.manualPause ? "前台已手动暂停" : waiting ? `字幕缓冲中：${ahead.toFixed(1)} / ${$("lead").value} 秒` : `提前缓冲听译 · 已准备 ${ahead.toFixed(1)} 秒`;
  const captured = Math.max(0, (capture ? capture.start + capture.count / audioContext.sampleRate * capture.speed : cursor) - state.time);
  const queuedSeconds = pending.reduce((sum, item) => sum + item.job.end - item.job.start, 0);
  const background = capture ? `后台 ${playbackSpeed}× 连续采集中`
    : pauseReason === "queue" ? "后台暂停：识别 / 翻译队列已满，消耗至一半后继续"
    : pauseReason === "ahead" ? `后台暂停：已达到 ${maxAhead / 60} 分钟提前采集上限，消耗至一半后继续`
    : pauseReason === "ended" ? "音频采集完成" : "后台播放器准备中";
  const status = message + ` · 已采集 ${(captured / 60).toFixed(2)} / ${maxAhead / 60} 分钟`
    + ` · 待处理 ${pending.length} 段（${(queuedSeconds / 60).toFixed(2)} 分钟） · ${background}`
    + (processing ? " · 正在识别 / 翻译" : "");
  say(status);
  const source = cue?.source || "", translation = cue?.translation || "";
  $("preview").textContent = source + (translation ? "\n" + translation : "");
  const key = JSON.stringify([source, translation, status, subtitleOffset]);
  if (key !== lastDisplay) {
    lastDisplay = key;
    await rpc({ type: "listen-output", source, translation, status, offset: subtitleOffset });
  }
}
async function tick() {
  if (!running || coordinating) return;
  coordinating = true;
  try {
    const token = generation, front = await media("target");
    if (!running || token !== generation) return;
    if (front.ended) { await stop("前台视频播放完毕"); return; }
    if (revision === null || front.revision !== revision) await resetAt(front);
    if (!running) return;
    const currentToken = generation;
    const lead = Number($("lead").value), remaining = front.duration - front.time;
    const enough = readyUntil - front.time >= Math.min(lead, remaining) - 0.15;
    if (waiting && (enough || (!initial && !$("auto-pause").checked)) && !front.manualPause) {
      await media("target", "play"); waiting = false; initial = false;
    } else if (waiting && !enough && !front.paused && (initial || $("auto-pause").checked)) {
      await media("target", "pause");
    } else if (!waiting && $("auto-pause").checked && readyUntil - front.time < 0.5 && remaining > 0.2 && !front.paused) {
      await media("target", "pause"); waiting = true;
    }
    // A user may opt out of automatic waits after the initial prebuffer.
    if (!initial && !$("auto-pause").checked) waiting = false;
    cues = cues.filter(c => c.end >= front.time - 60);
    await display(front);
    if (!running || currentToken !== generation) return;
    captureLimit = front.time + maxAhead;
    if (sourcePlaying && !capture) {
      // Pause only at a chunk boundary when the queue is full or far enough ahead.
      // The next resume seeks to cursor, recovering audio played during this RPC.
      await media("source", "pause"); sourcePlaying = false;
    }
    if (capture) {
      const state = await media("source");
      if (!running || currentToken !== generation) return;
      const expected = capture ? capture.start + capture.count / audioContext.sampleRate * capture.speed : cursor;
      if (state.revision !== sourceRevision || Math.abs(state.rate - playbackSpeed) > 0.01 || Math.abs(state.duration - front.duration) > 1) throw new Error("后台播放器进度或倍速发生变化，请重新缓冲");
      if (Math.abs(state.time - expected) > 0.8 * playbackSpeed || (state.paused && !state.ended)) throw new Error("后台播放卡顿或被暂停，无法可靠对齐字幕，请重新缓冲");
      return;
    }
    if (cursor >= front.duration - 0.03) { pauseReason = "ended"; return; }
    // Separate high/low watermarks prevent restarting for every freed segment.
    if (pauseReason === "queue" && pending.length > Math.floor(maxPending / 2)) return;
    if (pauseReason === "ahead" && cursor - front.time > maxAhead / 2) return;
    if (pending.length >= maxPending) { pauseReason = "queue"; return; }
    if (cursor >= captureLimit) { pauseReason = "ahead"; return; }
    if (cursor < front.time - 0.5) { await resetAt(front); return; }
    if (preparedCursor !== cursor) {
      await media("source", "seek", cursor, playbackSpeed); preparedCursor = cursor;
    }
    const state = await media("source");
    if (Math.abs(state.duration - front.duration) > 1) throw new Error("两页视频时长发生变化，已停止以避免字幕错位");
    if (!state.ready) { pauseReason = "loading"; if (++misses >= 40) throw new Error("后台播放器长时间未就绪，请检查加载状态"); return; }
    misses = 0;
    const played = await media("source", "play");
    if (!running || currentToken !== generation) return;
    if (Math.abs(played.rate - playbackSpeed) > 0.01) throw new Error("网站未接受后台倍速，请停止后改用 1× 重试");
    sourcePlaying = true; sourceRevision = played.revision; preparedCursor = null;
    pauseReason = ""; capture = newCapture(played.time, front.duration);
  } catch (error) { await stop(error.message); }
  finally { coordinating = false; }
}
function newCapture(start, duration) {
  return { token: generation, from: cursor, start, duration, speed: playbackSpeed, chunks: [], count: 0,
    size: Math.max(1, Math.round(Math.min(config.seconds, (duration - start) / playbackSpeed) * audioContext.sampleRate)) };
}
function collect(samples) {
  if (!running || !(samples instanceof Float32Array)) return;
  let offset = 0;
  while (capture && capture.token === generation && offset < samples.length) {
    const job = capture, count = Math.min(samples.length - offset, job.size - job.count);
    job.chunks.push(samples.slice(offset, offset + count)); job.count += count; offset += count;
    if (job.count < job.size) break;
    const data = new Float32Array(job.count); let position = 0;
    for (const chunk of job.chunks) { data.set(chunk, position); position += chunk.length; }
    job.chunks = []; job.audioSeconds = data.length / audioContext.sampleRate;
    job.end = Math.min(job.duration, job.start + job.audioSeconds * job.speed);
    pending.push({ job, samples: data, rate: audioContext.sampleRate });
    cursor = job.end;
    drain();
    // Start the next segment immediately, including leftover PCM from this block.
    // No player pause/seek and no wait for the service between ordinary segments.
    pauseReason = cursor >= job.duration - 0.03 ? "ended" : pending.length >= maxPending ? "queue" : cursor >= captureLimit ? "ahead" : "";
    capture = pauseReason ? null : newCapture(cursor, job.duration);
  }
}
async function drain() {
  if (processing) return;
  processing = true;
  try {
    while (running && pending.length) {
      const next = pending.shift();
      if (next.job.token === generation) await finishChunk(next.job, next.samples, next.rate);
    }
  } finally { processing = false; }
}
async function finishChunk(job, samples, rate) {
  const aborter = new AbortController(); controller = aborter;
  const timeout = setTimeout(() => aborter.abort(), 90000);
  try {
    if (!running || job.token !== generation) return;
    const end = job.end;
    const form = new FormData(); form.append("file", wav(samples, rate), "buffer.wav");
    form.append("model", config.model); form.append("response_format", "verbose_json");
    if (config.language) form.append("language", config.language);
    const response = await fetch(config.baseUrl + "/audio/transcriptions", { method: "POST", body: form,
      signal: aborter.signal, credentials: "omit", redirect: "error", headers: config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {} });
    if (!response.ok) throw new Error("语音识别服务 HTTP " + response.status + "，请检查服务后重新开启");
    const data = await response.json();
    if (!running || job.token !== generation) return;
    if (!Array.isArray(data.segments) && String(data.text || "").trim()) throw new Error("提前缓冲模式需要服务返回 segments 时间戳；当前接口仅返回文本，请使用实时模式");
    const items = (data.segments || []).map(segment => ({
      start: Math.max(job.from, job.start + Number(segment.start) * job.speed),
      end: Math.min(end, job.start + Number(segment.end) * job.speed),
      source: typeof segment.text === "string" ? segment.text.trim() : "", translation: ""
    })).filter(c => c.source && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
    for (const cue of items) {
      if (!running || job.token !== generation) return;
      if (cue.source.length > 4000) throw new Error("识别段落过长");
      if (config.engine !== "none") {
        const result = await api.runtime.sendMessage({ type: "translate", text: cue.source, engine: config.engine, target: config.target, bypassCache: config.bypassCache });
        if (!result?.ok) throw new Error("翻译失败：" + (result?.error || "无响应"));
        cue.translation = result.text;
      }
    }
    if (!running || job.token !== generation) return;
    cues.push(...items); readyUntil = end;
  } catch (error) {
    if (running && job.token === generation) await stop(error.name === "AbortError" ? "识别超时，请检查本地服务" : error.message);
  } finally {
    clearTimeout(timeout); if (controller === aborter) controller = null;
  }
}
async function connect(streamId, session) {
  try {
    const token = generation;
    const captured = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false });
    if (id !== session || token !== generation) { captured.getTracks().forEach(track => track.stop()); return; }
    stream = captured;
    if (!audioContext) throw new Error("音频控制窗口已关闭");
    await audioContext.audioWorklet.addModule("listen-worklet.js");
    if (id !== session || token !== generation || !audioContext) return;
    const input = audioContext.createMediaStreamSource(stream);
    pcm = new AudioWorkletNode(audioContext, "listen-pcm"); input.connect(pcm); pcm.connect(audioContext.destination);
    // No direct input->destination connection: background audio must remain inaudible.
    pcm.port.onmessage = event => collect(event.data);
    await audioContext.resume();
    stream.getTracks().forEach(track => track.addEventListener("ended", () => { if (running) stop("后台音频采集已结束"); }));
    running = true; initial = waiting = true; revision = null; misses = 0;
    ticker = setInterval(tick, 250); tick();
  } catch (error) { await stop("无法启动后台采集：" + error.message); }
}
$("prepare").onclick = async () => {
  $("prepare").disabled = true;
  try {
    config = readConfig();
    bufferSettings();
    if (!await api.permissions.request({ origins: [config.origin] })) throw new Error("未授权语音识别服务地址");
    audioContext = new AudioContext({ sampleRate: 16000 }); await audioContext.resume();
    const result = await rpc({ type: "listen-claim" });
    if (!result?.ok) throw new Error(result?.error || "无法建立会话");
    id = result.id; $("settings").disabled = true; $("stop").disabled = false;
    $("progress").max = Number($("lead").value);
    say("前台已暂停。请在新打开的后台视频页点击插件工具栏 → 用此页提前识别。");
  } catch (error) { await stop(error.message); }
};
$("stop").onclick = () => stop();
$("live").onclick = async () => { await stop(); location.href = api.runtime.getURL("listen.html") + "?tab=" + target; };
$("return").onclick = async () => {
  const tab = await api.tabs.update(target, { active: true }).catch(() => null);
  if (tab) await api.windows.update(tab.windowId, { focused: true });
};
api.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== api.runtime.id || msg.type !== "listen-control" || msg.control !== controlTab?.id) return;
  if (msg.action === "offset") {
    if (msg.id !== id || !running || ![-0.5, 0, 0.5].includes(msg.delta)) { reply({ ok: false, error: "听译会话未就绪" }); return; }
    subtitleOffset = msg.delta === 0 ? 0 : Math.max(-30, Math.min(30, subtitleOffset + msg.delta));
    lastDisplay = ""; reply({ ok: true, offset: subtitleOffset });
    // The next regular tick refreshes the cue; no seek or recognition restart.
    return;
  }
  reply({ ok: true });
  if (msg.action === "buffer-stream" && msg.id === id && !running) connect(msg.streamId, msg.id);
  if (msg.action === "stop") stop("会话已停止：页面关闭、导航或手动停止");
});
window.addEventListener("pagehide", () => { stream?.getTracks().forEach(track => track.stop()); controller?.abort(); });
api.tabs.getCurrent().then(tab => { controlTab = tab; }).catch(error => { say(error.message); $("prepare").disabled = true; });
