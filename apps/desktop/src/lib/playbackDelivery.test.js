import test from "node:test";
import assert from "node:assert/strict";
import { createPlaybackDelivery } from "./playbackDelivery.js";

test("retries the newest playback command until a delayed frame is ready", async () => {
  const scheduled = [];
  let attempts = 0;
  const delivery = createPlaybackDelivery(() => {
    attempts += 1;
    return attempts >= 3;
  }, {
    schedule: (callback) => scheduled.push(callback),
    cancel: () => {}
  });

  assert.equal(await delivery.deliver({ action: "play" }), false);
  assert.equal(attempts, 1);
  await scheduled.shift()();
  assert.equal(attempts, 2);
  await scheduled.shift()();
  assert.equal(attempts, 3);
});

test("a newer pause supersedes every pending play retry", async () => {
  const scheduled = [];
  const actions = [];
  const delivery = createPlaybackDelivery((state) => {
    actions.push(state.action);
    return state.action === "pause";
  }, {
    schedule: (callback) => scheduled.push(callback),
    cancel: () => {}
  });

  await delivery.deliver({ action: "play" });
  const stalePlayRetry = scheduled.shift();
  assert.equal(await delivery.deliver({ action: "pause" }), true);
  await stalePlayRetry();
  assert.deepEqual(actions, ["play", "pause"]);
});
