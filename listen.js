/* Dedicated extension window owns capture and HTTP work; closing it releases audio. */
const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
const targetTab = Number(new URL(location.href).searchParams.get("tab"));
let controlTab, stream, context, node, sessionId, running = false, starting = false, epoch = 0;
let config, queue = [], busy = false, parts = [], sampleCount = 0, carry = new Float32Array(), controller;
let skipped = 0, lastText = "", statusText = "", configReady;
let silenceSamples = 0, speechSeen = false, bufferStarted = 0, sequence = 0, displayed = 0;
let translationPending = null, translating = false;
const fields = ["baseUrl", "apiKey", "model", "language", "seconds", "engine", "target"];
const status = text => { statusText = text; $("status").textContent = text; };
async function output(source = $("source").textContent, translation = $("translation").textContent, text = statusText) {
  if (!sessionId) return;
  await api.runtime.sendMessage({ type: "listen-output", control: controlTab?.id, id: sessionId, source, translation, status: text }).catch(() => {});
}
function readConfig() {
  const value = Object.fromEntries(fields.map(key => [key, $(key).value.trim()]));
  let url;
  try { url = new URL(value.baseUrl); } catch { throw new Error("语音识别服务地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("请填写不含账号、查询参数或片段的 HTTP / HTTPS 基础地址");
  value.baseUrl = url.href.replace(/\/+$/, "");
  if (!value.baseUrl.endsWith("/v1")) throw new Error("请填写以 /v1 结尾的基础地址，例如 http://127.0.0.1:8000/v1");
  if (!value.model || value.model.length > 200) throw new Error("请填写识别模型 ID");
  if (/[\r\n]/.test(value.apiKey) || value.apiKey.length > 4096) throw new Error("API Key 格式无效");
  value.seconds = Number(value.seconds);
  if (![2, 3, 4, 6, 10].includes(value.seconds)) value.seconds = 2;
  value.latencyVersion = 1;
  value.bypassCache = $("bypassCache").checked;
  value.origin = url.protocol + "//" + url.hostname + "/*";
  return value;
}
function save(value) {
  // Extension-origin localStorage is inaccessible to site content scripts.
  localStorage.setItem("listenConfig", JSON.stringify(value));
}
async function request(path, init = {}, signal, value = config) {
  const response = await fetch(value.baseUrl + path, { ...init, credentials: "omit", redirect: "error", signal,
    headers: { ...init.headers, ...(value.apiKey ? { Authorization: "Bearer " + value.apiKey } : {}) } });
  if (!response.ok) throw new Error("语音识别服务 HTTP " + response.status + (response.status === 401 ? "：请检查 API Key" : response.status === 404 ? "：请检查地址及模型是否已安装" : "：请查看本地服务日志"));
  return response.json();
}
function wav(samples, sampleRate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true); }
  return new Blob([bytes], { type: "audio/wav" });
}
function flush() {
  epoch++; controller?.abort(); parts = []; sampleCount = 0; carry = new Float32Array(); queue = []; lastText = "";
  silenceSamples = 0; speechSeen = false; bufferStarted = 0; translationPending = null; displayed = 0;
  $("timing").textContent = "";
  $("buffer").value = 0; $("source").textContent = $("translation").textContent = "";
  if (running) { status("已清空缓冲，等待当前播放声音…"); output(); }
}
async function stop(reason = "听译已停止") {
  running = false; starting = false; flush();
  if (node) { node.port.onmessage = null; node.disconnect(); node = null; }
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  const oldContext = context; context = null;
  if (oldContext) await oldContext.close().catch(() => {});
  const oldId = sessionId; sessionId = null;
  if (oldId) await api.runtime.sendMessage({ type: "listen-release", control: controlTab?.id, id: oldId }).catch(() => {});
  $("config").disabled = false; $("start").disabled = false; $("stop").disabled = true; status(reason);
}
function collect(data) {
  if (!running || !(data instanceof Float32Array)) return;
  let energy = 0; for (const sample of data) energy += sample * sample;
  const quiet = Math.sqrt(energy / data.length) < 0.001;
  // Don't accumulate long leading silence. End a spoken phrase shortly after a pause.
  if (!sampleCount && quiet) { carry = new Float32Array(); return; }
  if (!sampleCount) bufferStarted = Date.now() - data.length / context.sampleRate * 1000;
  if (quiet) silenceSamples += data.length;
  else { silenceSamples = 0; speechSeen = true; }
  parts.push(data); sampleCount += data.length;
  $("buffer").value = Math.min(100, sampleCount / (context.sampleRate * config.seconds) * 100);
  const pause = speechSeen && sampleCount >= context.sampleRate * 0.8 && silenceSamples >= context.sampleRate * 0.32;
  if (!pause && sampleCount < context.sampleRate * config.seconds) return;
  const samples = new Float32Array(carry.length + sampleCount); samples.set(carry);
  let offset = carry.length;
  for (const part of parts) { samples.set(part, offset); offset += part.length; }
  const overlap = carry.length / context.sampleRate;
  const silent = !speechSeen;
  const capturedAt = bufferStarted, buffered = sampleCount / context.sampleRate;
  carry = silent || pause ? new Float32Array() : samples.slice(-Math.round(context.sampleRate * 0.25));
  parts = []; sampleCount = 0; $("buffer").value = 0;
  silenceSamples = 0; speechSeen = false; bufferStarted = 0;
  if (silent) { if (!busy && !queue.length) { status("正在监听，当前片段较安静…"); output("", ""); } return; }
  if (queue.length >= 1) { queue.shift(); skipped++; }
  queue.push({ audio: wav(samples, context.sampleRate), overlap, token: epoch, time: Date.now(), capturedAt, buffered, sequence: ++sequence });
  processQueue();
}
function trimOverlap(text) {
  if (!lastText) return text;
  // Remove a multi-word duplicated boundary; don't remove a single repeated word.
  const words = text.split(/\s+/), prior = lastText.split(/\s+/);
  for (let n = Math.min(words.length, prior.length, 12); n >= 2; n--) {
    if (words.slice(0, n).join(" ") === prior.slice(-n).join(" ")) return words.slice(n).join(" ");
  }
  return text;
}
async function processQueue() {
  if (busy || !running || !queue.length) return;
  busy = true; const job = queue.shift(); controller = new AbortController(); const aborter = controller;
  const timeout = setTimeout(() => aborter.abort(), 90000);
  const requestStart = Date.now();
  try {
    status(`正在识别 · 等待 ${queue.length} 段${skipped ? " · 已丢弃 " + skipped + " 段过时音频" : ""}`); output();
    const form = new FormData(); form.append("file", job.audio, "chunk.wav"); form.append("model", config.model);
    form.append("response_format", "verbose_json");
    if (config.language) form.append("language", config.language);
    const data = await request("/audio/transcriptions", { method: "POST", body: form }, aborter.signal);
    if (!running || job.token !== epoch) return;
    const segments = Array.isArray(data.segments) ? data.segments.filter(s => Number(s.end) > job.overlap) : null;
    let source = segments ? segments.map(s => typeof s.text === "string" ? s.text : "").join(" ").trim() : String(data.text || "").trim();
    source = trimOverlap(source);
    if (!source) { status("此片段未识别到有效语音"); output(); return; }
    if (source.length > 4000) throw new Error("单段识别结果过长，请缩短音频分段");
    lastText = source; $("source").textContent = source; $("translation").textContent = "";
    displayed = job.sequence;
    const detected = String(data.language || config.language || "自动");
    job.source = source; job.detected = detected;
    job.waited = (requestStart - job.time) / 1000; job.recognition = (Date.now() - requestStart) / 1000;
    showTiming(job);
    status("已识别（" + detected + "）" + (config.engine === "none" ? "" : "，正在翻译…")); output(source);
    if (config.engine !== "none") {
      // Translation runs independently so a slow LLM never blocks the next ASR chunk.
      translationPending = { ...job, config: { ...config } };
      processTranslation();
    }
  } catch (error) {
    if (running && job.token === epoch) await stop(error.name === "AbortError" ? "识别超时（90 秒），请检查模型加载状态或使用较小模型，然后重新开始。" : error instanceof TypeError ? "无法连接语音识别服务，请检查本地服务地址、网络和模型部署。" : error.message);
  } finally {
    clearTimeout(timeout); if (controller === aborter) controller = null; busy = false; processQueue();
  }
}
function showTiming(job, translation) {
  if (job.sequence !== displayed || job.token !== epoch) return;
  $("timing").textContent = `采集 ${job.buffered.toFixed(1)} 秒 · 排队 ${job.waited.toFixed(1)} 秒 · 识别 ${job.recognition.toFixed(1)} 秒` +
    (translation === undefined ? "" : ` · 翻译 ${translation.toFixed(1)} 秒`) +
    ` · 从片段起点到当前 ${( (Date.now() - job.capturedAt) / 1000).toFixed(1)} 秒`;
}
async function processTranslation() {
  if (translating || !running || !translationPending) return;
  const job = translationPending; translationPending = null; translating = true;
  const started = Date.now();
  try {
    const result = await api.runtime.sendMessage({ type: "translate", text: job.source, engine: job.config.engine, target: job.config.target, bypassCache: job.config.bypassCache });
    if (!running || job.token !== epoch) return;
    if (job.sequence !== displayed) {
      $("timing").textContent += ` · 上一段翻译耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒，已过期跳过；建议使用更快翻译引擎`;
      return;
    }
    if (!result?.ok) throw new Error(result?.error || "翻译服务无响应");
    $("translation").textContent = result.text;
    showTiming(job, (Date.now() - started) / 1000);
    status(`正在听译 · ${job.detected} · 等待识别 ${queue.length} 段${skipped ? " · 已丢弃 " + skipped + " 段过时音频" : ""}`);
    output(job.source, result.text);
  } catch (error) {
    if (running && job.token === epoch && job.sequence === displayed) { status("翻译失败，继续识别：" + error.message); output(job.source, ""); }
  } finally { translating = false; processTranslation(); }
}
$("start").onclick = async () => {
  if (running || starting) return;
  starting = true; $("start").disabled = true;
  const attempt = ++epoch;
  try {
    config = readConfig();
    // Request host permission while still in the user's click handler.
    if (!await api.permissions.request({ origins: [config.origin] })) throw new Error("未授权访问语音识别服务");
    await configReady;
    if (attempt !== epoch) return;
    if (!api.tabCapture?.getMediaStreamId) throw new Error("当前浏览器不支持，此功能请使用 Chrome / Edge");
    save(config);
    const claim = await api.runtime.sendMessage({ type: "listen-claim", control: controlTab.id });
    if (!claim?.ok) throw new Error(claim?.error || "无法启动听译");
    sessionId = claim.id;
    if (attempt !== epoch) { await stop(); return; }
    const streamId = await api.tabCapture.getMediaStreamId({ targetTabId: targetTab, consumerTabId: controlTab.id });
    const captured = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }, video: false });
    if (attempt !== epoch) { captured.getTracks().forEach(t => t.stop()); return; }
    stream = captured;
    context = new AudioContext({ sampleRate: 16000 });
    const source = context.createMediaStreamSource(stream);
    // Capturing a tab suppresses native playback; route it once so the video stays audible.
    source.connect(context.destination);
    await context.audioWorklet.addModule("listen-worklet.js");
    if (attempt !== epoch || !context) return;
    node = new AudioWorkletNode(context, "listen-pcm"); source.connect(node); node.connect(context.destination);
    node.port.onmessage = event => collect(event.data);
    await context.resume();
    if (attempt !== epoch) return;
    stream.getAudioTracks().forEach(track => track.addEventListener("ended", () => { if (running) stop("标签页音频采集已结束"); }));
    running = true; starting = false; skipped = 0;
    $("config").disabled = true; $("stop").disabled = false;
    status("正在监听，停顿时提前识别，最长分段 " + config.seconds + " 秒。请保持控制窗口打开。"); output();
  } catch (error) { await stop("启动失败：" + error.message + "。若浏览器拒绝采集，请返回视频页，从工具栏插件按钮重新打开听译。"); }
  finally { starting = false; if (!running) $("start").disabled = false; }
};
$("stop").onclick = () => stop();
$("open-buffer").onclick = async () => {
  try { save(readConfig()); await stop(); location.href = api.runtime.getURL("buffer.html") + "?tab=" + targetTab; }
  catch (error) { status(error.message); }
};
$("return").onclick = async () => {
  try { const tab = await api.tabs.update(targetTab, { active: true }); await api.windows.update(tab.windowId, { focused: true }); }
  catch { status("目标网页已关闭"); }
};
$("models").onclick = async () => {
  $("models").disabled = true; let timer;
  try {
    const value = readConfig();
    if (!await api.permissions.request({ origins: [value.origin] })) throw new Error("未授权接口地址");
    status("正在获取语音识别服务的可用模型…"); const aborter = new AbortController(); timer = setTimeout(() => aborter.abort(), 15000);
    const result = await request("/models", {}, aborter.signal, value);
    $("model-list").replaceChildren(new Option("请选择语音识别模型", ""));
    for (const model of (Array.isArray(result.data) ? result.data : []).slice(0, 300)) if (typeof model.id === "string") $("model-list").add(new Option(model.id, model.id));
    status("连接成功。列表可能包含非识别模型，请选择已安装的 Whisper 语音识别模型。"); save(value);
  } catch (error) { status("获取模型失败：" + (error.name === "AbortError" ? "连接超时" : error.message)); }
  finally { clearTimeout(timer); $("models").disabled = false; }
};
$("model-list").onchange = () => { if ($("model-list").value) $("model").value = $("model-list").value; };
api.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== api.runtime.id || msg.type !== "listen-control" || msg.control !== controlTab?.id) return;
  reply({ ok: true });
  if (msg.action === "stop") stop("听译已停止，目标页面关闭、导航或用户停止了采集");
  else if (running) flush();
});
window.addEventListener("pagehide", () => { stream?.getTracks().forEach(track => track.stop()); controller?.abort(); });
configReady = (async () => {
  $("start").disabled = true;
  for (const [value, label] of Object.entries(TranslatorCore.languages)) $("target").add(new Option(label, value));
  const settings = TranslatorCore.settings((await api.storage.local.get("settings")).settings);
  $("engine").value = settings.engine; $("target").value = settings.target;
  try {
    const saved = JSON.parse(localStorage.getItem("listenConfig") || "{}");
    for (const key of fields) if (saved[key] !== undefined) $(key).value = saved[key];
    if (!saved.latencyVersion && Number(saved.seconds) === 6) $("seconds").value = "2";
  } catch { /* defaults */ }
  controlTab = await api.tabs.getCurrent();
  const target = await api.tabs.get(targetTab);
  $("tab-name").textContent = "目标：" + (target.title || "网页视频");
  $("start").disabled = false;
  if (!api.tabCapture?.getMediaStreamId) { $("start").disabled = true; status("通用听译当前支持 Chrome / Edge，Firefox 暂不支持。原有字幕翻译不受影响。"); }
})().catch(error => { status("初始化失败：" + error.message); $("start").disabled = true; });
