const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const files = ["translation-cache.js", "cache-settings.js", "ai-provider.js", "options.html", "options.css", "options.js", "core.js", "text-translator.js", "translate.html", "translate.css", "translate.js", "floating.js", "background.js", "content.js", "popup.html", "popup.css", "popup.js"];
for (const browser of ["chrome", "firefox"]) {
  const out = path.join(root, "dist", browser);
  fs.mkdirSync(out, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(root, file), path.join(out, file));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (browser === "firefox") {
    manifest.background = { scripts: ["core.js", "ai-provider.js", "translation-cache.js", "background.js"] };
    manifest.browser_specific_settings = { gecko: { id: "light-translate@browser-translation.local", strict_min_version: "128.0" } };
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("Built " + out);
}
