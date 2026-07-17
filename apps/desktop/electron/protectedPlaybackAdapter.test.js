import assert from "node:assert/strict";
import test from "node:test";
import {
  applyNetflixPlayback,
  applyProtectedHtml5Playback,
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
  assert.deepEqual(calls, [["pause"]]);

  calls.length = 0;
  const corrected = await applyNetflixPlayback(windowLike, {
    action: "play",
    currentTime: 10,
    reason: "drift-correction"
  });
  assert.equal(corrected.applied, true);
  assert.deepEqual(calls, [["seek", 10_000], ["play"]]);
});

test("other protected services never receive direct timeline or rate writes", async () => {
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
  assert.equal(video.currentTime, 25);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.paused, false);

  const seek = await applyProtectedHtml5Playback({ action: "seek", currentTime: 2 }, video);
  assert.equal(seek.applied, false);
  assert.equal(video.currentTime, 25);
});
