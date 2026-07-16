import assert from "node:assert/strict";
import test from "node:test";
import { selectCaptureGeometry } from "./captureGeometry.js";

test("selects window coordinates when the captured source includes the frame", () => {
  const outer = { cropRect: { x: 8, y: 72, width: 1200, height: 700 }, displayBounds: { width: 1280, height: 800 } };
  const content = { cropRect: { x: 8, y: 16, width: 1200, height: 700 }, displayBounds: { width: 1280, height: 744 } };
  assert.equal(selectCaptureGeometry(1280, 800, [content, outer]), outer);
});

test("selects content coordinates when Chromium reports content-only dimensions", () => {
  const outer = { cropRect: { x: 8, y: 72, width: 1200, height: 700 }, displayBounds: { width: 1280, height: 800 } };
  const content = { cropRect: { x: 8, y: 16, width: 1200, height: 700 }, displayBounds: { width: 1280, height: 744 } };
  assert.equal(selectCaptureGeometry(1280, 744, [outer, content]), content);
});

test("uses the supplied fallback when no candidates are valid", () => {
  const fallback = { cropRect: { x: 1, y: 2, width: 3, height: 4 }, displayBounds: { width: 5, height: 6 } };
  assert.equal(selectCaptureGeometry(1280, 720, [], fallback), fallback);
});
