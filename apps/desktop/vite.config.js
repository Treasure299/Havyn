import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const appPackage = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"));

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: {
    __HAVYN_VERSION__: JSON.stringify(appPackage.version)
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
