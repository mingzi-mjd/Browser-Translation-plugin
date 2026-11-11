const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
let current;
function status(text, error = false) { $("status").textContent = text; $("status").className = error ? "error" : ""; }
async function init() {
  for (const id of ["target", "inputTarget"]) for (const [value, label] of Object.entries(TranslatorCore.languages)) $(id).add(new Option(label, value));
  current = TranslatorCore.settings((await api.storage.local.get("settings")).settings);
  for (const id of ["engine", "target", "inputTarget"]) $(id).value = current[id];
  $("selection").checked = current.selection;
  for (const id of ["engine", "target", "inputTarget", "selection"]) $(id).addEventListener("change", async () => {
    current = TranslatorCore.settings({ engine: $("engine").value, target: $("target").value, inputTarget: $("inputTarget").value, selection: $("selection").checked });
    try { await api.storage.local.set({ settings: current }); status("设置已保存"); } catch { status("设置保存失败，请重试", true); }
  });
}
async function action(type) {
  $("page").disabled = $("restore").disabled = true;
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("未找到当前网页");
    const result = await api.tabs.sendMessage(tab.id, { type, bypassCache: $("bypass-cache").checked });
    if (!result?.ok) throw new Error(result?.error || "操作失败");
    status(type === "floating-show" ? "已恢复悬浮按钮，并取消此网站永久关闭" : type === "page-start" ? "已开始，翻译进度显示在网页右下角" : "已还原网页");
  } catch (error) { status("无法操作此页面，请在普通网页刷新后重试。", true); }
  finally { $("page").disabled = $("restore").disabled = false; }
}
$("page").onclick = () => action("page-start");
$("restore").onclick = () => action("page-stop");
init().catch(() => status("读取设置失败，请重新打开插件", true));

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  current = TranslatorCore.settings(changes.settings.newValue);
  for (const id of ["engine", "target", "inputTarget"]) $(id).value = current[id];
  $("selection").checked = current.selection;
});

$("show-floating").onclick = () => action("floating-show");

$("open-text").onclick = async () => {
  try {
    const result = await api.runtime.sendMessage({ type: "open-text-page" });
    if (!result?.ok) throw new Error(result?.error || "打开失败");
  } catch (error) { status(error.message, true); }
};

$("engine-settings").onclick = () => api.runtime.openOptionsPage().catch(() => status("无法打开引擎设置", true));
