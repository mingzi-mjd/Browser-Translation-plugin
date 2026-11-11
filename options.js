const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
let provider = "openai", loading = true, saving = false;
const drafts = {};
const fields = ["baseUrl", "apiKey", "model", "systemPrompt", "temperature", "sendTemperature", "maxTokens"];
function status(text, error = false) { $("status").textContent = text; $("status").className = error ? "error" : ""; }
async function message(type, extra = {}) {
  const result = await api.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || "操作失败，请重新加载插件");
  return result;
}
function formValue() {
  return { baseUrl: $("baseUrl").value, apiKey: $("apiKey").value, model: $("model").value,
    systemPrompt: $("systemPrompt").value, temperature: Number($("temperature").value),
    sendTemperature: $("sendTemperature").checked, maxTokens: Number($("maxTokens").value) };
}
function modelFeedback(text, state = "idle") {
  const feedback = $("model-feedback");
  feedback.hidden = state === "idle";
  feedback.dataset.state = state;
  feedback.setAttribute("aria-busy", String(state === "loading"));
  const progress = $("model-progress");
  progress.hidden = state === "idle";
  if (state === "loading") progress.removeAttribute("value");
  else progress.value = state === "success" ? 1 : 0;
  $("model-list-status").textContent = text;
}
function withDeadline(promise, milliseconds, hint) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(hint)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function resetModelList() {
  $("model-list").replaceChildren(new Option("请先点击「自动获取模型」", ""));
  $("model-list").disabled = true;
  modelFeedback("");
}
$("fetch-models").onclick = async () => {
  if (loading || saving) {
    modelFeedback("正在处理其他操作，请稍后再试", "error");
    return;
  }
  let config;
  try { config = AITranslator.connection(provider, { baseUrl: $("baseUrl").value, apiKey: $("apiKey").value }); }
  catch (error) { modelFeedback("无法获取模型：" + error.message, "error"); status(error.message, true); return; }
  saving = true; $("fields").disabled = true;
  resetModelList(); $("fetch-models").textContent = "正在获取…";
  let stage = "正在检查接口访问授权", started = Date.now();
  const updateProgress = () => {
    const elapsed = Math.floor((Date.now() - started) / 1000);
    modelFeedback(stage + " · 已等待 " + elapsed + " 秒" + (elapsed >= 10 ? "，服务响应较慢，请稍候…" : "…"), "loading");
  };
  updateProgress();
  const ticker = setInterval(updateProgress, 1000);
  try {
    const granted = await withDeadline(
      api.permissions.request({ origins: [AITranslator.permissionOrigin(config.baseUrl)] }),
      60000, "等待域名授权超时，请点击重试并处理浏览器的权限提示"
    );
    if (!granted) throw new Error("未授权接口域名，无法获取模型");
    stage = "正在连接服务并读取模型列表（含分页）"; started = Date.now(); updateProgress();
    const result = await withDeadline(
      message("ai-list-models", { provider, config }),
      35000, "获取模型超时或扩展后台未响应，请重试；如果刚更新插件，请重新打开设置页"
    );
    if (!Array.isArray(result.models)) throw new Error("模型返回格式异常，请重新加载插件后再试");
    if (!result.models.length) throw new Error("没有返回可选模型，可手动填写模型 ID");
    $("model-list").replaceChildren(new Option("请选择模型", ""));
    for (const model of result.models) {
      $("model-list").add(new Option(model.name && model.name !== model.id ? model.name + " · " + model.id : model.id, model.id));
    }
    $("model-list").disabled = false;
    $("model-list").value = result.models.some(model => model.id === $("model").value) ? $("model").value : "";
    clearInterval(ticker);
    const text = "获取成功：共 " + result.models.length + " 个模型" + (result.truncated ? "（列表为部分结果）" : "") + "。请在下拉框选择后保存配置。";
    modelFeedback(text, "success"); status(text);
  } catch (error) {
    clearInterval(ticker);
    const text = "获取失败：" + (error?.message || "未知错误") + "。可再次点击「自动获取模型」重试，或手动填写模型 ID。";
    modelFeedback(text, "error"); status(text, true);
    $("model-list").replaceChildren(new Option("获取失败，请重试或手动填写", ""));
    $("model-list").disabled = true;
  } finally {
    clearInterval(ticker);
    saving = false; $("fields").disabled = false; temperatureState(); $("fetch-models").textContent = "自动获取模型";
  }
};
$("model-list").onchange = () => {
  if ($("model-list").value) {
    $("model").value = $("model-list").value;
    status("已选择模型，请点击「保存配置」");
  }
};
for (const id of ["baseUrl", "apiKey"]) $(id).addEventListener("input", resetModelList);
$("model").addEventListener("input", () => {
  $("model-list").value = [...$("model-list").options].some(option => option.value === $("model").value) ? $("model").value : "";
});

