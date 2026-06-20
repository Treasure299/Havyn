import { supabase } from "./supabaseClient";

const PLAYBACK_MODES = {
  HOST_ONLY: "host-only",
  HOST_AND_COHOSTS: "host-and-cohosts",
  EVERYONE: "everyone"
};

function projectedPlaybackState(state, at = Date.now()) {
  if (!state) return state;
  if (!state.isPlaying) return { ...state, updatedAt: at };
  return {
    ...state,
    currentTime: Number(state.currentTime || 0) + ((at - Number(state.updatedAt || at)) / 1000) * Number(state.playbackRate || 1),
    updatedAt: at
  };
}

function defaultPlaybackState(hostUserId) {
  return {
    isPlaying: false,
    currentTime: 0,
    updatedAt: Date.now(),
    playbackRate: 1,
    activeMediaUrl: "",
    activeMediaTitle: "",
    controllerUserId: hostUserId || null
  };
}

function isValidPlaybackMode(playbackMode) {
  return Object.values(PLAYBACK_MODES).includes(playbackMode);
}

async function persistPlaybackMode(roomId, playbackMode) {
  if (!supabase || !roomId || !isValidPlaybackMode(playbackMode)) return;
  await supabase
    .from("rooms")
    .update({ playback_mode: playbackMode, updated_at: new Date().toISOString() })
    .eq("id", roomId)
    .catch(() => {});
}

export class SupabaseRealtimeSocket {
  constructor() {
    this.handlers = new Map();
    this.room = null;
    this.user = null;
    this.channel = null;
    this.joinedCall = false;
    this.io = {
      on: (event, handler) => this.on(event, handler),
      off: (event, handler) => this.off(event, handler)
    };
    window.queueMicrotask(() => this.localEmit("connect"));
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) || new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  off(event, handler) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  localEmit(event, payload) {
    this.handlers.get(event)?.forEach((handler) => handler(payload));
  }

  async emit(event, payload = {}) {
    if (!supabase) return;
    if (event === "room-create") return this.joinRoom({ ...payload, room: null, role: "host", creating: true });
    if (event === "room-join") return this.joinRoom({ ...payload, role: payload.user?.role });
    if (event === "room-resume") return this.joinRoom({ roomId: payload.room?.roomId, room: payload.room, user: payload.user, role: payload.user?.role, resuming: true });
    if (event === "room-leave") return this.leaveRoom(payload);
    if (event === "havyn-heartbeat") return this.refreshPresence();
    if (event === "chat-message") return this.sendChat(payload);
    if (event === "room-playback-mode") return this.setPlaybackMode(payload);
    if (event === "room-role-update") return this.setParticipantRole(payload);
    if (event === "media-detected") return this.mediaDetected(payload);
    if (event === "playback-drift-correction") return this.driftCorrection(payload);
    if (event === "playback-sync-request") return this.syncPlayback(payload);
    if (event === "media-selected") return this.selectMedia(payload);
    if (["playback-play", "playback-pause", "playback-seek", "playback-rate-change", "media-ended"].includes(event)) return this.handlePlayback(event, payload);
    if (event === "call-join") return this.joinCall(payload);
    if (event === "call-leave") return this.leaveCall(payload);
    if (event === "call-status") return this.callStatus(payload);
    if (["webrtc-offer", "webrtc-answer", "webrtc-ice-candidate", "webrtc-ice-candidates"].includes(event)) return this.relay(event, payload);
  }

  async joinRoom({ roomId, room, roomName, visibility, user, role, creating, resuming }) {
    if (!roomId || !user?.userId) return;
    await this.closeChannel();
    this.user = user;
    this.room = {
      roomId,
      roomName: room?.roomName || roomName || "Movie Night",
      hostUserId: room?.hostUserId || (creating ? user.userId : null),
      visibility: room?.visibility || visibility || "private",
      playbackMode: room?.playbackMode || PLAYBACK_MODES.HOST_ONLY,
      participants: [],
      playbackState: projectedPlaybackState(room?.playbackState) || defaultPlaybackState(room?.hostUserId || user.userId),
      createdAt: room?.createdAt || new Date().toISOString()
    };
    if (!this.room.hostUserId && role === "host") this.room.hostUserId = user.userId;
    if (!this.room.playbackState.controllerUserId) this.room.playbackState.controllerUserId = this.room.hostUserId;

    this.channel = supabase.channel(`havyn-room:${roomId}`, {
      config: { broadcast: { self: true, ack: true }, presence: { key: user.userId } }
    });
    this.bindRoomChannel();
    this.channel.subscribe(async (status) => {
      if (status !== "SUBSCRIBED") return;
      await this.refreshPresence({
        role: role || (this.room.hostUserId === user.userId ? "host" : "viewer"),
        displayName: user.displayName
      });
      if (creating) {
        this.localEmit("chat-message", systemMessage(`${user.displayName} created the room`));
      } else if (!resuming) {
        this.broadcast("chat-message", systemMessage(`${user.displayName} joined the room`));
      }
      this.syncPlayback({ roomId });
      this.emitRoomState();
    });
  }

