import assert from "node:assert/strict";
import test from "node:test";
import { resolveEmbeddedCaptureSource, streamsForCaptureSelection } from "./displayMediaSelection.js";

test("captures a registered embedded browser frame without parent-window overlays", () => {
  const frame = { routingId: 7 };
  const source = resolveEmbeddedCaptureSource(42, new Set([42]), () => ({
    isDestroyed: () => false,
    mainFrame: frame
  }));
  assert.deepEqual(source, { id: "havyn:webframe:42", frame });
  assert.deepEqual(streamsForCaptureSelection({ source, withAudio: true }), {
    video: frame,
    audio: frame,
    enableLocalEcho: true
  });
});

test("rejects unregistered or destroyed embedded browser frames", () => {
  assert.equal(resolveEmbeddedCaptureSource(42, new Set(), () => ({})), null);
  assert.equal(resolveEmbeddedCaptureSource(42, new Set([42]), () => ({ isDestroyed: () => true })), null);
});

test("ordinary screen capture retains loopback audio behavior", () => {
  const source = { id: "screen:1" };
  assert.deepEqual(streamsForCaptureSelection({ source, withAudio: true }), {
    video: source,
    audio: "loopback"
  });
});
