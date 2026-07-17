const { spawnSync } = require("node:child_process");
const path = require("node:path");

const command = process.execPath;
const builderCli = path.join(__dirname, "..", "..", "..", "node_modules", "electron-builder", "cli.js");
const result = spawnSync(command, [builderCli,
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
