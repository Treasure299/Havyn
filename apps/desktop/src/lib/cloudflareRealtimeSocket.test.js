import assert from "node:assert/strict";
import test from "node:test";
import { CloudflareRealtimeSocket } from "./cloudflareRealtimeSocket.js";

const websocketState = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

function connectedSocket() {
  const sent = [];
  const wire = {
    readyState: websocketState.OPEN,
    send(message) {
      sent.push(JSON.parse(message));
    }
  };
  const socket = new CloudflareRealtimeSocket();
  socket.desiredConnection = { roomId: "ROOM1234" };
  socket.ws = wire;
  socket.scheduleReconnect = () => {};
  return { socket, wire, sent };
}

test.before(() => {
  globalThis.WebSocket = websocketState;
});

test("requeues an unacknowledged playback command once with the same ID", () => {
  const { socket, wire, sent } = connectedSocket();
  const commandId = socket.sendCommand("playback-play", { currentTime: 12 });
  assert.equal(sent.length, 1);

  socket.handleClose(wire, { code: 1006 });
  assert.equal(socket.pendingCommands.length, 1);
  assert.equal(socket.pendingCommands[0].envelope.id, commandId);
  assert.equal(socket.pendingCommands[0].attempts, 1);

  const retried = [];
  socket.ws = { readyState: websocketState.OPEN, send: (message) => retried.push(JSON.parse(message)) };
  socket.flushPendingCommands();
  assert.equal(retried.length, 1);
  assert.equal(retried[0].id, commandId);
  socket.handleMessage(socket.ws, JSON.stringify({
    v: 2,
    type: "ack",
    replyTo: commandId,
    payload: { duplicate: true }
  }));
  assert.equal(socket.pendingAcks.size, 0);
});

test("keeps only the newest queued playback intent", () => {
  const { socket, wire } = connectedSocket();
  socket.sendCommand("playback-play", { currentTime: 12 });
  socket.handleClose(wire, { code: 1006 });
  socket.sendCommand("playback-pause", { currentTime: 13 });
  assert.equal(socket.pendingCommands.length, 1);
  assert.equal(socket.pendingCommands[0].envelope.event, "playback-pause");
});

test("does not replay WebRTC signaling after a disconnect", () => {
  const { socket, wire } = connectedSocket();
  socket.sendCommand("webrtc-offer", { toUserId: "viewer" });
  socket.handleClose(wire, { code: 1006 });
  assert.equal(socket.pendingCommands.length, 0);
});
