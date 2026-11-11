const api = globalThis.browser || globalThis.chrome;
const translator = mountTextTranslator(document.getElementById("translator"), api, TranslatorCore);
translator.standalone();
(async () => {
  const token = new URLSearchParams(location.search).get("draft");
  if (!token || !/^[a-f0-9-]{36}$/.test(token)) return;
  const key = "textDraft:" + token;
  const data = await api.storage.session.get(key);
  await api.storage.session.remove(key);
  history.replaceState(null, "", location.pathname);
  if (data[key]) await translator.loadDraft(data[key]);
})().catch(() => { document.getElementById("page-status").textContent = "草稿读取失败，请重新粘贴原文"; });