  bindRoomChannel() {
    const broadcastEvents = [
      "chat-message",
      "room-action",
      "permission-denied",
      "playback-state-sync",
      "playback-play",
      "playback-pause",
      "playback-seek",
      "playback-rate-change",
      "media-ended",
      "media-selected",
      "media-detected",
      "participant-media-ready",
      "call-users",
      "call-user-joined",
      "call-full",
      "call-status",
      "user-left-call",
      "presence-patch",
      "room-meta",
      "room-state",
      "webrtc-offer",
      "webrtc-answer",
      "webrtc-ice-candidate",
      "webrtc-ice-candidates"
    ];
    broadcastEvents.forEach((event) => {
      this.channel.on("broadcast", { event }, ({ payload }) => {
        if (["webrtc-offer", "webrtc-answer", "webrtc-ice-candidate", "webrtc-ice-candidates"].includes(event) && payload.toUserId !== this.user?.userId) return;
        if (["playback-state-sync", "playback-play", "playback-pause", "playback-seek", "playback-rate-change", "media-ended"].includes(event)) {
          this.updatePlaybackState(payload);
        }
        if (event === "media-selected" && payload?.playbackState) {
          this.updatePlaybackState(payload.playbackState);
        }
        if (event === "presence-patch") {
          if (payload.targetUserId === this.user?.userId) this.refreshPresence(payload.patch);
          return;
        }
        if (event === "room-meta") {
          this.room = { ...this.room, ...payload };
          this.emitRoomState();
          return;
        }
        if (event === "room-state") {
          this.applyRoomState(payload);
          return;
        }
        this.localEmit(event, payload);
      });
    });
    this.channel.on("presence", { event: "sync" }, () => this.emitRoomState());
  }

  async closeChannel() {
    if (!this.channel) return;
    await supabase.removeChannel(this.channel);
    this.channel = null;
  }

  async refreshPresence(patch = {}) {
    if (!this.channel || !this.user || !this.room) return;
    const existing = this.currentParticipant(this.user.userId) || {};
    await this.channel.track({
      userId: this.user.userId,
      displayName: patch.displayName || existing.displayName || this.user.displayName,
      role: patch.role || existing.role || (this.room.hostUserId === this.user.userId ? "host" : "viewer"),
      online: true,
      mediaReady: patch.mediaReady ?? existing.mediaReady ?? false,
      callStatus: patch.callStatus || existing.callStatus || "idle",
      muted: patch.muted ?? existing.muted ?? true,
      cameraOff: patch.cameraOff ?? existing.cameraOff ?? true,
      socketId: this.user.userId,
      joinedAt: existing.joinedAt || new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    });
    this.emitRoomState();
  }

  participants() {
    if (!this.channel) return [];
    const byUser = new Map();
    Object.values(this.channel.presenceState()).flat().forEach((item) => {
      if (!item?.userId) return;
      const current = byUser.get(item.userId);
      const itemSeenAt = new Date(item.lastSeenAt || item.joinedAt || 0).getTime();
      const currentSeenAt = new Date(current?.lastSeenAt || current?.joinedAt || 0).getTime();
      if (!current || itemSeenAt >= currentSeenAt) {
        byUser.set(item.userId, { ...current, ...item, online: true });
      }
    });
    return Array.from(byUser.values()).sort((a, b) => {
      const roleScore = { host: 0, cohost: 1, viewer: 2 };
      return (roleScore[a.role] ?? 3) - (roleScore[b.role] ?? 3)
        || String(a.displayName || "").localeCompare(String(b.displayName || ""));
    });
  }

  currentParticipant(userId) {
    return this.participants().find((participant) => participant.userId === userId);
  }

  emitRoomState() {
    if (!this.room) return;
    this.room.participants = this.participants();
    this.localEmit("room-state", { ...this.room, participants: this.room.participants });
  }

