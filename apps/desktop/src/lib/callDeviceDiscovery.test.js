import assert from "node:assert/strict";
import test from "node:test";
import { discoverNamedCallDevices, splitCallDevices } from "./callDeviceDiscovery.js";

test("splits audio and video inputs from unrelated devices", () => {
  const microphone = { kind: "audioinput", deviceId: "mic", label: "Studio microphone" };
  const camera = { kind: "videoinput", deviceId: "cam", label: "Front camera" };
  assert.deepEqual(splitCallDevices([microphone, { kind: "audiooutput" }, camera]), {
    audioInputs: [microphone],
    videoInputs: [camera]
  });
});

test("pre-call discovery reveals labels, stops probe tracks, and revokes access", async () => {
  const calls = [];
  const tracks = [{ stop: () => calls.push("audio-stopped") }, { stop: () => calls.push("video-stopped") }];
  const devices = [
    { kind: "audioinput", deviceId: "mic", label: "USB microphone" },
    { kind: "videoinput", deviceId: "cam", label: "HD webcam" }
  ];
  const result = await discoverNamedCallDevices({
    getUserMedia: async () => ({ getTracks: () => tracks }),
    enumerateDevices: async () => devices
  }, async (active) => {
    calls.push(active ? "permission-on" : "permission-off");
    return true;
  });
  assert.deepEqual(result, { audioInputs: [devices[0]], videoInputs: [devices[1]] });
  assert.deepEqual(calls, ["permission-on", "audio-stopped", "video-stopped", "permission-off"]);
});
