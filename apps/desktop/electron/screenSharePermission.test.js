import assert from "node:assert/strict";
import test from "node:test";
import { createScreenSharePermissionGate } from "./screenSharePermission.js";

test("screen capture requires a source explicitly selected by Havyn", () => {
  const source = { id: "screen:1", name: "Screen 1" };
  const gate = createScreenSharePermissionGate(() => 10);
  assert.equal(gate.consume(10), null);
  assert.equal(gate.registerSources(10, [source]), true);
  assert.equal(gate.select(10, source.id, true, { captureMode: "browser-region" }), true);
  assert.equal(gate.canGrant(10), true);
  assert.equal(gate.canGrant(99), false);
  const selection = gate.consume(10);
  assert.equal(selection.source, source);
  assert.equal(selection.withAudio, true);
  assert.deepEqual(selection.metadata, { captureMode: "browser-region" });
  assert.equal(typeof selection.expiresAt, "number");
  assert.equal(gate.consume(10), null);
  assert.equal(gate.canGrant(10), true);
  assert.equal(gate.canGrant(99), false);
});

test("embedded and unrelated renderers cannot arm or consume capture", () => {
  const source = { id: "window:1", name: "Window" };
  const gate = createScreenSharePermissionGate(() => 10);
  assert.equal(gate.registerSources(99, [source]), false);
  assert.equal(gate.registerSources(10, [source]), true);
  assert.equal(gate.select(99, source.id, false), false);
  assert.equal(gate.select(10, source.id, false), true);
  assert.equal(gate.consume(99), null);
});

test("stale capture selection expires and reset revokes it", () => {
  let time = 1_000;
  const source = { id: "screen:1", name: "Screen" };
  const gate = createScreenSharePermissionGate(() => 10, () => time);
  gate.registerSources(10, [source]);
  gate.select(10, source.id, false);
  time += 31_000;
  assert.equal(gate.canGrant(10), false);
  assert.equal(gate.consume(10), null);
  gate.registerSources(10, [source]);
  gate.select(10, source.id, false);
  gate.reset();
  assert.equal(gate.consume(10), null);
  assert.equal(gate.canGrant(10), false);
});

test("consumed capture keeps a short renderer-bound permission grant", () => {
  let time = 5_000;
  const source = { id: "screen:1", name: "Screen" };
  const gate = createScreenSharePermissionGate(() => 10, () => time);
  gate.registerSources(10, [source]);
  gate.select(10, source.id, false);
  assert.ok(gate.consume(10));
  assert.equal(gate.canGrant(10), true);
  time += 10_001;
  assert.equal(gate.canGrant(10), false);
});
