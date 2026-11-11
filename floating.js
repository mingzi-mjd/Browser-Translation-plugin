/* Page-side controls; mounted inside the content script's isolated shadow root. */
globalThis.mountTranslationFloat = function ({ shadow, api, core, ready, getSettings, saveSettings, start, stop }) {
  const template = document.createElement("template");
  template.innerHTML = `<style>
    #float-button{position:fixed;right:16px;top:40vh;width:46px;height:46px;padding:0;border-radius:15px;background:#176c51;color:#fff;border:1px solid #ffffff70;box-shadow:0 4px 18px #173c2e30;font:bold 22px system-ui;z-index:2147483646;touch-action:none;user-select:none;cursor:grab}
    #float-button:active{cursor:grabbing}#float-button[data-active="true"]{box-shadow:0 0 0 3px #a7d7ba,0 4px 18px #173c2e30}
    #float-button[data-compact="true"]{width:16px;min-width:16px;border-radius:7px;font-size:14px;box-shadow:0 1px 6px #173c2e30;border:1px solid #ffffff80;opacity:1;cursor:pointer}
    #float-panel .float-tabs{display:flex;gap:8px;margin-bottom:12px}#float-panel .float-tabs button{flex:1}#float-panel .float-tabs button[aria-pressed="true"]{background:#176c51;color:#fff}
    #float-panel fieldset{border:1px solid #d1dfd6;border-radius:8px;margin:12px 0;padding:10px}#float-panel fieldset label{font-weight:400}
    #float-panel{position:fixed;width:min(310px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:18px;border:1px solid #d7e4dc;border-radius:16px;background:#f8faf7;color:#223e30;box-shadow:0 12px 45px #132e3430;z-index:2147483647;font:13px/1.5 system-ui}
    #float-panel header{font-size:17px;margin-bottom:14px}#float-panel label{display:block;margin:10px 0;font-weight:600}#float-panel select{display:block;width:100%;box-sizing:border-box;margin-top:5px;padding:8px;border:1px solid #d1dfd6;border-radius:8px;background:white;color:#223e30;font:13px system-ui}
    #float-panel .float-actions{display:flex;gap:8px;margin:16px 0}#float-start{flex:1}#float-panel .float-check{display:flex;gap:6px;align-items:center;font-size:12px}#float-panel p{font-size:12px;color:#66786d;margin:8px 0}#float-status{overflow-wrap:anywhere}#float-panel footer{border-top:1px solid #dce4de;padding-top:10px;margin-top:12px;color:#6c7e72;font-size:11px}
    </style><button id="float-button" hidden type="button" title="双语翻译 · 点击打开，拖动调整位置" aria-label="打开双语翻译面板" aria-controls="float-panel" aria-expanded="false">译</button>
    <section id="float-panel" role="dialog" aria-label="双语翻译控制面板" hidden>
    <header><span>双语翻译</span><span><button id="float-minimize" title="缩小并贴边" aria-label="缩小悬浮按钮">−</button> <button id="float-close" title="关闭悬浮按钮" aria-label="关闭悬浮按钮">×</button></span></header>
    <nav class="float-tabs" aria-label="翻译功能"><button id="float-tab-text" aria-pressed="false">文本翻译</button><button id="float-tab-web" aria-pressed="true">网页工具</button></nav>
    <div id="float-text-section" hidden></div><div id="float-web-section">
    <label>翻译引擎<select id="float-engine"><option value="microsoft">Microsoft 微软翻译</option><option value="google">Google 谷歌翻译</option><option value="openai">OpenAI / 兼容接口</option><option value="anthropic">Anthropic Claude</option></select></label>
    <button id="float-engine-settings">翻译引擎设置</button><label>网页 / 划词译为<select id="float-target"></select></label>
    <label class="float-check"><input id="float-bypass-cache" type="checkbox">忽略缓存重新翻译</label><div class="float-actions"><button id="float-start" class="primary">开启双语网页</button><button id="float-stop">还原网页</button></div>
    <label>翻译网页输入框 · 译为<select id="float-inputTarget"></select></label>
    <label class="float-check"><input id="float-selection" type="checkbox">显示划词翻译按钮</label>
    <p>选中文字点「译选中」；点击网页上的搜索框、评论框后点「翻译网页输入框」，预览后替换。</p>
    <p id="float-status" role="status" aria-live="polite">准备就绪</p>
    </div><fieldset id="float-close-options" hidden><legend>关闭悬浮按钮</legend><label><input type="radio" name="float-close-scope" value="once" checked>仅本次关闭</label><label><input type="radio" name="float-close-scope" value="site">此网站永久关闭</label><p>仅本次关闭：刷新后恢复。永久关闭：当前域名下的页面均隐藏。</p><div class="float-actions"><button id="float-cancel-close">取消</button><button id="float-confirm-close" class="primary">确认关闭</button></div><p id="float-close-error" role="status"></p></fieldset><footer>拖动「译」可调整位置 · 设置与工具栏同步</footer></section>`;
  shadow.append(template.content);
  const $ = id => shadow.getElementById("float-" + id);
  const button = $("button"), panel = $("panel");
  globalThis.mountTextTranslator($("text-section"), api, core);
  function switchSection(section) {
    for (const name of ["text", "web"]) {
      $(name + "-section").hidden = name !== section;
      $("tab-" + name).setAttribute("aria-pressed", String(name === section));
    }
    placePanel();
  }
  $("tab-text").onclick = () => switchSection("text");
  $("tab-web").onclick = () => switchSection("web");
  new ResizeObserver(() => placePanel()).observe(panel);
  let position = { side: "right", ratio: 0.4 };
  let movedByUser = false;
  let compact = false;
  let hiddenOnce = false;
  let hiddenForSite = false;
  let visibilityRevision = 0;
  const siteKey = "floatingHidden:" + location.hostname;
  function updateVisibility() {
    button.hidden = hiddenOnce || hiddenForSite;
    if (button.hidden) close();
  }
  let drag = null, suppressClick = false;
  let saving = Promise.resolve();
  const clamp = (n, min, max) => Math.max(min, Math.min(n, Math.max(min, max)));
  // innerWidth includes the scrollbar; use the visible document area for bounds.
  const viewportWidth = () => document.documentElement.clientWidth || innerWidth;
  const viewportHeight = () => document.documentElement.clientHeight || innerHeight;
  function placePanel() {
    if (panel.hidden) return;
    const rect = button.getBoundingClientRect();
    const width = panel.offsetWidth, height = panel.offsetHeight;
    const left = position.side === "right" ? rect.left - width - 10 : rect.right + 10;
    panel.style.left = clamp(left, 12, viewportWidth() - width - 12) + "px";
    panel.style.top = clamp(rect.top, 12, viewportHeight() - height - 12) + "px";
  }
  function placeButton() {
    button.dataset.compact = String(compact);
    button.textContent = compact ? (position.side === "left" ? "›" : "‹") : "译";
    button.title = compact ? "展开双语翻译按钮" : "双语翻译 · 点击打开，拖动调整位置";
    button.setAttribute("aria-label", compact ? "展开双语翻译按钮" : "打开双语翻译面板");
    // Anchor to the actual viewport edge instead of positioning under its scrollbar.
    const inset = compact ? "0px" : "12px";
    button.style.left = position.side === "left" ? inset : "auto";
    button.style.right = position.side === "right" ? inset : "auto";
    button.style.borderRadius = compact
      ? (position.side === "left" ? "0 7px 7px 0" : "7px 0 0 7px") : "15px";
    button.style.top = clamp(position.ratio * Math.max(0, viewportHeight() - 70), 12, viewportHeight() - 58) + "px";
    placePanel();
  }
  function close(focus = false) {
    $("close-options").hidden = true;
    panel.hidden = true; button.setAttribute("aria-expanded", "false");
    if (focus) button.focus({ preventScroll: true });
  }
  button.onclick = () => {
    if (suppressClick) { suppressClick = false; return; }
    if (compact) { compact = false; placeButton(); return; }
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) { sync(); placePanel(); }
  };
  $("minimize").onclick = () => { compact = true; close(); placeButton(); button.focus({ preventScroll: true }); };
  $("close").onclick = () => {
    $("close-options").hidden = false;
    $("close-error").textContent = "";
    placePanel();
    $("close-options").scrollIntoView({ block: "nearest" });
  };
  $("cancel-close").onclick = () => { $("close-options").hidden = true; placePanel(); };
  $("confirm-close").onclick = async () => {
    $("confirm-close").disabled = true;
    try {
      const scope = shadow.querySelector('input[name="float-close-scope"]:checked').value;
      if (scope === "site") {
        await api.storage.local.set({ [siteKey]: true });
        hiddenForSite = true;
      } else hiddenOnce = true;
      visibilityRevision++;
      updateVisibility();
    } catch { $("close-error").textContent = "保存失败，请重试"; }
    finally { $("confirm-close").disabled = false; }
  };
  document.addEventListener("pointerdown", event => {
    const path = event.composedPath();
    if (!path.includes(panel) && !path.includes(button)) close();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) close(true);
  });
  button.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    suppressClick = false;
    const rect = button.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true; compact = false; placeButton(); close();
    button.style.right = "auto";
    button.style.left = clamp(drag.left + dx, 12, viewportWidth() - 58) + "px";
    button.style.top = clamp(drag.top + dy, 12, viewportHeight() - 58) + "px";
  });
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.moved) {
      movedByUser = true; suppressClick = true;
      const rect = button.getBoundingClientRect();
      position = { side: rect.left + 23 < viewportWidth() / 2 ? "left" : "right", ratio: clamp(rect.top / Math.max(1, viewportHeight() - 70), 0, 1) };
      placeButton();
      api.storage.local.set({ floatingPosition: position }).catch(() => {});
    }
    drag = null;
  }
  button.addEventListener("pointerup", endDrag);
  button.addEventListener("pointercancel", endDrag);
  window.addEventListener("resize", placeButton);
  for (const id of ["target", "inputTarget"]) for (const [value, label] of Object.entries(core.languages)) {
    const option = document.createElement("option"); option.value = value; option.textContent = label; $(id).append(option);
  }
  function sync() {
    const settings = getSettings();
    for (const key of ["engine", "target", "inputTarget"]) $(key).value = settings[key];
    $("selection").checked = settings.selection;
  }
  for (const key of ["engine", "target", "inputTarget", "selection"]) $(key).onchange = () => {
    const value = key === "selection" ? $(key).checked : $(key).value;
    saving = saving.then(async () => {
      await ready;
      await saveSettings(core.settings({ ...getSettings(), [key]: value }));
      $("status").textContent = "设置已保存";
    }).catch(() => { sync(); $("status").textContent = "保存失败，请刷新网页后重试"; });
  };
  $("start").onclick = async () => {
    $("start").disabled = true;
    try { await saving; await start({ bypassCache: $("bypass-cache").checked }); } catch { $("status").textContent = "启动失败，请刷新网页后重试"; }
    finally { $("start").disabled = false; }
  };
  $("stop").onclick = () => stop();
  $("engine-settings").onclick = async () => {
    try {
      const result = await api.runtime.sendMessage({ type: "open-engine-settings" });
      if (!result?.ok) throw new Error(result?.error || "打开失败");
    } catch (error) { $("status").textContent = error.message; }
  };
  placeButton();
  ready.then(sync).catch(() => { $("status").textContent = "读取设置失败，请刷新网页"; });
  const initialRevision = visibilityRevision;
  const visibilityReady = api.storage.local.get(["floatingPosition", siteKey]).then(data => {
    if (initialRevision === visibilityRevision) { hiddenForSite = data[siteKey] === true; updateVisibility(); }
    const p = data.floatingPosition;
    if (!movedByUser && p && ["left", "right"].includes(p.side) && Number.isFinite(p.ratio)) {
      position = { side: p.side, ratio: clamp(p.ratio, 0, 1) }; placeButton();
    }
  }).catch(() => { updateVisibility(); });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[siteKey]) return;
    visibilityRevision++;
    hiddenForSite = changes[siteKey].newValue === true;
    updateVisibility();
  });
  async function show() {
    await visibilityReady;
    await api.storage.local.remove(siteKey);
    visibilityRevision++;
    hiddenOnce = false; hiddenForSite = false; compact = false;
    updateVisibility(); placeButton();
  }
  return { sync, show, status(text, active) {
    $("status").textContent = text || "准备就绪";
    button.dataset.active = String(active);
    $("start").textContent = active ? "重新翻译网页" : "开启双语网页";
    placePanel();
  } };
};
