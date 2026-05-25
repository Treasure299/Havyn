import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import {
  addParticipant,
  getOrCreateRoom,
  getParticipantBySocket,
  listParticipants,
  removeSocketParticipant,
  restoreRoom,
  serializeRoom,
  setParticipantRole,
  setPlaybackMode,
  updateParticipant
} from "./roomManager.js";
import {
  canControlPlayback,
  getAuthoritativePlayback,
  selectMedia,
  updatePlayback
} from "./playbackManager.js";
import {
  joinCall,
  leaveCall,
  listCallUsers,
  removeSocketFromCalls,
  updateCallUser
} from "./callManager.js";

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const allowedOrigins = CLIENT_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "public");

function allowOrigin(origin, callback) {
  if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error("Origin not allowed"));
}

const app = express();
app.use(cors({ origin: allowOrigin }));
app.use(express.json());
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "havyn-server", transport: "socket.io" });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "havyn-server",
    revision: process.env.RENDER_GIT_COMMIT || "local"
  });
});

app.get("/verify", (_req, res) => {
  res.sendFile(resolve(publicDir, "verify.html"));
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: allowOrigin,
    methods: ["GET", "POST"]
  }
});

function emitRoomState(roomId) {
  io.to(roomId).emit("room-state", serializeRoom(roomId));
}

