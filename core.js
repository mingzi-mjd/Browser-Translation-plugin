/* Interface reference: KISS Translator; see THIRD_PARTY.md. */
(function (root) {
  "use strict";
  const engines = ["google", "microsoft", "openai", "anthropic"];
  const defaults = { engine: "microsoft", target: "zh-CN", inputTarget: "en", selection: true };
  const languages = { "zh-CN": "简体中文", "zh-TW": "繁體中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语", de: "德语", es: "西班牙语", ru: "俄语", pt: "葡萄牙语" };
  function settings(value = {}) {
    return {
      engine: engines.includes(value.engine) ? value.engine : defaults.engine,
      target: languages[value.target] ? value.target : defaults.target,
      inputTarget: languages[value.inputTarget] ? value.inputTarget : defaults.inputTarget,
      selection: typeof value.selection === "boolean" ? value.selection : true
    };
  }
  function validateInput(engine, text, target) {
    if (!engines.includes(engine) || !languages[target]) throw new Error("翻译设置无效");
    if (typeof text !== "string" || !text.trim()) throw new Error("没有可翻译的文字");
    if (text.length > 4000) throw new Error("单次最多翻译 4000 个字符，请缩小选择范围");
  }
  function request(engine, text, target) {
    validateInput(engine, text, target);
    if (["openai", "anthropic"].includes(engine)) throw new Error("AI 翻译请通过扩展后台调用");
    if (engine === "google") {
      const query = new URLSearchParams({ client: "gtx", sl: "auto", tl: target, dt: "t", dj: "1", q: text });
      return ["https://translate.googleapis.com/translate_a/single?" + query, { method: "GET" }];
    }
    const to = { "zh-CN": "zh-Hans", "zh-TW": "zh-Hant" }[target] || target;
    const query = new URLSearchParams({ from: "", to, isEnterpriseClient: "false" });
    return ["https://edge.microsoft.com/translate/translatetext?" + query, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([text])
    }];
  }
  function parse(engine, data) {
    let result;
    if (engine === "google") result = data?.sentences?.map(x => x.trans || "").join("");
    else {
      const first = data?.[0];
      result = typeof first === "string" ? first : first?.translations?.[0]?.text;
    }
    if (typeof result !== "string" || !result.trim()) throw new Error("翻译服务返回格式异常，请切换引擎");
    return result;
  }
  async function translate(engine, text, target, fetcher = fetch) {
    const [url, init] = request(engine, text, target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(url, { ...init, credentials: "omit", signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 429 ? "请求过于频繁，请稍后再试" : "翻译服务不可用（HTTP " + response.status + "），请切换引擎");
      return parse(engine, await response.json());
    } catch (error) {
      if (error.name === "AbortError") throw new Error("翻译请求超时，请检查网络或切换引擎");
      if (error instanceof TypeError) throw new Error("无法连接翻译服务，请检查网络或切换引擎");
      throw error;
    } finally { clearTimeout(timer); }
  }
  root.TranslatorCore = { engines, defaults, languages, settings, validateInput, request, parse, translate };
  if (typeof module !== "undefined") module.exports = root.TranslatorCore;
})(globalThis);
