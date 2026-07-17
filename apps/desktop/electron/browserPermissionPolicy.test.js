import test from "node:test";
import assert from "node:assert/strict";

import { canGrantEmbeddedBrowserPermission } from "./browserPermissionPolicy.js";

test("embedded websites may enter HTML fullscreen", () => {
  assert.equal(canGrantEmbeddedBrowserPermission("fullscreen"), true);
});

test("embedded websites cannot request sensitive permissions", () => {
  for (const permission of [
    "media",
    "display-capture",
    "screen-capture",
    "notifications",
    "geolocation",
    "clipboard-read",
    "window-management",
    "unknown"
  ]) {
    assert.equal(canGrantEmbeddedBrowserPermission(permission), false, permission);
  }
});
