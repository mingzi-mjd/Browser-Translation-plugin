/* Route listening UI messages without exposing service credentials to web pages. */
(() => {
  const extension = globalThis.browser || globalThis.chrome;
  const page = name => extension.runtime.getURL(name);
  const isControl = sender => [page("listen.html"), page("buffer.html")].includes(sender.url?.split(/[?#]/)[0]);
  const session = async () => (await extension.storage.session.get("listenSession")).listenSession;
  const send = (tabId, data) => extension.tabs.sendMessage(tabId, data, { frameId: 0 }).catch(() => null);
  const control = (session, action, extra = {}) => extension.runtime.sendMessage({ type: "listen-control", control: session.control, action, ...extra }).catch(() => null);
  const media = (tab, id, action, time, rate) => send(tab, { type: "buffer-player", id, action, time, rate });
  async function cleanup(current) {
    await send(current.target, { type: "listen-overlay", active: false, id: current.id });
    if (current.mode === "buffered") {
      await media(current.target, current.id, "release");
      if (current.source) await extension.tabs.remove(current.source).catch(() => {});
    }
    await extension.storage.session.remove("listenSession");
  }
  let serial = Promise.resolve();
  extension.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== extension.runtime.id || !String(msg?.type).startsWith("listen-")) return false;
    if (!["listen-open", "listen-claim", "listen-release", "listen-output", "listen-stop", "listen-reset", "listen-buffer-info", "listen-buffer-authorize", "listen-media", "listen-offset"].includes(msg.type)) return false;
    // serialize lifecycle mutations; output is short and does not perform network work.
    serial = serial.catch(() => {}).then(async () => {
      let controlId = sender.tab?.id;
      if (isControl(sender) && !Number.isInteger(controlId)) {
        const tab = Number.isInteger(msg.control) ? await extension.tabs.get(msg.control).catch(() => null) : null;
        if (tab?.url === sender.url) controlId = tab.id;
      }
      if (msg.type === "listen-open") {
        if (!extension.tabCapture?.getMediaStreamId) throw new Error("通用听译当前支持 Chrome / Edge；此浏览器暂不支持标签页采集。");
        const tabId = sender.tab?.id || (sender.url === page("popup.html") ? msg.tabId : null);
        if (!Number.isInteger(tabId)) throw new Error("请从目标网页的插件工具栏打开");
        const tab = await extension.tabs.get(tabId);
        if (!/^https?:\/\//.test(tab.url || "")) throw new Error("仅支持普通 HTTP / HTTPS 网页");
        const existing = await session();
        if (existing) {
          const control = await extension.tabs.get(existing.control).catch(() => null);
          if (control) { await extension.windows.update(control.windowId, { focused: true }); return { ok: true }; }
          await extension.storage.session.remove("listenSession");
        }
        const controlWindow = { url: page("listen.html") + "?tab=" + tabId, type: "popup", width: 620, height: 820 };
        if (tab.incognito) controlWindow.incognito = true;
        try {
          await extension.windows.create(controlWindow);
        } catch (error) {
          if (tab.incognito) throw new Error("无法在无痕窗口打开听译页。请在 chrome://extensions 的扩展详情中开启「允许在无痕模式下运行」后重试。");
          throw error;
        }
        return { ok: true };
      }
      if (msg.type === "listen-claim") {
        if (!isControl(sender) || !Number.isInteger(controlId)) throw new Error("仅听译控制窗口可启动");
        const target = Number(new URL(sender.url).searchParams.get("tab"));
        if (!Number.isInteger(target) || target <= 0) throw new Error("目标标签页无效");
        const old = await session();
        if (old && old.control !== controlId && await extension.tabs.get(old.control).catch(() => null)) throw new Error("另一听译窗口正在运行，请先停止它");
        const pong = await send(target, { type: "listen-ping" });
        if (!pong?.ok) throw new Error("请刷新目标网页，再重新开启听译");
        const buffered = sender.url?.split(/[?#]/)[0] === page("buffer.html");
        const value = { target, control: controlId, id: crypto.randomUUID(), mode: buffered ? "buffered" : "live" };
        if (buffered) {
          const foreground = await media(target, value.id, "prepare");
          if (!foreground?.ok) throw new Error(foreground?.error || "前台播放器不可控，请刷新页面或使用实时模式");
          try {
            const original = await extension.tabs.get(target);
            // Create muted, then navigate so autoplay cannot leak duplicate sound.
            const sourceOptions = { url: "about:blank", active: true };
            if (Number.isInteger(original.windowId)) sourceOptions.windowId = original.windowId;
            const source = await extension.tabs.create(sourceOptions);
            value.source = source.id; value.sourceReady = false;
            await extension.tabs.update(source.id, { muted: true });
            await extension.storage.session.set({ listenSession: value });
            await extension.tabs.update(source.id, { url: original.url });
          } catch (error) { await cleanup(value); throw error; }
        }
        await extension.storage.session.set({ listenSession: value });
        await send(target, { type: "listen-overlay", id: value.id, mode: value.mode, status: buffered ? "请在后台页工具栏确认采集，随后准备字幕缓冲…" : "正在连接音频…", active: true });
        return { ok: true, id: value.id };
      }
      const current = await session();
      if (msg.type === "listen-buffer-info") {
        if (sender.url !== page("popup.html")) return { ok: false };
        const [tab] = await extension.tabs.query({ active: true, currentWindow: true });
        return { ok: true, available: current?.mode === "buffered" && current.source === tab?.id };
      }
      if (!current) return { ok: true };
      if (msg.type === "listen-buffer-authorize") {
        if (sender.url !== page("popup.html") || current.mode !== "buffered") throw new Error("请从后台识别页工具栏确认");
        const [tab] = await extension.tabs.query({ active: true, currentWindow: true });
        if (tab?.id !== current.source) throw new Error("请切换到插件创建的后台页");
        if (current.authorized) throw new Error("此会话已经开始，请返回控制窗口");
        const source = await media(current.source, current.id, "prepare");
        const target = await media(current.target, current.id, "state");
        if (!source?.ok || !target?.ok) throw new Error(source?.error || target?.error || "请等待两页视频加载完成");
        if (Math.abs(source.duration - target.duration) > 1) throw new Error("两页视频时长不一致，可能有广告或不是同一视频");
        const streamId = await extension.tabCapture.getMediaStreamId({ targetTabId: current.source, consumerTabId: current.control });
        const result = await control(current, "buffer-stream", { streamId, id: current.id });
        if (!result?.ok) throw new Error("控制窗口未响应，请停止后重新开启");
        current.authorized = true; await extension.storage.session.set({ listenSession: current });
        // Source player is paused; native output will be suppressed by tab capture.
        await extension.tabs.update(current.source, { muted: false });
        return { ok: true };
      }
      if (isControl(sender) && controlId === current.control && msg.id === current.id) {
        if (msg.type === "listen-release") {
          await cleanup(current);
        } else if (msg.type === "listen-media" && current.mode === "buffered") {
          if (!["state", "pause", "play", "seek"].includes(msg.action)) throw new Error("播放器操作无效");
          if (msg.rate !== undefined && (msg.side !== "source" || ![1, 1.25, 1.5, 2].includes(msg.rate))) throw new Error("后台倍速无效");
          return await media(msg.side === "source" ? current.source : current.target, current.id, msg.action, msg.time, msg.rate) || { ok: false, error: "播放器未响应" };
        } else if (msg.type === "listen-output") {
          await send(current.target, { type: "listen-overlay", active: true, id: current.id, mode: current.mode,
            source: String(msg.source || "").slice(0, 4000), translation: String(msg.translation || "").slice(0, 8000), status: String(msg.status || "").slice(0, 300),
            offset: Number.isFinite(msg.offset) ? Math.max(-30, Math.min(30, msg.offset)) : 0 });
        }
      } else if (sender.tab?.id === current.target && sender.frameId === 0 && msg.type === "listen-offset" && msg.id === current.id && current.mode === "buffered") {
        if (![-0.5, 0, 0.5].includes(msg.delta)) throw new Error("字幕时间调整无效");
        return await control(current, "offset", { id: current.id, delta: msg.delta }) || { ok: false, error: "控制窗口未响应" };
      } else if (sender.tab?.id === current.target && sender.frameId === 0 && ["listen-stop", "listen-reset"].includes(msg.type)) {
        if (msg.type === "listen-stop" || current.mode !== "buffered") await control(current, msg.type === "listen-stop" ? "stop" : "reset");
      }
      return { ok: true };
    });
    serial.then(reply, error => reply({ ok: false, error: error.message }));
    return true;
  });
  async function tabGone(id) {
    const current = await session();
    if (!current) return;
    if (id === current.target || id === current.source) await control(current, "stop");
    if ([current.control, current.target, current.source].includes(id)) {
      await cleanup(current);
    }
  }
  extension.tabs.onRemoved.addListener(id => { serial = serial.catch(() => {}).then(() => tabGone(id)); });
  extension.tabs.onUpdated.addListener((id, change) => {
    if (!change.status) return;
    serial = serial.catch(() => {}).then(async () => {
      const current = await session();
      if (current?.source === id && !current.authorized) {
        if (change.status === "complete") { current.sourceReady = true; await extension.storage.session.set({ listenSession: current }); }
        return;
      }
      if (change.status === "loading") await tabGone(id);
    });
  });
})();
