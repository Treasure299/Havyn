import assert from "node:assert/strict";
import test from "node:test";
import {
  createSingleFlightRunner,
  persistPlaybackSnapshot,
  shouldRecoverLocalPlayback,
  startPlaybackMaintenance
} from "./playbackMaintenance.js";

function testRuntime() {
  let nextId = 1;
  const intervals = new Map();
  const listeners = new Map();
  return {
    intervals,
    listeners,
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    addEventListener(event, callback) {
      listeners.set(event, callback);
    },
    removeEventListener(event, callback) {
      if (listeners.get(event) === callback) listeners.delete(event);
    }
  };
}

test("drift stays stable without periodic full snapshots and cleans up completely", () => {
  const runtimeWindow = testRuntime();
  const emitted = [];
  const reconnect = new Set();
  const socket = {
    emit: (event, payload) => emitted.push({ event, payload }),
    io: {
      on: (_event, callback) => reconnect.add(callback),
      off: (_event, callback) => reconnect.delete(callback)
    }
  };
  let currentTime = 4;
  const cleanup = startPlaybackMaintenance({
    runtimeWindow,
    socket,
    roomId: "ROOM1234",
    userId: "viewer",
    getCurrentTime: () => currentTime
  });

  assert.deepEqual(Array.from(runtimeWindow.intervals.values()).map((item) => item.delay), [4000]);
  runtimeWindow.intervals.forEach((item) => item.callback());
  assert.deepEqual(emitted.map((item) => item.event), ["playback-drift-correction"]);
  currentTime = 8;
  reconnect.forEach((callback) => callback());
  runtimeWindow.listeners.get("focus")();
  assert.equal(emitted.filter((item) => item.event === "playback-sync-request").length, 2);

  cleanup();
  assert.equal(runtimeWindow.intervals.size, 0);
  assert.equal(runtimeWindow.listeners.size, 0);
  assert.equal(reconnect.size, 0);
});

test("Supabase persistence reports failures without throwing", async () => {
  const failure = new Error("database unavailable");
  let reported;
  const client = {
    from: () => ({
      update: () => ({
        eq: async () => ({ error: failure })
      })
    })
  };
  const persisted = await persistPlaybackSnapshot({
    client,
    roomId: "ROOM1234",
    userId: "host",
    state: { activeMediaUrl: "https://example.com/movie", currentTime: 10, updatedAt: Date.now() },
    onError: (error) => { reported = error; }
  });
  assert.equal(persisted, false);
  assert.equal(reported, failure);
});

test("single-flight persistence skips overlapping writes", async () => {
  let release;
  let calls = 0;
  const task = createSingleFlightRunner(async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return true;
  });
  const first = task();
  const second = task();
  assert.equal(await second, false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
});

test("authoritative own playback is reapplied only after a recent local failure", () => {
  const state = { controllerUserId: "host" };
  assert.equal(shouldRecoverLocalPlayback({ state, userId: "host", action: "play", failure: null, now: 1000 }), false);
  assert.equal(shouldRecoverLocalPlayback({
    state,
    userId: "host",
    action: "play",
    failure: { action: "play", at: 900 },
    now: 1000
  }), true);
  assert.equal(shouldRecoverLocalPlayback({
    state,
    userId: "host",
    action: "play",
    failure: { action: "play", at: 100 },
    now: 6000
  }), false);
});