  applyRoomState(payload = {}) {
    if (!this.room || payload.roomId !== this.room.roomId) return;
    this.room = {
      ...this.room,
      roomName: payload.roomName || this.room.roomName,
      hostUserId: payload.hostUserId || this.room.hostUserId,
      visibility: payload.visibility || this.room.visibility,
      playbackMode: isValidPlaybackMode(payload.playbackMode) ? payload.playbackMode : this.room.playbackMode,
      playbackState: payload.playbackState ? { ...this.room.playbackState, ...payload.playbackState } : this.room.playbackState
    };
    this.emitRoomState();
  }

  roomStatePayload() {
    return {
      roomId: this.room?.roomId,
      roomName: this.room?.roomName,
      hostUserId: this.room?.hostUserId,
      visibility: this.room?.visibility,
      playbackMode: this.room?.playbackMode,
      playbackState: this.room?.playbackState
    };
  }

  updatePlaybackState(state) {
    if (!this.room || !state) return;
    this.room.playbackState = {
      ...this.room.playbackState,
      ...state
    };
    this.emitRoomState();
  }

  async broadcast(event, payload) {
    if (!this.channel) return;
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { value: payload };
    const result = await this.channel.send({
      type: "broadcast",
      event,
      payload: {
        ...body,
        roomId: body.roomId || this.room?.roomId,
        senderUserId: body.senderUserId || this.user?.userId
      }
    });
    if (result !== "ok") {
      console.warn(`[Havyn] Supabase signal failed for ${event}`, result);
    }
  }

  async leaveRoom({ roomId, userId }) {
    if (this.room?.roomId === roomId && this.user?.userId === userId) {
      this.broadcast("chat-message", systemMessage(`${this.user.displayName} left the room`));
      if (this.joinedCall) this.broadcast("user-left-call", { userId });
      await this.closeChannel();
      this.room = null;
      this.user = null;
      this.joinedCall = false;
    }
  }

  sendChat({ user, message }) {
    if (!message?.trim()) return;
    this.broadcast("chat-message", {
      id: crypto.randomUUID(),
      type: "user",
      userId: user.userId,
      displayName: user.displayName,
      message: message.trim().slice(0, 800),
      createdAt: new Date().toISOString()
    });
  }

  canControl(userId) {
    const participant = this.currentParticipant(userId);
    if (!this.room) return false;
    if (this.room.playbackMode === PLAYBACK_MODES.EVERYONE) return true;
    if (this.room.hostUserId === userId) return true;
    if (!participant) return false;
    if (this.room.playbackMode === PLAYBACK_MODES.HOST_AND_COHOSTS) return ["host", "cohost"].includes(participant.role);
    return participant.role === "host";
  }

  setPlaybackMode({ userId, playbackMode }) {
    if (!isValidPlaybackMode(playbackMode)) return;
    if (!this.canControl(userId)) return this.localEmit("permission-denied", { reason: "Only room controllers can change playback mode." });
    this.room.playbackMode = playbackMode;
    persistPlaybackMode(this.room.roomId, playbackMode);
    this.broadcast("room-meta", { playbackMode });
    this.broadcast("room-state", this.roomStatePayload());
    this.broadcast("room-action", roomAction(`${displayName(this, userId)} set controls to ${playbackMode}`));
    this.emitRoomState();
  }

  setParticipantRole({ actorUserId, targetUserId, role }) {
    const actor = this.currentParticipant(actorUserId);
    const target = this.currentParticipant(targetUserId);
    if (actor?.role !== "host" || !target || target.role === "host") {
      return this.localEmit("permission-denied", { reason: "Only the host can manage cohosts." });
    }
    this.refreshPresenceFor(targetUserId, { role });
    this.broadcast("room-action", roomAction(`${target.displayName} is now ${role === "cohost" ? "a cohost" : "a viewer"}`));
  }

  refreshPresenceFor(targetUserId, patch) {
    if (targetUserId !== this.user?.userId) {
      this.broadcast("presence-patch", { targetUserId, patch });
      return;
    }
    this.refreshPresence(patch);
  }

  mediaDetected({ userId, media }) {
    this.refreshPresence({ mediaReady: true });
    this.broadcast("media-detected", { userId, media });
    this.broadcast("participant-media-ready", { userId, mediaReady: true });
    this.syncPlayback({});
  }

