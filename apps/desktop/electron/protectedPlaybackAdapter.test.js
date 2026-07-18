import assert from "node:assert/strict";
import test from "node:test";
import {
  applyNetflixPlayback,
  applyProtectedHtml5Playback,
  classifyProtectedPlaybackTransition,
  isProtectedPlaybackDiscontinuity,
  readNetflixPlaybackState,
  selectNetflixPlaybackSession,
  selectProtectedPlaybackVideo,
  shouldDeduplicateProtectedTransition,
  protectedPlaybackService
} from "./protectedPlaybackAdapter.js";

test("recognizes protected streaming services without affecting ordinary sites", () => {
  assert.equal(protectedPlaybackService("https://www.netflix.com/watch/1"), "netflix");
  assert.equal(protectedPlaybackService("https://www.primevideo.com/detail/1"), "protected-html5");
  assert.equal(protectedPlaybackService("https://www.disneyplus.com/video/1"), "protected-html5");
  assert.equal(protectedPlaybackService("https://example.com/video.html"), "");
});

test("Netflix adapter uses the site player API and skips source-selection seeking", async () => {
  const calls = [];
  const player = {
    getCurrentTime: () => 42_000,
    isPaused: () => true,
    seek: (time) => calls.push(["seek", time]),
    pause: () => calls.push(["pause"]),
    play: () => calls.push(["play"])
  };
  const windowLike = {
    netflix: {
      appContext: {
        state: {
          playerApp: {
            getAPI: () => ({
              videoPlayer: {
                getAllPlayerSessionIds: () => ["watch-main"],
                getVideoPlayerBySessionId: () => player
              }
            })
          }
        }
      }
    }
  };

  const selected = await applyNetflixPlayback(windowLike, {
    action: "pause",
    currentTime: 10,
    reason: "media-selected"
  });
  assert.equal(selected.applied, true);
  assert.deepEqual(calls, []);

  calls.length = 0;
  const corrected = await applyNetflixPlayback(windowLike, {
    action: "play",
    currentTime: 10,
    reason: "drift-correction"
  });
  assert.equal(corrected.applied, true);
  assert.deepEqual(calls, [["seek", 10_000], ["play"]]);
});

test("Netflix adapter avoids small automatic drift seeks but honors explicit seeks", async () => {
  const calls = [];
  const player = {
    getCurrentTime: () => 42_000,
    isPaused: () => false,
    seek: (time) => calls.push(["seek", time]),
    play: () => calls.push(["play"])
  };
  const windowLike = {
    netflix: {
      appContext: {
        state: {
          playerApp: {
            getAPI: () => ({
              videoPlayer: {
                getAllPlayerSessionIds: () => ["watch-main"],
                getVideoPlayerBySessionId: () => player
              }
            })
          }
        }
      }
    }
  };

  await applyNetflixPlayback(windowLike, {
    action: "play",
    currentTime: 39.5,
    reason: "drift-correction"
  });
  assert.deepEqual(calls, [["play"]]);

  calls.length = 0;
  await applyNetflixPlayback(windowLike, {
    action: "seek",
    currentTime: 39.5,
    reason: "seek"
  });
  assert.deepEqual(calls, [["seek", 39_500]]);
});

test("other protected services synchronize transport, timeline, and rate on one media element", async () => {
  const video = {
    currentTime: 25,
    playbackRate: 1,
    paused: true,
    play: async () => { video.paused = false; },
    pause: () => { video.paused = true; }
  };
  const result = await applyProtectedHtml5Playback({
    action: "play",
    currentTime: 5,
    playbackRate: 2
  }, video);
  assert.equal(result.applied, true);
  assert.equal(video.currentTime, 5);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.paused, false);

  const pause = await applyProtectedHtml5Playback({ action: "pause", currentTime: 5 }, video);
  assert.equal(pause.applied, true);
  assert.equal(video.paused, true);

  const seek = await applyProtectedHtml5Playback({ action: "seek", currentTime: 2 }, video);
  assert.equal(seek.applied, true);
  assert.equal(video.currentTime, 2);

  const rate = await applyProtectedHtml5Playback({ action: "play", reason: "rate-change", playbackRate: 1.5 }, video);
  assert.equal(rate.applied, true);
  assert.equal(video.playbackRate, 1.5);
});

