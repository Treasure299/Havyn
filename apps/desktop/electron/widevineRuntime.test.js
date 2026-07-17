import assert from "node:assert/strict";
import test from "node:test";
import { initializeWidevineRuntime } from "./widevineRuntime.js";

test("enables component updates and waits for Widevine", async () => {
  const reports = [];
  const api = {
    updatesEnabled: false,
    WIDEVINE_CDM_ID: "widevine",
    async whenReady(required) {
      assert.deepEqual(required, ["widevine"]);
      return [{ id: "widevine", status: "ready" }];
    },
    status: () => ({ widevine: { status: "ready" } })
  };

  const result = await initializeWidevineRuntime(api, (report) => reports.push(report));

  assert.equal(api.updatesEnabled, true);
  assert.equal(result.ready, true);
  assert.equal(reports.length, 1);
});

test("contains installation failures so Havyn can still launch", async () => {
  const api = {
    updatesEnabled: true,
    WIDEVINE_CDM_ID: "widevine",
    async whenReady() {
      throw new Error("offline");
    }
  };

  const result = await initializeWidevineRuntime(api);

  assert.deepEqual(result, {
    ready: false,
    reason: "component-install-failed",
    error: "offline",
    componentErrors: []
  });
});
