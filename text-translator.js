globalThis.mountTextTranslator = function (container, api, core) {
  const template = document.createElement("template");
  template.innerHTML = `<style>
  .text-translator [hidden]{display:none!important}.text-translator{font:14px/1.5 system-ui;color:#223e30}.text-translator .text-options{display:flex;gap:10px}.text-translator label{display:block;flex:1;margin:10px 0;font-weight:600}
  .text-translator select,.text-translator textarea{box-sizing:border-box;width:100%;border:1px solid #ceded4;border-radius:9px;padding:10px;background:#fff;color:#223e30;font:14px/1.6 system-ui;margin-top:6px}
  .text-translator textarea{display:block;min-height:120px;resize:vertical}.text-translator textarea[readonly]{background:#eff5f0}
  .text-translator .text-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.text-translator button{padding:8px 12px;border:1px solid #cbded2;border-radius:8px;background:white;color:#16563f;font:13px system-ui;cursor:pointer}.text-translator button.primary{background:#176c51;color:white}.text-translator button:disabled{opacity:.5;cursor:default}
  .text-translator .text-count,.text-translator .text-status,.text-translator .text-hint{font-size:12px;color:#64796b}.text-translator .text-status{min-height:18px}.text-translator :focus-visible{outline:2px solid #176c51;outline-offset:2px}
  </style><section class="text-translator">
  <div class="text-options"><label>翻译引擎<select data-field="engine"><option value="microsoft">Microsoft</option><option value="google">Google</option><option value="openai">OpenAI / 兼容接口</option><option value="anthropic">Anthropic Claude</option></select></label><label>译为<select data-field="target"></select></label></div>
  <button data-field="engine-settings">翻译引擎设置</button><label>原文<textarea data-field="source" maxlength="4000" placeholder="在这里输入或粘贴需要翻译的文字…" spellcheck="false"></textarea></label>
  <div class="text-count" data-field="count">0 / 4000 · 自动识别原文语言</div>
  <div class="text-actions"><button data-field="translate" class="primary" disabled>翻译文本</button><button data-field="clear">清空</button><button data-field="open">独立页面打开</button></div>
  <label><input data-field="bypass-cache" type="checkbox">忽略缓存重新翻译</label><label>译文<textarea data-field="result" readonly placeholder="译文会显示在这里"></textarea></label>
  <div class="text-actions"><button data-field="copy" disabled>复制译文</button><button data-field="copy-camel" disabled>复制小驼峰</button><button data-field="copy-pascal" disabled>复制大驼峰</button><button data-field="copy-snake" disabled>复制下划线</button><button data-field="copy-kebab" disabled>复制-命名</button></div><label data-field="manual-copy" hidden>命名结果（可手动复制）<textarea data-field="copy-value" readonly></textarea></label>
  <div class="text-status" data-field="status" role="status" aria-live="polite"></div>
  <p class="text-hint">点击翻译才会发送文字 · Ctrl / ⌘ + Enter 翻译</p></section>`;
  container.append(template.content);
  const $ = name => container.querySelector('[data-field="' + name + '"]');
  for (const [value, label] of Object.entries(core.languages)) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; $("target").append(option);
  }
  let version = 0, busy = false, initialized = false, touched = false;
  function refresh() {
    $("count").textContent = $("source").value.length + " / 4000 · 自动识别原文语言";
    $("translate").disabled = !initialized || busy || !$("source").value.trim();
    $("translate").textContent = busy ? "翻译中…" : "翻译文本";
    for (const key of ["copy", "copy-camel", "copy-pascal", "copy-snake", "copy-kebab"]) $(key).disabled = !$("result").value;
  }
  function invalidate() {
    $("manual-copy").hidden = true; $("copy-value").value = "";
    version++; busy = false; $("result").value = ""; $("status").textContent = ""; refresh();
  }
  const ready = api.storage.local.get(["settings", "textSettings"]).then(data => {
    const settings = core.settings(data.settings);
    if (!touched) {
      $("engine").value = core.engines.includes(data.textSettings?.engine) ? data.textSettings.engine : settings.engine;
      $("target").value = core.languages[data.textSettings?.target] ? data.textSettings.target : settings.target;
    }
    initialized = true; refresh();
  }).catch(() => {
    $("engine").value = "microsoft"; $("target").value = "zh-CN";
    initialized = true; refresh(); $("status").textContent = "未能读取设置，已使用默认值";
  });
  $("engine-settings").onclick = async () => {
    try {
      const result = await api.runtime.sendMessage({ type: "open-engine-settings" });
      if (!result?.ok) throw new Error(result?.error || "打开失败");
    } catch (error) { $("status").textContent = error.message; }
  };
  $("source").oninput = invalidate;
  for (const key of ["engine", "target"]) $(key).onchange = () => {
    touched = true; invalidate();
    api.storage.local.set({ textSettings: { engine: $("engine").value, target: $("target").value } }).catch(() => { $("status").textContent = "设置保存失败，当前选择仍可使用"; });
  };
  $("translate").onclick = async () => {
    const text = $("source").value;
    if (!text.trim() || busy) return;
    const ticket = ++version;
    $("manual-copy").hidden = true; $("copy-value").value = "";
    busy = true; $("result").value = ""; $("status").textContent = "正在翻译…"; refresh();
    try {
      await ready;
      if (ticket !== version) return;
      const result = await api.runtime.sendMessage({ type: "translate", text, engine: $("engine").value, target: $("target").value, bypassCache: $("bypass-cache").checked });
      if (ticket !== version) return;
      if (!result?.ok) throw new Error(result?.error || "翻译失败，请重试");
      $("result").value = result.text; $("status").textContent = result.cacheHits ? "已使用本地缓存，无需请求服务" : "翻译完成 · 实际请求 " + (result.networkRequests || 1) + " 次" + (result.cacheUnavailable ? "（缓存暂不可用，未能完整读写）" : "");
    } catch (error) { if (ticket === version) $("status").textContent = error.message; }
    finally { if (ticket === version) { busy = false; refresh(); } }
  };
  $("source").onkeydown = event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) {
      event.preventDefault(); $("translate").click();
    }
  };
  $("clear").onclick = () => { $("source").value = ""; invalidate(); $("source").focus(); };
  const namingFormats = {
    camel: { label: "小驼峰", example: "userName" },
    pascal: { label: "大驼峰", example: "UserName" },
    snake: { label: "下划线", example: "user_name" },
    kebab: { label: "-命名", example: "user-name" }
  };
  function formatName(text, format) {
    const words = text.normalize("NFKC")
      .replace(/['’]/g, "")
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu)
      ?.map(word => word.toLowerCase()) || [];
    const capitalize = word => {
      const [first, ...rest] = [...word];
      return first.toUpperCase() + rest.join("");
    };
    if (format === "snake") return words.join("_");
    if (format === "kebab") return words.join("-");
    return words.map((word, index) => format === "camel" && index === 0 ? word : capitalize(word)).join("");
  }
  for (const [format, info] of Object.entries(namingFormats)) {
    const button = $("copy-" + format);
    button.title = info.example;
    button.onclick = () => copyText(formatName($("result").value, format), info.label + "已复制", true);
  }
  async function copyText(text, message, formatted = false) {
    if (!text) { $("status").textContent = "译文中没有可转换的文字或数字"; return; }
    try {
      await navigator.clipboard.writeText(text);
      $("manual-copy").hidden = true;
      $("status").textContent = message;
    } catch {
      const field = formatted ? $("copy-value") : $("result");
      if (formatted) { $("manual-copy").hidden = false; field.value = text; }
      field.focus(); field.select();
      $("status").textContent = "请按 Ctrl / ⌘ + C 复制已选中的" + (formatted ? "命名结果" : "译文");
    }
  }
  $("copy").onclick = () => copyText($("result").value, "译文已复制");
  $("open").onclick = async () => {
    $("open").disabled = true;
    try {
      await ready;
      const response = await api.runtime.sendMessage({ type: "open-text-page", text: $("source").value, engine: $("engine").value, target: $("target").value });
      if (!response?.ok) throw new Error(response?.error || "打开失败，请重试");
    } catch (error) { $("status").textContent = error.message; }
    finally { $("open").disabled = false; }
  };
  return {
    ready,
    standalone() { $("open").hidden = true; },
    async loadDraft(draft) {
      await ready;
      $("source").value = typeof draft.text === "string" ? draft.text.slice(0, 4000) : "";
      if (core.engines.includes(draft.engine)) $("engine").value = draft.engine;
      if (core.languages[draft.target]) $("target").value = draft.target;
      invalidate();
    }
  };
};
