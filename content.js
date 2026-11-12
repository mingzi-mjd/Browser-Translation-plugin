(() => {
  "use strict";
  if (globalThis.__lightTranslate) return;
  globalThis.__lightTranslate = true;
  const api = globalThis.browser || globalThis.chrome;
  const core = globalThis.TranslatorCore;
  let settings = core.settings();
  const ready = api.storage.local.get("settings").then(data => { settings = core.settings(data.settings); });
  const ignored = 'script,style,noscript,code,pre,textarea,input,select,button,svg,math,.ytp-caption-window-container,.bpx-player-subtitle-wrap,.bilibili-player-video-subtitle,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-light-translator]';
  const host = document.createElement("div");
  host.dataset.lightTranslator = "ui";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    :host{all:initial}*{box-sizing:border-box}button{font:13px system-ui;cursor:pointer;border:1px solid #cbded2;border-radius:7px;padding:8px 12px;background:#fff;color:#16563f}button:hover{background:#eaf5ee}button:disabled{opacity:.5;cursor:wait}
    .primary{background:#176c51;color:white}.primary:hover{background:#10523d}
    #tools{position:fixed;bottom:20px;right:24px;display:flex;gap:8px;z-index:2147483647}
    #selection{position:fixed;left:0;top:0;z-index:2147483647;box-shadow:0 4px 16px #173c2e30;white-space:nowrap}
    #card{position:fixed;right:24px;bottom:110px;width:min(360px,calc(100vw - 32px));padding:16px;background:#fff;color:#223e30;border:1px solid #d7e4dc;border-radius:12px;box-shadow:0 12px 50px #132e3429;z-index:2147483647;font:14px/1.6 system-ui}
    header{display:flex;align-items:center;justify-content:space-between;font-weight:600}#result{white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto;margin:12px 0}#operations{display:flex;flex-wrap:wrap;gap:8px}#notice{position:fixed;right:24px;bottom:66px;max-width:min(440px,90vw);background:#173c2e;color:#fff;padding:8px 12px;border-radius:8px;z-index:2147483647;font:12px/1.5 system-ui}
    [hidden]{display:none!important}:focus-visible{outline:2px solid #176c51;outline-offset:2px}
    </style><button id="selection" type="button" hidden>译选中</button><div id="tools"><button id="input" hidden>翻译网页输入框</button></div>
    <div id="notice" role="status" hidden></div><section id="card" role="dialog" aria-label="翻译预览" hidden><header><span id="title">翻译</span><button id="close" aria-label="关闭翻译预览">×</button></header><div id="result" role="status" aria-live="polite"></div><div id="operations"></div></section>`;
  document.documentElement.append(host);
  const $ = id => shadow.getElementById(id);
  let panelVersion = 0;
  let floatingUI = null;
  function notice(text) { $("notice").hidden = !text; $("notice").textContent = text; floatingUI?.status(text, enabled); }
  function close() { panelVersion++; $("card").hidden = true; }
  $("close").onclick = close;
  document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  function panel(title) {
    const version = ++panelVersion;
    $("title").textContent = title;
    $("card").hidden = false;
    $("result").textContent = "翻译中…";
    $("operations").replaceChildren();
    return version;
  }
  function operation(label, run) {
    const button = document.createElement("button");
    button.textContent = label;
    button.onclick = async () => {
      try { await run(); } catch (error) { $("result").textContent = error.message; }
    };
    $("operations").append(button);
  }
  async function translate(text, target, engine = settings.engine) {
    const result = await api.runtime.sendMessage({ type: "translate", text, target, engine });
    if (!result?.ok) throw new Error(result?.error || "翻译失败，请刷新网页后重试");
    return result.text;
  }
  function showResult(text) {
    $("result").textContent = text;
    operation("复制译文", async () => {
      try { await navigator.clipboard.writeText(text); } catch { throw new Error("复制失败，请手动选中译文复制"); }
    });
  }

  // Keep the action beside the completed selection, not chasing the pointer.
  let selected = "";
  let selectionPoint = null;
  let selecting = false;
  let selectionFrame = 0;
  function placeSelectionButton() {
    const button = $("selection");
    if (button.hidden) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) { button.hidden = true; return; }
    let point = selectionPoint;
    if (!point) {
      const range = selection.getRangeAt(0).cloneRange();
      // Keyboard selections and scrolling use the focus end of the selection.
      if (selection.focusNode) {
        range.setStart(selection.focusNode, selection.focusOffset);
        range.collapse(true);
      }
      let rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
        button.hidden = true; return;
      }
      point = { x: rect.right, y: rect.bottom };
    }
    const margin = 8, gap = 12;
    const width = button.offsetWidth, height = button.offsetHeight;
    const x = Math.max(margin, Math.min(point.x + gap, innerWidth - width - margin));
    let y = point.y + gap;
    if (y + height > innerHeight - margin) y = point.y - height - gap;
    y = Math.max(margin, Math.min(y, innerHeight - height - margin));
    button.style.left = x + "px";
    button.style.top = y + "px";
  }
  function refreshSelection() {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const parent = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    selected = parent?.closest(ignored) ? "" : selection?.toString().trim() || "";
    $("selection").hidden = selecting || !settings.selection || !selected;
    placeSelectionButton();
  }
  function scheduleSelection() {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(refreshSelection);
  }
  document.addEventListener("selectionchange", scheduleSelection);
  document.addEventListener("pointerdown", event => {
    if (event.composedPath().includes(host) || event.button !== 0) return;
    selecting = true;
    selectionPoint = null;
    $("selection").hidden = true;
  });
  document.addEventListener("pointerup", event => {
    if (event.composedPath().includes(host) || event.button !== 0) return;
    selecting = false;
    selectionPoint = { x: event.clientX, y: event.clientY };
    scheduleSelection();
  });
  document.addEventListener("pointercancel", () => {
    selecting = false; selectionPoint = null; scheduleSelection();
  });
  document.addEventListener("keydown", event => {
    if (event.composedPath().includes(host)) return;
    selectionPoint = null;
    if (event.key === "Escape") $("selection").hidden = true;
    else scheduleSelection();
  });
  function repositionSelection() {
    selectionPoint = null;
    scheduleSelection();
  }
  document.addEventListener("scroll", repositionSelection, { capture: true, passive: true });
  window.addEventListener("resize", repositionSelection);
  window.addEventListener("blur", () => { selecting = false; $("selection").hidden = true; });
  $("selection").addEventListener("mousedown", event => event.preventDefault());
  $("selection").onclick = async () => {
    const text = selected;
    const version = panel("划词翻译");
    try {
      await ready;
      const result = await translate(text, settings.target);
      if (version === panelVersion) showResult(result);
    } catch (error) { if (version === panelVersion) $("result").textContent = error.message; }
  };

  // Retain the focused field when a toolbar button takes focus.
  let input = null;
  function editable(node) {
    if (!(node instanceof HTMLElement) || node.closest('[data-light-translator],[translate="no"],.notranslate')) return null;
    if (node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && ["text", "search"].includes(node.type)))
      return node.disabled || node.readOnly ? null : node;
    const field = node.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]');
    return field && field.getAttribute("aria-readonly") !== "true" ? field : null;
  }
  document.addEventListener("focusin", event => {
    if (event.target === host) return;
    input = editable(event.target);
    $("input").hidden = !input;
  });
  function read(field) { return "value" in field ? field.value : field.textContent; }
  function replace(field, value) {
    if (!field.isConnected || !editable(field)) throw new Error("输入框已不可编辑，请重新选择");
    if ("value" in field) {
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(field, value);
    } else {
      if (field.childElementCount) throw new Error("富文本编辑器请复制译文后手动粘贴，以保留格式");
      field.textContent = value;
    }
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }
  $("input").onclick = async () => {
    const field = input;
    if (!field?.isConnected) return;
    const original = read(field);
    const version = panel("翻译网页输入框 · 预览");
    try {
      await ready;
      const result = await translate(original, settings.inputTarget);
      if (version !== panelVersion) return;
      showResult(result);
      if (!("value" in field) && field.childElementCount) {
        const hint = document.createElement("p");
        hint.textContent = "富文本编辑器：请复制译文后手动粘贴。";
        $("operations").append(hint);
        return;
      }
      let applied = false;
      operation("替换输入内容", () => {
        if (applied || read(field) !== original) throw new Error("输入内容已变化，请关闭预览后重新翻译");
        replace(field, result);
        applied = true;
        field.focus();
      });
      operation("撤销替换", () => {
        if (!applied || read(field) !== result) throw new Error("内容已继续编辑或尚未替换，无法撤销");
        replace(field, original);
        applied = false;
        field.focus();
      });
    } catch (error) { if (version === panelVersion) $("result").textContent = error.message; }
  };

  // Prefer semantic paragraphs over nested layout wrappers and word-level spans.
  const semanticBlocks = "p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,figcaption";
  function collect(root = document.body) {
    const groups = new Map();
    const hiddenCache = new WeakMap(), blockCache = new WeakMap();
    function isHidden(element) {
      if (!element || element === document.documentElement) return false;
      if (hiddenCache.has(element)) return hiddenCache.get(element);
      const style = getComputedStyle(element);
      const hidden = element.hidden || element.getAttribute("aria-hidden") === "true" ||
        style.display === "none" || style.visibility === "hidden" || isHidden(element.parentElement);
      hiddenCache.set(element, hidden);
      return hidden;
    }
    function blockFor(parent) {
      if (blockCache.has(parent)) return blockCache.get(parent);
      let block = parent.closest(semanticBlocks);
      if (!block) {
        block = parent;
        while (block.parentElement && block !== document.body) {
          const display = getComputedStyle(block).display;
          if (!["inline", "inline-block", "inline-flex", "inline-grid", "contents"].includes(display)) break;
          block = block.parentElement;
        }
      }
      blockCache.set(parent, block);
      return block;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || !node.textContent.trim() || parent.closest(ignored) || isHidden(parent)) continue;
      const block = blockFor(parent);
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(node.textContent);
    }
    return new Map([...groups].map(([block, parts]) => [block, parts.join(" ").trim()]).filter(([, text]) => /\p{L}/u.test(text)));
  }
  let enabled = false;
  let generation = 0;
  let running = false;
  let dirty = false;
  let timer;
  let pageSettings;
  const translated = new Map();
  const observer = new MutationObserver(records => {
    const meaningful = records.some(record => {
      if (record.target.nodeType === 1 && record.target.closest("[data-light-translator]")) return false;
      if (record.target.parentElement?.closest("[data-light-translator]")) return false;
      const nodes = [...record.addedNodes, ...record.removedNodes];
      return !nodes.length || nodes.some(node => node.nodeType !== 1 || !node.hasAttribute("data-light-translator"));
    });
    if (meaningful) { dirty = true; clearTimeout(timer); timer = setTimeout(() => run(), 500); }
  });
  function stop() {
    enabled = false; generation++; running = false; dirty = false;
    clearTimeout(timer); observer.disconnect();
    for (const item of translated.values()) item.element.remove();
    translated.clear(); notice("");
  }
  async function run() {
    if (!enabled || running) return;
    const version = generation, config = { ...pageSettings };
    const isAI = ["openai", "anthropic"].includes(config.engine);
    running = true; dirty = false;
    let skipped = 0, failed = null, inFlight = 0, completedBatches = 0, cacheHits = 0, networkRequests = 0;
    const current = () => enabled && version === generation && !failed;
    try {
      const groups = collect();
      for (const [block, item] of translated) {
        if (!groups.has(block) || groups.get(block) !== item.source) { item.element.remove(); translated.delete(block); }
      }
      const candidates = [];
      for (const [block, text] of groups) {
        if (translated.has(block)) continue;
        if (text.length > 4000) { skipped++; continue; }
        const rect = block.getBoundingClientRect();
        const distance = rect.bottom < 0 ? -rect.bottom : rect.top > innerHeight ? rect.top - innerHeight : 0;
        candidates.push({ block, text, distance });
      }
      candidates.sort((a, b) => a.distance - b.distance);
      const available = Math.max(0, 200 - translated.size);
      skipped += Math.max(0, candidates.length - available);
      const chosen = candidates.slice(0, available);
      const totalBlocks = translated.size + chosen.length;
      if (!config.bypassCache && chosen.length) {
        notice("正在查询本地对照表…");
        try {
          const response = await api.runtime.sendMessage({ type: "translation-cache-lookup", engine: config.engine, target: config.target, texts: chosen.map(item => item.text) });
          if (!current()) return;
          if (response?.ok && Array.isArray(response.texts) && response.texts.length === chosen.length) {
            chosen.forEach((item, index) => {
              if (typeof response.texts[index] === "string") {
                apply(item.block, item.text, response.texts[index]);
                if (translated.has(item.block)) cacheHits++;
              }
            });
          }
        } catch { /* A cache failure must not prevent translating the page. */ }
      }
      if (!current()) return;
      // Identical labels in this scan share a result instead of making duplicate calls.
      const unique = new Map();
      for (const item of chosen) {
        if (translated.has(item.block)) continue;
        if (!unique.has(item.text)) unique.set(item.text, { text: item.text, blocks: [] });
        unique.get(item.text).blocks.push(item.block);
      }
      const batches = [];
      let batch = [], length = 0;
      for (const item of unique.values()) {
        if (batch.length && (!isAI || batch.length >= 8 || length + item.text.length > 3000)) {
          batches.push(batch); batch = []; length = 0;
        }
        batch.push(item); length += item.text.length;
      }
      if (batch.length) batches.push(batch);
      function progress() {
        if (current()) notice("双语翻译中 · " + translated.size + "/" + totalBlocks + " 段 · " +
          completedBatches + "/" + batches.length + " 批 · 本地命中 " + cacheHits + " 段 · 实际请求 " + networkRequests + " 次 · " + inFlight + " 批处理中");
      }
      function apply(block, source, result) {
        if (!block.isConnected || collect(block).get(block) !== source) { dirty = true; return; }
        const element = document.createElement("span");
        element.dataset.lightTranslator = "translation";
        element.lang = config.target;
        element.textContent = result;
        element.style.cssText = "display:block!important;margin:6px 0 10px!important;padding:4px 0 4px 10px!important;border-left:3px solid #418b6c!important;color:inherit!important;font:inherit!important;opacity:.85!important;white-space:pre-wrap!important;";
        block.append(element);
        translated.set(block, { element, source });
      }
      let nextBatch = 0;
      async function worker() {
        while (current() && nextBatch < batches.length) {
          const items = batches[nextBatch++];
          inFlight++; progress();
          try {
            const response = await api.runtime.sendMessage(isAI
              ? { type: "translate-batch", engine: config.engine, target: config.target, texts: items.map(item => item.text), bypassCache: config.bypassCache }
              : { type: "translate", engine: config.engine, target: config.target, text: items[0].text, bypassCache: config.bypassCache });
            if (!response?.ok) throw new Error(response?.error || "翻译失败");
            const results = isAI ? response.texts : [response.text];
            if (!current()) return;
            if (!Array.isArray(results) || results.length !== items.length || results.some(text => typeof text !== "string" || !text.trim())) throw new Error("批量译文不完整，已停止以避免错位");
            cacheHits += response.cacheHits || 0; networkRequests += response.networkRequests || 0;
            items.forEach((item, index) => item.blocks.forEach(block => apply(block, item.text, results[index])));
            completedBatches++;
          } catch (error) {
            if (version === generation && enabled && !failed) {
              failed = error;
              notice(error.message + "；停止发送新请求，已完成译文保留。");
            }
          } finally { inFlight--; progress(); }
        }
      }
      // Bounded workers keep local AI services from receiving the entire page at once.
      await Promise.all(Array.from({ length: Math.min(isAI ? 2 : 3, batches.length) }, worker));
      if (version !== generation || !enabled) return;
      if (failed) throw failed;
      notice("双语已开启 · " + translated.size + " 段 · 本地命中 " + cacheHits + " 段 · 实际请求 " + networkRequests + " 次" +
        (skipped ? " · " + skipped + " 段超出限制，已跳过" : "") + " · 在悬浮面板中还原");
    } catch (error) {
      if (version !== generation) return;
      enabled = false; observer.disconnect();
      notice(error.message + "；已完成的译文保留，可重新开启或还原。");
    } finally {
      if (version === generation) {
        running = false;
        if (enabled && dirty) { clearTimeout(timer); timer = setTimeout(() => run(), 500); }
      }
    }
  }
  async function start(options = {}) {
    await ready;
    stop();
    enabled = true; pageSettings = { ...settings, bypassCache: options.bypassCache === true };
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    void run();
  }
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== api.runtime.id) return false;
    if (message?.type === "page-start") {
      start({ bypassCache: message.bypassCache === true }).then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "floating-show") {
      floatingUI.show().then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "page-stop") { stop(); respond({ ok: true }); }
    return false;
  });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    applySettings(core.settings(changes.settings.newValue));
  });

  function applySettings(next) {
    const changed = JSON.stringify(settings) !== JSON.stringify(next);
    settings = next;
    refreshSelection();
    if (changed && (enabled || translated.size)) { stop(); notice("设置已更新，请重新开启双语网页"); }
    floatingUI?.sync();
  }
  floatingUI = globalThis.mountTranslationFloat({
    shadow, api, core, ready, getSettings: () => settings,
    saveSettings: async next => { await api.storage.local.set({ settings: next }); applySettings(next); },
    start, stop
  });
  ready.catch(() => notice("读取设置失败，请刷新页面"));
})();


