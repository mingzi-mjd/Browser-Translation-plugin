const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const files = ["buffer.html", "buffer.js", "buffer-player.js", "listen.html", "listen.js", "listen-worklet.js", "listen-background.js", "listen-overlay.js", "youtube-bridge.js", "bilibili-bridge.js", "video-subtitles.js", "translation-cache.js", "cache-settings.js", "ai-provider.js", "options.html", "options.css", "options.js", "core.js", "text-translator.js", "translate.html", "translate.css", "translate.js", "floating.js", "background.js", "content.js", "popup.html", "popup.css", "popup.js"];
for (const browser of ["chrome", "firefox"]) {
  const out = path.join(root, "dist", browser);
  fs.mkdirSync(out, { recursive: true });
  // Replaced by the shared video controller; remove only this obsolete generated file.
  fs.rmSync(path.join(out, "youtube-subtitles.js"), { force: true });
  for (const file of files) fs.copyFileSync(path.join(root, file), path.join(out, file));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (browser === "firefox") {
    manifest.permissions = manifest.permissions.filter(permission => permission !== "tabCapture");
    manifest.background = { scripts: ["core.js", "ai-provider.js", "translation-cache.js", "listen-background.js", "background.js"] };
    manifest.browser_specific_settings = { gecko: { id: "light-translate@browser-translation.local", strict_min_version: "128.0" } };
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("Built " + out);
}