io.on("connection", (socket) => {
  socket.on("room-create", ({ roomId, roomName, user }) => {
    getOrCreateRoom(roomId, { roomName, hostUserId: user.userId });
    socket.join(roomId);
    addParticipant(roomId, {
      ...user,
      socketId: socket.id,
      roomName,
      isCreating: true,
      role: "host"
    });
    socket.data.roomId = roomId;
    socket.data.userId = user.userId;
    io.to(roomId).emit("chat-message", {
      id: crypto.randomUUID(),
      type: "system",
      displayName: "Havyn",
      message: `${user.displayName} created the room`,
      createdAt: new Date().toISOString()
    });
    emitRoomState(roomId);
  });

  socket.on("room-join", ({ roomId, user }) => {
    const room = getOrCreateRoom(roomId);
    socket.join(roomId);
    addParticipant(roomId, { ...user, socketId: socket.id });
    socket.data.roomId = roomId;
    socket.data.userId = user.userId;
    socket.emit("room-state", serializeRoom(roomId));
    socket.emit("playback-state-sync", getAuthoritativePlayback(roomId));
    socket.to(roomId).emit("chat-message", {
      id: crypto.randomUUID(),
      type: "system",
      displayName: "Havyn",
      message: `${user.displayName} joined the room`,
      createdAt: new Date().toISOString()
    });
    emitRoomState(room.roomId);
  });

  socket.on("room-resume", ({ room: snapshot, user }) => {
    if (!snapshot?.roomId || !user?.userId) return;
    const room = restoreRoom(snapshot);
    socket.join(room.roomId);
    const existing = listParticipants(room.roomId).find((participant) => participant.userId === user.userId);
    addParticipant(room.roomId, {
      ...user,
      socketId: socket.id,
      role: user.role || existing?.role || (room.hostUserId === user.userId ? "host" : "viewer")
    });
    socket.data.roomId = room.roomId;
    socket.data.userId = user.userId;
    socket.emit("room-state", serializeRoom(room.roomId));
    socket.emit("playback-state-sync", getAuthoritativePlayback(room.roomId));
    emitRoomState(room.roomId);
  });

  socket.on("room-leave", ({ roomId, userId }) => {
    const participant = listParticipants(roomId).find((item) => item.userId === userId);
    if (participant?.online) {
      socket.to(roomId).emit("chat-message", {
        id: crypto.randomUUID(),
        type: "system",
        displayName: "Havyn",
        message: `${participant.displayName} left the room`,
        createdAt: new Date().toISOString()
      });
    }
    updateParticipant(roomId, userId, { online: false, socketId: null, callStatus: "idle" });
    leaveCall(roomId, userId);
    socket.to(roomId).emit("user-left-call", { userId });
    emitRoomState(roomId);
    socket.leave(roomId);
  });

  socket.on("room-playback-mode", ({ roomId, userId, playbackMode }) => {
    if (!canControlPlayback(roomId, userId)) return socket.emit("permission-denied", { reason: "Only room controllers can change playback mode." });
    setPlaybackMode(roomId, playbackMode);
    io.to(roomId).emit("room-action", {
      id: crypto.randomUUID(),
      type: "playback-mode",
      message: `${displayNameFor(roomId, userId)} set controls to ${modeLabel(playbackMode)}`,
      createdAt: new Date().toISOString()
    });
    emitRoomState(roomId);
  });

  socket.on("room-role-update", ({ roomId, actorUserId, targetUserId, role }) => {
    const updated = setParticipantRole(roomId, actorUserId, targetUserId, role);
    if (!updated) return socket.emit("permission-denied", { reason: "Only the host can manage cohosts." });
    io.to(roomId).emit("room-action", {
      id: crypto.randomUUID(),
      type: "role",
      message: `${updated.displayName} is now ${role === "cohost" ? "a cohost" : "a viewer"}`,
      createdAt: new Date().toISOString()
    });
    emitRoomState(roomId);
  });

  socket.on("media-detected", ({ roomId, userId, media }) => {
    updateParticipant(roomId, userId, { mediaReady: true });
    io.to(roomId).emit("media-detected", { userId, media });
    io.to(roomId).emit("participant-media-ready", { userId, mediaReady: true });
    socket.emit("playback-state-sync", getAuthoritativePlayback(roomId));
    emitRoomState(roomId);
  });

  socket.on("media-selected", ({ roomId, userId, media }) => {
    const controller = resolveController(roomId, userId);
    const playbackState = selectMedia(controller.roomId, controller.userId, media);
    if (!playbackState) return socket.emit("permission-denied", { reason: playbackPermissionMessage(controller.roomId, controller) });
    io.to(controller.roomId).emit("media-selected", { media, playbackState });
    io.to(controller.roomId).emit("playback-state-sync", playbackState);
    emitRoomState(controller.roomId);
  });

  socket.on("playback-play", (payload) => handlePlayback("play", payload));
  socket.on("playback-pause", (payload) => handlePlayback("pause", payload));
  socket.on("playback-seek", (payload) => handlePlayback("seek", payload));
  socket.on("playback-rate-change", (payload) => handlePlayback("rate-change", payload));
  socket.on("media-ended", (payload) => handlePlayback("ended", payload));

  socket.on("playback-drift-correction", ({ roomId, userId, currentTime }) => {
    const state = getAuthoritativePlayback(roomId);
    if (!state) return;
    if (canControlPlayback(roomId, userId)) return;
    const drift = Math.abs(Number(currentTime || 0) - state.currentTime);
    if (drift > 1.5) {
      socket.emit("playback-state-sync", { ...state, reason: "drift-correction", correctedUserId: userId });
    }
  });

  socket.on("playback-sync-request", ({ roomId }) => {
    const targetRoomId = roomId || socket.data.roomId;
    const state = getAuthoritativePlayback(targetRoomId);
    if (state) socket.emit("playback-state-sync", { ...state, reason: "sync-request" });
  });

  socket.on("chat-message", ({ roomId, user, message }) => {
    if (!message?.trim()) return;
    io.to(roomId).emit("chat-message", {
      id: crypto.randomUUID(),
      type: "user",
      userId: user.userId,
      displayName: user.displayName,
      message: message.trim().slice(0, 800),
      createdAt: new Date().toISOString()
    });
  });

  socket.on("call-join", ({ roomId, user, muted, cameraOff }) => {
    const result = joinCall(roomId, { ...user, socketId: socket.id, muted, cameraOff });
    if (!result.ok) return socket.emit("call-full", { message: result.reason });
    socket.emit("call-users", result.users.filter((item) => item.userId !== user.userId));
    socket.to(roomId).emit("call-user-joined", { user: { ...user, socketId: socket.id, muted, cameraOff } });
    emitRoomState(roomId);
  });

  socket.on("call-leave", ({ roomId, userId }) => {
    leaveCall(roomId, userId);
    socket.to(roomId).emit("user-left-call", { userId });
    emitRoomState(roomId);
  });

  socket.on("call-status", ({ roomId, userId, muted, cameraOff }) => {
    updateCallUser(roomId, userId, { muted, cameraOff });
    io.to(roomId).emit("call-status", { userId, muted, cameraOff });
    emitRoomState(roomId);
  });

  socket.on("webrtc-offer", ({ roomId, toUserId, fromUserId, offer }) => {
    relayToUser(roomId, toUserId, "webrtc-offer", { fromUserId, offer });
  });

  socket.on("webrtc-answer", ({ roomId, toUserId, fromUserId, answer }) => {
    relayToUser(roomId, toUserId, "webrtc-answer", { fromUserId, answer });
  });

  socket.on("webrtc-ice-candidate", ({ roomId, toUserId, fromUserId, candidate }) => {
    relayToUser(roomId, toUserId, "webrtc-ice-candidate", { fromUserId, candidate });
  });

  socket.on("disconnect", () => {
    const callRemoval = removeSocketFromCalls(socket.id);
    if (callRemoval) {
      socket.to(callRemoval.roomId).emit("user-left-call", { userId: callRemoval.user.userId });
      emitRoomState(callRemoval.roomId);
    }

    const removal = removeSocketParticipant(socket.id);
    if (removal) {
      emitRoomState(removal.room.roomId);
      socket.to(removal.room.roomId).emit("chat-message", {
        id: crypto.randomUUID(),
        type: "system",
        displayName: "Havyn",
        message: `${removal.participant.displayName} left the room`,
        createdAt: new Date().toISOString()
      });
    }
  });

  function handlePlayback(action, { roomId, userId, currentTime, playbackRate }) {
    const controller = resolveController(roomId, userId);
    const playbackState = updatePlayback(controller.roomId, controller.userId, action, { currentTime, playbackRate });
    if (!playbackState) {
      socket.emit("permission-denied", { reason: playbackPermissionMessage(controller.roomId, controller) });
      socket.emit("playback-state-sync", getAuthoritativePlayback(controller.roomId));
      return;
    }
    const eventName = {
      play: "playback-play",
      pause: "playback-pause",
      seek: "playback-seek",
      "rate-change": "playback-rate-change",
      ended: "media-ended"
    }[action];
    io.to(controller.roomId).emit("room-action", {
      id: crypto.randomUUID(),
      type: "playback",
      message: `${displayNameFor(controller.roomId, controller.userId)} ${actionLabel(action)}`,
      createdAt: new Date().toISOString()
    });
    io.to(controller.roomId).emit(eventName, playbackState);
    io.to(controller.roomId).emit("playback-state-sync", playbackState);
  }

  function resolveController(roomId, payloadUserId) {
    const fallbackRoomId = roomId || socket.data.roomId;
    const socketParticipant = getParticipantBySocket(fallbackRoomId, socket.id);
    return {
      roomId: fallbackRoomId,
      userId: socketParticipant?.userId || payloadUserId || socket.data.userId,
      payloadUserId,
      socketUserId: socketParticipant?.userId || socket.data.userId,
      socketId: socket.id
    };
  }

  function relayToUser(roomId, toUserId, event, payload) {
    const participant = listParticipants(roomId).find((item) => item.userId === toUserId);
    if (participant?.socketId) io.to(participant.socketId).emit(event, payload);
  }

  function displayNameFor(roomId, userId) {
    return listParticipants(roomId).find((item) => item.userId === userId)?.displayName || "Someone";
  }

  function actionLabel(action) {
    return {
      play: "played",
      pause: "paused",
      seek: "seeked",
      "rate-change": "changed speed",
      ended: "ended playback"
    }[action] || "updated playback";
  }

  function modeLabel(playbackMode) {
    return {
      "host-only": "host only",
      "host-and-cohosts": "host and cohosts",
      everyone: "everyone"
    }[playbackMode] || playbackMode;
  }

  function playbackPermissionMessage(roomId, controller = {}) {
    const room = serializeRoom(roomId);
    if (!room) return "Room connection is refreshing. Try again in a moment.";
    if (room?.playbackMode === "host-and-cohosts") return "Playback is controlled by the host and cohosts.";
    if (room?.playbackMode === "everyone") {
      return `Playback is open to everyone, but this app window is not recognized in the room. Rejoin the room.`;
    }
    return "Playback is controlled by the host.";
  }
});

httpServer.listen(PORT, () => {
  console.log(`Havyn signaling server listening on http://localhost:${PORT}`);
});
