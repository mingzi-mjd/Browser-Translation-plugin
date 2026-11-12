/* Site-independent display. Never receives recognition credentials or audio. */
(() => {
  const api = globalThis.browser || globalThis.chrome;
  let host, root, active = false, id = "", timer, expiry, lastUrl = location.href, mode = "live";
  const bound = new WeakSet();
  function mount() {
    if (!host) {
      host = document.createElement("div"); host.dataset.lightTranslator = "listen"; host.setAttribute("translate", "no");
      host.style.cssText = "position:fixed;left:10%;bottom:12%;width:80%;z-index:2147483647;pointer-events:none";
      root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>:host{all:initial}section{font:20px/1.5 system-ui;color:white;text-align:center;background:#101c20d9;border-radius:10px;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere}header{font:12px system-ui;display:flex;justify-content:space-between;gap:10px;pointer-events:auto;cursor:move;touch-action:none}button{cursor:pointer;background:transparent;color:white;border:1px solid #ffffff60;border-radius:4px}#translation{color:#ffe6a0}#state{font:12px/1.5 system-ui;color:#cbd6d1}</style><section><header><span>通用听译 · 拖动此处移动</span><span><button id="smaller" aria-label="缩小字幕">A−</button> <button id="larger" aria-label="放大字幕">A+</button> <button id="stop">停止</button></span></header><div id="source"></div><div id="translation"></div><div id="state"></div></section>`;
      root.getElementById("stop").onclick = () => api.runtime.sendMessage({ type: "listen-stop" }).catch(() => {});
      const timing = document.createElement("div"); timing.id = "timing"; timing.hidden = true;
      timing.style.cssText = "pointer-events:auto;font:12px/1.8 system-ui;margin-top:6px";
      timing.innerHTML = `<button id="earlier" title="字幕提前 0.5 秒" aria-label="字幕提前 0.5 秒">−0.5s</button> <output id="offset" aria-live="polite">同步 0.0s</output> <button id="later" title="字幕延后 0.5 秒" aria-label="字幕延后 0.5 秒">+0.5s</button> <button id="reset-offset" title="重置字幕时间偏移">重置</button>`;
      root.querySelector("section").append(timing);
      for (const [key, delta] of [["earlier", -0.5], ["later", 0.5], ["reset-offset", 0]]) {
        root.getElementById(key).onclick = async () => {
          const session = id;
          try {
            const result = await api.runtime.sendMessage({ type: "listen-offset", id: session, delta });
            if (!active || session !== id) return;
            if (!result?.ok || !Number.isFinite(result.offset)) throw new Error(result?.error || "字幕时间调整失败");
            showOffset(result.offset);
          } catch (error) { if (active && session === id) root.getElementById("state").textContent = error.message; }
        };
      }
      let size = 20;
      for (const [key, delta] of [["smaller", -2], ["larger", 2]]) root.getElementById(key).onclick = () => { size = Math.min(40, Math.max(14, size + delta)); root.querySelector("section").style.fontSize = size + "px"; };
      const handle = root.querySelector("header"); let drag;
      handle.onpointerdown = e => { if (e.target.closest("button")) return; drag = { x: e.clientX, y: e.clientY, rect: host.getBoundingClientRect() }; handle.setPointerCapture(e.pointerId); };
      handle.onpointermove = e => {
        if (!drag) return;
        host.style.bottom = "auto";
        host.style.left = Math.max(0, Math.min(innerWidth - host.offsetWidth, drag.rect.left + e.clientX - drag.x)) + "px";
        host.style.top = Math.max(0, Math.min(innerHeight - host.offsetHeight, drag.rect.top + e.clientY - drag.y)) + "px";
      };
      handle.onpointerup = handle.onpointercancel = () => { drag = null; };
    }
    // A fullscreen iframe has its own document; don't insert UI into a replaced element.
    const full = document.fullscreenElement;
    const container = full && !["IFRAME", "VIDEO"].includes(full.tagName) ? full : document.documentElement;
    if (host.parentNode !== container) container.append(host);
    host.hidden = !active;
  }
  function showOffset(value) {
    const offset = Number.isFinite(value) ? value : 0;
    root.getElementById("offset").textContent = offset < 0 ? `提前 ${Math.abs(offset).toFixed(1)}s` : offset > 0 ? `延后 ${offset.toFixed(1)}s` : "同步 0.0s";
  }
  function reset() { if (active && mode !== "buffered") api.runtime.sendMessage({ type: "listen-reset" }).catch(() => {}); }
  function watch() {
    if (location.href !== lastUrl) { lastUrl = location.href; reset(); }
    document.querySelectorAll("video,audio").forEach(media => {
      if (bound.has(media)) return; bound.add(media);
      for (const event of ["seeking", "ratechange", "pause", "ended"]) media.addEventListener(event, reset);
    });
  }
  api.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== api.runtime.id) return;
    if (msg.type === "listen-ping") { reply({ ok: true }); return; }
    if (msg.type !== "listen-overlay") return;
    active = msg.active === true; id = msg.id; mode = msg.mode || "live";
    clearTimeout(expiry);
    if (active) {
      mount();
      root.getElementById("timing").hidden = mode !== "buffered";
      showOffset(msg.offset);
      root.getElementById("source").textContent = msg.source || "";
      root.getElementById("translation").textContent = msg.translation || "";
      root.getElementById("state").textContent = msg.status || "";
      if (msg.source) expiry = setTimeout(() => { root.getElementById("source").textContent = ""; root.getElementById("translation").textContent = ""; }, 15000);
      if (!timer) { watch(); timer = setInterval(watch, 700); }
    } else { host?.remove(); clearInterval(timer); timer = null; }
    reply({ ok: true });
  });
  document.addEventListener("fullscreenchange", () => { if (active) mount(); });
})();
