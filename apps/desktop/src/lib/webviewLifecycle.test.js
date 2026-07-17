import assert from "node:assert/strict";
import test from "node:test";
import { getAttachedWebContentsId } from "./webviewLifecycle.js";

test("webview id is unavailable before the element is attached", () => {
  assert.equal(getAttachedWebContentsId({
    isConnected: false,
    getWebContentsId: () => {
      throw new Error("must not be called");
    }
  }), null);
});

test("webview id lookup contains Electron's pre-dom-ready exception", () => {
  assert.equal(getAttachedWebContentsId({
    isConnected: true,
    getWebContentsId: () => {
      throw new Error("dom-ready has not fired");
    }
  }), null);
});

test("webview id is returned once Electron is ready", () => {
  assert.equal(getAttachedWebContentsId({
    isConnected: true,
    getWebContentsId: () => 42
  }), 42);
});
