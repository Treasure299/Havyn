const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function findRcedit(root) {
  if (!fs.existsSync(root)) return "";
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === "rcedit-x64.exe") return fullPath;
    if (entry.isDirectory()) {
      const found = findRcedit(fullPath);
      if (found) return found;
    }
  }
  return "";
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const exePath = path.join(context.appOutDir, "Havyn.exe");
  const iconPath = path.join(context.packager.projectDir, "public", "brand", "havyn-icon.ico");
  const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign");
  const rceditPath = findRcedit(cacheRoot);

  if (!fs.existsSync(exePath) || !fs.existsSync(iconPath) || !rceditPath) return;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync(rceditPath, [exePath, "--set-icon", iconPath], { stdio: "inherit" });
      return;
    } catch (error) {
      if (attempt === 3) {
        console.warn(`[Havyn] Icon stamping skipped: ${error.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
};
