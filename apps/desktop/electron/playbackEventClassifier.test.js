import assert from "node:assert/strict";
import test from "node:test";
import { createRemotePlaybackExpectation, matchesRemotePlaybackEvent } from "./playbackEventClassifier.js";

test("a remote pause never suppresses the user's next local play", () => {
  const expectation = createRemotePlaybackExpectation({ action: "pause", currentTime: 42, playbackRate: 1 }, 1_000);

  assert.equal(matchesRemotePlaybackEvent(expectation, "pause", { currentTime: 42, paused: true }, 1_100), true);
  assert.equal(matchesRemotePlaybackEvent(expectation, "play", { currentTime: 42, paused: false }, 1_150), false);
});

test("a remote play never suppresses the user's next local pause", () => {
  const expectation = createRemotePlaybackExpectation({ action: "play", currentTime: 18, playbackRate: 1 }, 2_000);

  assert.equal(matchesRemotePlaybackEvent(expectation, "play", { currentTime: 18, paused: false }, 2_100), true);
  assert.equal(matchesRemotePlaybackEvent(expectation, "pause", { currentTime: 18.1, paused: true }, 2_150), false);
});

test("remote seek and rate echoes are still suppressed", () => {
  const expectation = createRemotePlaybackExpectation({ action: "play", currentTime: 75, playbackRate: 1.25 }, 3_000);

  assert.equal(matchesRemotePlaybackEvent(expectation, "seeked", { currentTime: 75.4 }, 3_100), true);
  assert.equal(matchesRemotePlaybackEvent(expectation, "ratechange", { playbackRate: 1.25 }, 3_100), true);
  assert.equal(matchesRemotePlaybackEvent(expectation, "seeked", { currentTime: 80 }, 3_100), false);
});

test("expired commands do not suppress later user events", () => {
  const expectation = createRemotePlaybackExpectation({ action: "play" }, 4_000, 500);
  assert.equal(matchesRemotePlaybackEvent(expectation, "play", { paused: false }, 4_501), false);
});