test("protected HTML5 source selection does not mutate an initializing DRM player", async () => {
  const video = {
    currentTime: 25,
    playbackRate: 1,
    paused: true,
    play: async () => { throw new Error("must not play"); },
    pause: () => { throw new Error("must not pause"); }
  };
  const result = await applyProtectedHtml5Playback({
    action: "play",
    currentTime: 2,
    playbackRate: 2,
    reason: "media-selected"
  }, video);
  assert.equal(result.applied, true);
  assert.equal(video.currentTime, 25);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.paused, true);
});

test("protected HTML5 playback remains pinned to the selected visible media element", () => {
  const preview = { readyState: 4, videoWidth: 1920, videoHeight: 1080, isConnected: true };
  const main = { readyState: 4, videoWidth: 1280, videoHeight: 720, isConnected: true };
  assert.equal(selectProtectedPlaybackVideo([main, preview]), preview);
  assert.equal(selectProtectedPlaybackVideo([main, preview], main), main);
  main.isConnected = false;
  assert.equal(selectProtectedPlaybackVideo([main, preview], main), preview);
});

test("reads Netflix state from the protected player API", () => {
  const windowLike = {
    netflix: {
      appContext: {
        state: {
          playerApp: {
            getAPI: () => ({
              videoPlayer: {
                getAllPlayerSessionIds: () => ["watch-main"],
                getVideoPlayerBySessionId: () => ({
                  getCurrentTime: () => 12_500,
                  isPaused: () => false
                })
              }
            })
          }
        }
      }
    }
  };
  assert.deepEqual(readNetflixPlaybackState(windowLike, null, 1000), {
    currentTime: 12.5,
    paused: false,
    playbackRate: 1,
    observedAt: 1000,
    sessionId: "watch-main"
  });
});

test("Netflix session selection stays pinned and initially follows the visible media timeline", () => {
  const players = {
    "watch-preview": { getCurrentTime: () => 1_047_000 },
    "watch-main": { getCurrentTime: () => 73_000 }
  };
  const api = {
    getAllPlayerSessionIds: () => ["watch-preview", "watch-main"],
    getVideoPlayerBySessionId: (id) => players[id]
  };
  const video = { currentTime: 72.8 };

  assert.equal(selectNetflixPlaybackSession(api, video).sessionId, "watch-main");
  video.currentTime = 1_046;
  assert.equal(selectNetflixPlaybackSession(api, video, "watch-main").sessionId, "watch-main");
});

test("protected transition guards reject timeline swaps and duplicate native actions", () => {
  assert.equal(isProtectedPlaybackDiscontinuity(
    { currentTime: 73 },
    { currentTime: 1_047 }
  ), true);
  assert.equal(isProtectedPlaybackDiscontinuity(
    { currentTime: 73 },
    { currentTime: 74 }
  ), false);

  assert.equal(shouldDeduplicateProtectedTransition(
    { eventName: "play" },
    { eventName: "play", at: 1_000 },
    1_500
  ), true);
  assert.equal(shouldDeduplicateProtectedTransition(
    { eventName: "pause" },
    { eventName: "play", at: 1_000 },
    1_500
  ), false);
  assert.equal(shouldDeduplicateProtectedTransition(
    { eventName: "seeked" },
    { eventName: "seeking", at: 1_000 },
    1_500
  ), true);
});

test("classifies protected player play, pause, seek, and steady progress", () => {
  assert.deepEqual(classifyProtectedPlaybackTransition(
    { currentTime: 10, paused: true, playbackRate: 1, observedAt: 1000 },
    { currentTime: 10, paused: false, playbackRate: 1, observedAt: 1250 }
  ), { eventName: "play" });
  assert.deepEqual(classifyProtectedPlaybackTransition(
    { currentTime: 10, paused: false, playbackRate: 1, observedAt: 1000 },
    { currentTime: 10.2, paused: true, playbackRate: 1, observedAt: 1250 }
  ), { eventName: "pause" });
  assert.deepEqual(classifyProtectedPlaybackTransition(
    { currentTime: 10, paused: false, playbackRate: 1, observedAt: 1000 },
    { currentTime: 35, paused: false, playbackRate: 1, observedAt: 1250 }
  ), { eventName: "seeked" });
  assert.equal(classifyProtectedPlaybackTransition(
    { currentTime: 10, paused: false, playbackRate: 1, observedAt: 1000 },
    { currentTime: 10.25, paused: false, playbackRate: 1, observedAt: 1250 }
  ), null);
});