function temperatureState() {
  $("temperature").disabled = $("temperature-range").disabled = !$("sendTemperature").checked;
}
function fill() {
  resetModelList();
  const config = drafts[provider];
  for (const key of fields) {
    if (key === "sendTemperature") $(key).checked = config[key]; else $(key).value = config[key];
  }
  const max = provider === "openai" ? "2" : "1";
  $("temperature").max = $("temperature-range").max = max;
  $("temperature-range").value = config.temperature;
  $("temperature-note").textContent = provider === "openai"
    ? "OpenAI 范围 0–2。部分推理模型不支持自定义采样，请取消勾选；使用 Chat Completions 协议。"
    : "Anthropic 范围 0–1，使用 2023-06-01 兼容版本；部分新模型只接受默认采样，请取消勾选。";
  for (const name of ["openai", "anthropic"]) $("tab-" + name).setAttribute("aria-pressed", String(name === provider));
  temperatureState();
}
for (const name of ["openai", "anthropic"]) $("tab-" + name).onclick = () => {
  if (loading || saving) return;
  drafts[provider] = formValue(); provider = name; fill(); status("编辑后点击保存配置");
};
$("temperature-range").oninput = () => { $("temperature").value = $("temperature-range").value; };
$("temperature").oninput = () => { $("temperature-range").value = $("temperature").value; };
$("sendTemperature").onchange = temperatureState;
$("reset-prompt").onclick = () => { $("systemPrompt").value = AITranslator.defaults(provider).systemPrompt; };
$("config").onsubmit = async event => {
  event.preventDefault();
  if (saving || loading) return;
  let config;
  try { config = AITranslator.validate(provider, formValue()); } catch (error) { status(error.message, true); return; }
  saving = true; $("fields").disabled = true;
  try {
    // Request just this origin, directly from the user's Save gesture.
    const origin = AITranslator.permissionOrigin(config.baseUrl);
    const granted = await api.permissions.request({ origins: [origin] });
    if (!granted) throw new Error("未授权接口域名，配置未保存");
    await message("ai-save", { provider, config });
    drafts[provider] = config;
    status("配置已保存。可在上方设为默认引擎，或在翻译面板单独选择。");
  } catch (error) { status(error.message, true); }
  finally { saving = false; $("fields").disabled = false; temperatureState(); }
};
$("clear-config").onclick = async () => {
  if (saving || loading) return;
  saving = true; $("fields").disabled = true;
  try {
    await message("ai-remove", { provider });
    drafts[provider] = AITranslator.defaults(provider); fill(); status("已删除此服务的密钥和配置");
  } catch (error) { status(error.message, true); }
  finally { saving = false; $("fields").disabled = false; temperatureState(); }
};
$("save-default").onclick = async () => {
  $("save-default").disabled = true;
  try {
    const engine = $("default-engine").value;
    if (["openai", "anthropic"].includes(engine)) {
      const result = await message("ai-get", { provider: engine });
      AITranslator.validate(engine, result.config);
    }
    const data = await api.storage.local.get(["settings", "textSettings"]);
    const settings = TranslatorCore.settings({ ...data.settings, engine });
    const textSettings = { ...data.textSettings, engine };
    await api.storage.local.set({ settings, textSettings });
    status("已设置默认引擎；网页翻译请重新开启，已打开的文本翻译面板请重新打开页面。");
  } catch (error) { status(error.message, true); }
  finally { $("save-default").disabled = false; }
};
(async () => {
  const [openai, anthropic, data] = await Promise.all([
    message("ai-get", { provider: "openai" }), message("ai-get", { provider: "anthropic" }), api.storage.local.get("settings")
  ]);
  drafts.openai = openai.config; drafts.anthropic = anthropic.config;
  $("default-engine").value = TranslatorCore.settings(data.settings).engine;
  fill(); loading = false; $("fields").disabled = false; status("Google / Microsoft 无需配置；AI 服务使用你自己的 API Key。");
})().catch(error => status(error.message, true));
