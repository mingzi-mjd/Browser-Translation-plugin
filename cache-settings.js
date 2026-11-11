(() => {
  const api = globalThis.browser || globalThis.chrome;
  const $ = id => document.getElementById(id);
  let offset = 0, total = 0, busy = false;
  function report(text, error = false) { $("cache-status").textContent = text; $("cache-status").className = error ? "error" : ""; }
  async function call(type, extra = {}) {
    const result = await api.runtime.sendMessage({ type, ...extra });
    if (!result?.ok) throw new Error(result?.error || "缓存管理暂不可用");
    return result;
  }
  function controls() {
    for (const id of ["cache-refresh", "cache-clear", "cache-enabled"]) $(id).disabled = busy;
    $("cache-prev").disabled = busy || offset === 0;
    $("cache-next").disabled = busy || offset + 30 >= total;
  }
  async function load() {
    if (busy) return;
    busy = true; controls(); report("正在读取本地对照表…");
    try {
      let data = await call("cache-list", { offset });
      if (offset >= data.total && offset > 0) {
        offset = Math.max(0, Math.floor((data.total - 1) / 30) * 30);
        data = await call("cache-list", { offset });
      }
      total = data.total;
      $("cache-records").replaceChildren();
      for (const row of data.rows) {
        const article = document.createElement("article"); article.className = "cache-record";
        const heading = document.createElement("div"); heading.className = "cache-heading";
        const label = document.createElement("strong");
        label.textContent = row.engine + (row.model ? " · " + row.model : "") + " → " + row.target;
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "删除";
        remove.onclick = async () => {
          if (busy) return;
          busy = true; controls(); remove.disabled = true;
          try { await call("cache-delete", { key: row.key }); busy = false; await load(); }
          catch (error) { busy = false; report(error.message, true); }
          finally { controls(); remove.disabled = false; }
        };
        heading.append(label, remove); article.append(heading);
        for (const [name, text] of [["原文", row.source], ["译文", row.translation]]) {
          const title = document.createElement("b"); title.textContent = name;
          const content = document.createElement("pre"); content.textContent = text;
          article.append(title, content);
        }
        const date = document.createElement("small");
        date.textContent = "最近使用：" + new Date(row.lastUsed).toLocaleString() + " · 到期：" + new Date(row.expiresAt).toLocaleDateString();
        article.append(date); $("cache-records").append(article);
      }
      report(total ? "共 " + total + " 条 · 显示 " + (offset + 1) + "–" + Math.min(offset + 30, total) + " 条" : "对照表为空，成功翻译后会自动保存。");
    } catch (error) { report(error.message, true); }
    finally { busy = false; controls(); }
  }
  $("cache-refresh").onclick = () => load();
  $("cache-prev").onclick = () => { offset = Math.max(0, offset - 30); load(); };
  $("cache-next").onclick = () => { offset += 30; load(); };
  $("cache-clear").onclick = async () => {
    if (busy || !confirm("确定清空全部本地翻译对照表？已保存的引擎配置不会被删除。")) return;
    busy = true; controls();
    try { await call("cache-clear"); offset = 0; busy = false; await load(); }
    catch (error) { report(error.message, true); }
    finally { busy = false; controls(); }
  };
  $("cache-enabled").onchange = async () => {
    const enabled = $("cache-enabled").checked;
    try {
      await api.storage.local.set({ translationCacheEnabled: enabled });
      report(enabled ? "已开启本地缓存" : "已关闭缓存读写；现有记录保留，可单独清空");
    } catch { $("cache-enabled").checked = !enabled; report("保存失败，请重试", true); }
  };
  api.storage.local.get("translationCacheEnabled").then(data => {
    $("cache-enabled").checked = data.translationCacheEnabled !== false;
    load();
  }).catch(() => report("读取缓存设置失败，请重新打开页面", true));
})();
