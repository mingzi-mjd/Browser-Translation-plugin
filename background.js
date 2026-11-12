/* global TranslatorCore */
if (typeof importScripts === "function") importScripts("core.js", "ai-provider.js", "translation-cache.js");
if (typeof importScripts === "function") importScripts("listen-background.js");
const api = globalThis.browser || globalThis.chrome;
let active = 0;
const waiting = [];
async function translate(message) {
  const batch = message.type === "translate-batch";
  const ai = ["openai", "anthropic"].includes(message.engine);
  if (batch && (!ai || !Array.isArray(message.texts) || !message.texts.length || message.texts.length > 8)) throw new Error("批量翻译参数无效");
  const texts = (batch ? message.texts : [message.text]);
  for (const text of texts) TranslatorCore.validateInput(message.engine, text, message.target);
  if (batch && texts.reduce((sum, text) => sum + text.length, 0) > 4000) throw new Error("批量翻译原文过长");
  const normalized = texts.map(text => text.trim());
  const config = ai ? AITranslator.validate(message.engine, await AITranslator.read(message.engine)) : null;
  const settings = await api.storage.local.get("translationCacheEnabled");
  const cacheEnabled = settings.translationCacheEnabled !== false;
  const revision = TranslationCache.revision();
  let keys = [], results = Array(texts.length).fill(null), cacheUnavailable = false;
  if (cacheEnabled) {
    try {
      keys = await TranslationCache.keys(message.engine, message.target, normalized, config);
      if (message.bypassCache !== true) results = await TranslationCache.get(keys);
    } catch { cacheUnavailable = true; }
  }
  const hits = results.filter(value => typeof value === "string").length;
  const missing = new Map();
  normalized.forEach((text, index) => {
    if (results[index] === null) {
      if (!missing.has(text)) missing.set(text, []);
      missing.get(text).push(index);
    }
  });
  if (missing.size) {
    if (waiting.length >= 100) throw new Error("翻译队列已满，请稍后重试");
    if (active >= 3) await new Promise(resolve => waiting.push(resolve)); else active++;
    try {
      const inputs = [...missing.keys()];
      const translated = ai
        ? inputs.length === 1
          ? [await AITranslator.translate(message.engine, inputs[0], message.target, config)]
          : await AITranslator.translate(message.engine, inputs, message.target, config)
        : [await TranslatorCore.translate(message.engine, inputs[0], message.target)];
      if (!Array.isArray(translated) || translated.length !== inputs.length || translated.some(text => typeof text !== "string" || !text.trim())) throw new Error("译文不完整，未写入缓存");
      const records = [];
      inputs.forEach((source, index) => {
        for (const position of missing.get(source)) results[position] = translated[index];
        if (keys.length) records.push({
          key: keys[missing.get(source)[0]], source, translation: translated[index],
          engine: message.engine, target: message.target, model: config?.model || ""
        });
      });
      if (cacheEnabled && records.length) {
        try { await TranslationCache.put(records, revision); } catch { cacheUnavailable = true; }
      }
    } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  }
  return {
    ok: true, ...(batch ? { texts: results } : { text: results[0] }),
    cacheHits: hits, requestedTexts: missing.size, networkRequests: missing.size ? 1 : 0, cacheUnavailable
  };
}
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id || !["translate", "translate-batch"].includes(message?.type)) return false;
  translate(message).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.translationCacheEnabled) TranslationCache.invalidate();
});
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id || !["cache-list", "cache-clear", "cache-delete"].includes(message?.type)) return false;
  if (sender.url?.split(/[?#]/)[0] !== api.runtime.getURL("options.html")) {
    respond({ ok: false, error: "仅设置页面可管理本地对照表" }); return false;
  }
  (async () => {
    if (message.type === "cache-list") return { ok: true, ...await TranslationCache.list(message.offset) };
    if (message.type === "cache-clear") await TranslationCache.clear();
    else await TranslationCache.remove(message.key);
    return { ok: true };
  })().then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});

async function openTextPage(message, sender) {
  if (message.text !== undefined && (typeof message.text !== "string" || message.text.length > 4000)) throw new Error("原文最多 4000 字符");
  let key;
  try {
    let url = api.runtime.getURL("translate.html");
    if (message.text) {
      const token = crypto.randomUUID();
      key = "textDraft:" + token;
      await api.storage.session.set({ [key]: { text: message.text, engine: message.engine, target: message.target } });
      url += "?draft=" + token;
    }
    const create = { url };
    const windowId = Number.isInteger(message.windowId) ? message.windowId : sender?.tab?.windowId;
    if (Number.isInteger(windowId)) create.windowId = windowId;
    await api.tabs.create(create);
  } catch (error) {
    if (key) await api.storage.session.remove(key);
    throw error;
  }
}
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id || message?.type !== "open-text-page") return false;
  openTextPage(message, sender).then(() => respond({ ok: true }), () => respond({ ok: false, error: "无法打开翻译页面，请重试" }));
  return true;
});

api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id) return false;
  if (message?.type === "open-engine-settings") {
    const options = sender.tab?.incognito && Number.isInteger(sender.tab.windowId)
      ? api.tabs.create({ url: api.runtime.getURL("options.html"), windowId: sender.tab.windowId })
      : api.runtime.openOptionsPage();
    options.then(() => respond({ ok: true }), () => respond({ ok: false, error: "无法打开引擎设置" }));
    return true;
  }
  if (!["ai-get", "ai-save", "ai-remove", "ai-list-models"].includes(message?.type)) return false;
  // Never return API keys or accept connection changes from a webpage content script.
  if (sender.url?.split(/[?#]/)[0] !== api.runtime.getURL("options.html")) {
    respond({ ok: false, error: "仅引擎设置页面可访问此配置" }); return false;
  }
  (async () => {
    if (message.type === "ai-list-models") return { ok: true, ...await AITranslator.listModels(message.provider, message.config) };
    if (message.type === "ai-get") return { ok: true, config: await AITranslator.read(message.provider) };
    if (message.type === "ai-save") {
      const config = AITranslator.validate(message.provider, message.config);
      const origin = AITranslator.permissionOrigin(config.baseUrl);
      if (!await api.permissions.contains({ origins: [origin] })) throw new Error("尚未授权此接口域名");
      await AITranslator.save(message.provider, config);
    } else await AITranslator.remove(message.provider);
    return { ok: true };
  })().then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
api.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== api.runtime.id || message?.type !== "translation-cache-lookup") return false;
  (async () => {
    if (!Array.isArray(message.texts) || message.texts.length > 200) throw new Error("缓存查询参数无效");
    for (const text of message.texts) TranslatorCore.validateInput(message.engine, text, message.target);
    const empty = { ok: true, texts: Array(message.texts.length).fill(null) };
    if ((await api.storage.local.get("translationCacheEnabled")).translationCacheEnabled === false) return empty;
    const ai = ["openai", "anthropic"].includes(message.engine);
    const config = ai ? AITranslator.validate(message.engine, await AITranslator.read(message.engine)) : null;
    const keys = await TranslationCache.keys(message.engine, message.target, message.texts, config);
    return { ok: true, texts: await TranslationCache.get(keys) };
  })().then(respond, () => respond({ ok: false, error: "本地缓存暂不可用" }));
  return true;
});
