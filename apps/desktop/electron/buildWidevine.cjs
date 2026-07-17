const { spawnSync } = require("node:child_process");
const path = require("node:path");

const executable = process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
const command = path.join(__dirname, "..", "..", "..", "node_modules", ".bin", executable);
const result = spawnSync(command, [
  "--win",
  "nsis",
  "--config.directories.output=release-widevine"
], {
  env: { ...process.env, HAVYN_VMP_SIGN: "1" },
  stdio: "inherit",
  shell: false
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
