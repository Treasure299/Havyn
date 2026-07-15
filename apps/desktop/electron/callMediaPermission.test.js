import assert from "node:assert/strict";
import test from "node:test";
import { createCallMediaPermissionGate } from "./callMediaPermission.js";

test("call media is denied until Havyn explicitly joins a call", () => {
  const gate = createCallMediaPermissionGate(() => 10);
  assert.equal(gate.canGrant(10, "media"), false);
  assert.equal(gate.setActive(10, true), true);
  assert.equal(gate.canGrant(10, "media"), true);
});

test("embedded and unrelated renderers cannot obtain media permission", () => {
  const gate = createCallMediaPermissionGate(() => 10);
  gate.setActive(10, true);
  assert.equal(gate.canGrant(99, "media"), false);
  assert.equal(gate.canGrant(10, "notifications"), false);
  assert.equal(gate.setActive(99, false), false);
  assert.equal(gate.canGrant(10, "media"), true);
});

test("leaving or failing a call revokes permission", () => {
  const gate = createCallMediaPermissionGate(() => 10);
  gate.setActive(10, true);
  assert.equal(gate.setActive(10, false), false);
  assert.equal(gate.canGrant(10, "media"), false);
  gate.setActive(10, true);
  gate.reset();
  assert.equal(gate.canGrant(10, "media"), false);
});
