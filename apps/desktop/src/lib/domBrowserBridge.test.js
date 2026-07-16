import assert from "node:assert/strict";
import test from "node:test";
import { domBrowserBridge, registerDomBrowser } from "./domBrowserBridge.js";

test("theatre bridge is safe before the embedded browser registers", async () => {
  assert.deepEqual(await domBrowserBridge.enterTheatre({}), {
    ok: false,
    reason: "browser-not-ready"
  });
  assert.equal(await domBrowserBridge.exitTheatre(), false);
});

test("theatre bridge contains synchronous and asynchronous cleanup failures", async () => {
  let unregister = registerDomBrowser({
    enterTheatre: () => {
      throw new Error("page already closed");
    },
    exitTheatre: () => Promise.reject(new Error("webview already destroyed"))
  });

  assert.deepEqual(await domBrowserBridge.enterTheatre({}), {
    ok: false,
    reason: "theatre-failed"
  });
  assert.equal(await domBrowserBridge.exitTheatre(), false);
  unregister();

  unregister = registerDomBrowser({
    enterTheatre: () => ({ ok: true, expandedFrames: 1 }),
    exitTheatre: () => true
  });
  assert.deepEqual(await domBrowserBridge.enterTheatre({}), { ok: true, expandedFrames: 1 });
  assert.equal(await domBrowserBridge.exitTheatre(), true);
  unregister();
});