  selectMedia({ userId, media }) {
    if (!this.canControl(userId)) return this.localEmit("permission-denied", { reason: "Playback is controlled by the host." });
    this.room.playbackState = {
      ...this.room.playbackState,
      isPlaying: media.paused === false,
      currentTime: Number(media.currentTime || 0),
      updatedAt: Date.now(),
      playbackRate: Number(media.playbackRate || 1),
      activeMediaUrl: media.url,
      activeMediaPageUrl: media.pageUrl || media.url,
      activeMediaFrameUrl: media.frameUrl || media.url,
      activeMediaTitle: media.title || "Detected media",
      controllerUserId: userId
    };
    this.localEmit("playback-state-sync", this.room.playbackState);
    this.broadcast("media-selected", { media, playbackState: this.room.playbackState });
    this.broadcast("playback-state-sync", this.room.playbackState);
    this.emitRoomState();
  }

  handlePlayback(event, { userId, currentTime, playbackRate }) {
    const action = ({
      "playback-play": "play",
      "playback-pause": "pause",
      "playback-seek": "seek",
      "playback-rate-change": "rate-change",
      "media-ended": "ended"
    })[event];
    if (!this.canControl(userId)) {
      this.localEmit("permission-denied", { reason: "Playback is controlled by the host." });
      return this.syncPlayback({});
    }
    const now = Date.now();
    const projected = projectedPlaybackState(this.room.playbackState, now);
    const next = {
      ...this.room.playbackState,
      currentTime: currentTime ?? projected.currentTime,
      updatedAt: now,
      playbackRate: playbackRate ?? this.room.playbackState.playbackRate,
      controllerUserId: userId
    };
    if (action === "play") next.isPlaying = true;
    if (action === "pause") next.isPlaying = false;
    if (action === "seek") next.currentTime = Number(currentTime || 0);
    if (action === "rate-change") next.playbackRate = Number(playbackRate || 1);
    if (action === "ended") next.isPlaying = false;
    this.room.playbackState = next;
    this.localEmit(event, next);
    this.localEmit("playback-state-sync", next);
    this.broadcast("room-action", roomAction(`${displayName(this, userId)} ${actionLabel(action)}`));
    this.broadcast(event, next);
    this.broadcast("playback-state-sync", next);
    this.emitRoomState();
  }

  driftCorrection({ userId, currentTime }) {
    if (this.canControl(userId)) return;
    const state = projectedPlaybackState(this.room?.playbackState);
    if (!state) return;
    if (Math.abs(Number(currentTime || 0) - state.currentTime) > 1.5) {
      this.localEmit("playback-state-sync", { ...state, reason: "drift-correction", correctedUserId: userId });
    }
  }

  syncPlayback() {
    const state = projectedPlaybackState(this.room?.playbackState);
    if (state) this.localEmit("playback-state-sync", { ...state, reason: "sync-request" });
  }

  joinCall({ user, muted, cameraOff }) {
    const callUsers = this.participants().filter((item) => item.callStatus === "connected");
    if (callUsers.length >= 4) return this.localEmit("call-full", { message: "Call is full. Maximum 4 participants allowed in MVP." });
    this.joinedCall = true;
    this.refreshPresence({ callStatus: "connected", muted, cameraOff });
    window.setTimeout(() => {
      this.localEmit("call-users", this.participants().filter((item) => item.userId !== user.userId && item.callStatus === "connected"));
      this.broadcast("call-user-joined", { user: { ...user, socketId: user.userId, muted, cameraOff } });
    }, 500);
  }

  leaveCall({ userId }) {
    this.joinedCall = false;
    this.refreshPresence({ callStatus: "idle", muted: true, cameraOff: true });
    this.broadcast("user-left-call", { userId });
  }

  callStatus({ userId, muted, cameraOff }) {
    this.refreshPresence({ muted, cameraOff, callStatus: "connected" });
    this.broadcast("call-status", { userId, muted, cameraOff });
  }

  relay(event, payload) {
    this.broadcast(event, payload);
  }
}

function systemMessage(message) {
  return {
    id: crypto.randomUUID(),
    type: "system",
    displayName: "Havyn",
    message,
    createdAt: new Date().toISOString()
  };
}

function roomAction(message) {
  return {
    id: crypto.randomUUID(),
    type: "playback",
    message,
    createdAt: new Date().toISOString()
  };
}

function displayName(socket, userId) {
  return socket.currentParticipant(userId)?.displayName || "Someone";
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
