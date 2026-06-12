import * as Ably from "ably";
import { supabase } from "./supabaseClient";

const PLAYBACK_MODES = {
  HOST_ONLY: "host-only",
  HOST_AND_COHOSTS: "host-and-cohosts",
  EVERYONE: "everyone"
};

const PLAYBACK_EVENTS = ["playback-play", "playback-pause", "playback-seek", "playback-rate-change", "media-ended"];
const DIRECT_EVENTS = ["webrtc-offer", "webrtc-answer", "webrtc-ice-candidate", "webrtc-ice-candidates"];

const CHANNEL_GROUPS = {
  control: "control",
  chat: "chat",
  playback: "playback",
  call: "call",
  presence: "presence"
};

const EVENT_GROUPS = {
  "chat-message": CHANNEL_GROUPS.chat,
  "room-action": CHANNEL_GROUPS.chat,
  "permission-denied": CHANNEL_GROUPS.control,
  "room-meta": CHANNEL_GROUPS.control,
  "room-state": CHANNEL_GROUPS.control,
  "presence-patch": CHANNEL_GROUPS.presence,
  "media-detected": CHANNEL_GROUPS.playback,
  "media-selected": CHANNEL_GROUPS.playback,
  "participant-media-ready": CHANNEL_GROUPS.playback,
  "playback-sync-request": CHANNEL_GROUPS.playback,
  "playback-state-sync": CHANNEL_GROUPS.playback,
  "playback-play": CHANNEL_GROUPS.playback,
  "playback-pause": CHANNEL_GROUPS.playback,
  "playback-seek": CHANNEL_GROUPS.playback,
  "playback-rate-change": CHANNEL_GROUPS.playback,
  "playback-drift-correction": CHANNEL_GROUPS.playback,
  "media-ended": CHANNEL_GROUPS.playback,
  "call-users": CHANNEL_GROUPS.call,
  "call-user-joined": CHANNEL_GROUPS.call,
  "call-full": CHANNEL_GROUPS.call,
  "call-status": CHANNEL_GROUPS.call,
  "user-left-call": CHANNEL_GROUPS.call,
  "webrtc-offer": CHANNEL_GROUPS.call,
  "webrtc-answer": CHANNEL_GROUPS.call,
  "webrtc-ice-candidate": CHANNEL_GROUPS.call,
  "webrtc-ice-candidates": CHANNEL_GROUPS.call
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

function ablyKey() {
  return import.meta.env.VITE_ABLY_API_KEY || "";
}

function roomChannelName(roomId) {
  return `havyn:room:${roomId}`;
}

function groupedRoomChannelName(roomId, group) {
  return `${roomChannelName(roomId)}:${group}`;
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

export class AblyRealtimeSocket {
  constructor() {
    this.handlers = new Map();
    this.room = null;
    this.user = null;
    this.client = null;
    this.channel = null;
    this.channels = new Map();
    this.channelSubscriptions = [];
    this.presenceSubscription = null;
    this.presenceItems = [];
    this.splitPresenceItems = [];
    this.legacyPresenceItems = [];
    this.seenSignalIds = new Set();
    this.legacyBridgeUntil = 0;
    this.lastPresenceSignature = "";
    this.lastPresenceUpdateAt = 0;
    this.joinedCall = false;
    this.clientUserId = null;
    this.publishCounters = new Map();
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

  ensureClient(user) {
    if (this.client && this.clientUserId === user.userId) return this.client;
    this.client?.close();
    const key = ablyKey();
    if (!key) {
      this.localEmit("permission-denied", { reason: "Ably is not configured yet. Add VITE_ABLY_API_KEY." });
      return null;
    }
    this.clientUserId = user.userId;
    this.client = new Ably.Realtime({
      key,
      clientId: user.userId,
      autoConnect: true,
      echoMessages: true
    });
    this.client.connection.on("connected", () => this.localEmit("connect"));
    this.client.connection.on("update", (stateChange) => {
      if (stateChange.current === "connected") this.localEmit("connect");
    });
    return this.client;
  }

  async emit(event, payload = {}) {
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
    if (event === "playback-sync-request") return this.requestPlaybackSync(payload);
    if (event === "media-selected") return this.selectMedia(payload);
    if (PLAYBACK_EVENTS.includes(event)) return this.handlePlayback(event, payload);
    if (event === "call-join") return this.joinCall(payload);
    if (event === "call-leave") return this.leaveCall(payload);
    if (event === "call-status") return this.callStatus(payload);
    if (DIRECT_EVENTS.includes(event)) return this.relay(event, payload);
  }

  async joinRoom({ roomId, room, roomName, visibility, user, role, creating, resuming }) {
    if (!roomId || !user?.userId) return;
    const client = this.ensureClient(user);
    if (!client) return;
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

    this.channel = client.channels.get(roomChannelName(roomId));
    this.channels = new Map(Object.values(CHANNEL_GROUPS).map((group) => [
      group,
      client.channels.get(groupedRoomChannelName(roomId, group))
    ]));
    this.bindRoomChannel();
    await Promise.all(this.allRoomChannels().map((channel) => channel.attach()));
    await this.refreshPresence({
      role: role || (this.room.hostUserId === user.userId ? "host" : "viewer"),
      displayName: user.displayName
    });
    if (creating) {
      this.localEmit("chat-message", systemMessage(`${user.displayName} created the room`));
    } else if (!resuming) {
      await this.broadcast("chat-message", systemMessage(`${user.displayName} joined the room`));
    }
    await this.syncPresence();
    this.syncPlayback({ roomId });
    this.emitRoomState();
  }

  bindRoomChannel() {
    const events = Object.keys(EVENT_GROUPS);
    events.forEach((event) => {
      const channels = this.subscribeChannelsForEvent(event);
      channels.forEach((channel) => {
        const handler = (message) => {
          const payload = message.data;
          const fromLegacyChannel = channel.name === this.channel?.name;
          if (this.isDuplicateSignal(payload)) return;
          if (fromLegacyChannel && message.clientId !== this.user?.userId) {
            this.enableLegacyBridge();
          }
          if (DIRECT_EVENTS.includes(event) && payload.toUserId !== this.user?.userId) return;
          if (event === "playback-sync-request") {
            this.answerPlaybackSync(payload);
            return;
          }
          if (event === "playback-state-sync" && payload.targetUserId && payload.targetUserId !== this.user?.userId) return;
          if (["playback-state-sync", ...PLAYBACK_EVENTS].includes(event)) {
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
        };
        channel.subscribe(event, handler);
        this.channelSubscriptions.push({ channel, event, handler });
      });
    });
    const presenceChannels = this.presenceChannels();
    this.presenceSubscription = () => this.syncPresence();
    presenceChannels.forEach((channel) => channel.presence.subscribe(this.presenceSubscription));
  }

  async closeChannel() {
    if (!this.channel && this.channels.size === 0) return;
    this.channelSubscriptions.forEach(({ channel, event, handler }) => {
      channel.unsubscribe(event, handler);
    });
    this.channelSubscriptions = [];
    const presenceChannels = this.presenceChannels();
    if (this.presenceSubscription) {
      presenceChannels.forEach((channel) => channel.presence.unsubscribe(this.presenceSubscription));
    }
    this.presenceSubscription = null;
    await Promise.all(this.primaryPresenceChannels().map((channel) => channel.presence.leave().catch(() => {})));
    await Promise.all(this.allRoomChannels().map((channel) => channel.detach().catch(() => {})));
    this.channel = null;
    this.channels.clear();
    this.presenceItems = [];
    this.splitPresenceItems = [];
    this.legacyPresenceItems = [];
    this.seenSignalIds.clear();
    this.legacyBridgeUntil = 0;
  }

  async syncPresence() {
    const splitPresenceChannel = this.channelForGroup(CHANNEL_GROUPS.presence);
    const legacyPresenceChannel = this.channel;
    const [splitItems, legacyItems] = await Promise.all([
      splitPresenceChannel?.presence.get().catch(() => []) || [],
      legacyPresenceChannel && legacyPresenceChannel.name !== splitPresenceChannel?.name
        ? legacyPresenceChannel.presence.get().catch(() => [])
        : []
    ]);
    this.splitPresenceItems = splitItems;
    this.legacyPresenceItems = legacyItems;
    this.presenceItems = [...splitItems, ...legacyItems];
    if (legacyItems.some((item) => item.clientId !== this.user?.userId)) {
      this.enableLegacyBridge();
    }
    this.emitRoomState();
  }

  async refreshPresence(patch = {}) {
    const presenceChannels = this.primaryPresenceChannels();
    if (!presenceChannels.length || !this.user || !this.room) return;
    const existing = this.currentParticipant(this.user.userId) || {};
    const data = {
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
    };
    const signature = JSON.stringify({
      userId: data.userId,
      displayName: data.displayName,
      role: data.role,
      mediaReady: data.mediaReady,
      callStatus: data.callStatus,
      muted: data.muted,
      cameraOff: data.cameraOff
    });
    const now = Date.now();
    if (signature === this.lastPresenceSignature && now - this.lastPresenceUpdateAt < 8_000) {
      return;
    }
    this.lastPresenceSignature = signature;
    this.lastPresenceUpdateAt = now;
    await Promise.all(presenceChannels.map((channel) => (
      channel.presence.update(data).catch(() => channel.presence.enter(data))
    )));
    this.presenceItems = this.presenceItems.filter((item) => item.clientId !== this.user.userId);
    this.presenceItems.push({ clientId: this.user.userId, data });
    this.emitRoomState();
  }

  participants() {
    const byUser = new Map();
    this.presenceItems.forEach((item) => {
      const data = item.data || {};
      if (!data.userId) return;
      const current = byUser.get(data.userId);
      const itemSeenAt = new Date(data.lastSeenAt || data.joinedAt || 0).getTime();
      const currentSeenAt = new Date(current?.lastSeenAt || current?.joinedAt || 0).getTime();
      if (!current || itemSeenAt >= currentSeenAt) {
        byUser.set(data.userId, { ...current, ...data, online: true });
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
    const channels = this.publishChannelsForEvent(event);
    if (!channels.length) return;
    const body = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : { value: payload };
    const signalId = body.signalId || crypto.randomUUID();
    const outbound = {
      ...body,
      signalId,
      roomId: body.roomId || this.room?.roomId,
      senderUserId: body.senderUserId || this.user?.userId
    };
    this.recordPublish(event);
    await Promise.all(channels.map((channel) => (
      channel.publish(event, outbound).catch((error) => {
        console.warn(`[Havyn] Ably signal failed for ${event}`, error);
      })
    )));
  }

  channelForEvent(event) {
    return this.channelForGroup(EVENT_GROUPS[event] || CHANNEL_GROUPS.control);
  }

  subscribeChannelsForEvent(event) {
    return this.uniqueChannels([this.channelForEvent(event), this.channel]);
  }

  publishChannelsForEvent(event) {
    const primary = this.channelForEvent(event);
    if (this.shouldPublishLegacy(event)) return this.uniqueChannels([primary, this.channel]);
    return this.uniqueChannels([primary]);
  }

  channelForGroup(group) {
    return this.channels.get(group) || this.channel;
  }

  presenceChannels() {
    return this.uniqueChannels([this.channelForGroup(CHANNEL_GROUPS.presence), this.channel]);
  }

  primaryPresenceChannels() {
    return this.uniqueChannels([this.channelForGroup(CHANNEL_GROUPS.presence)]);
  }

  allRoomChannels() {
    return this.uniqueChannels([this.channel, ...Array.from(this.channels.values())]);
  }

  enableLegacyBridge(duration = 10 * 60 * 1000) {
    this.legacyBridgeUntil = Math.max(this.legacyBridgeUntil, Date.now() + duration);
  }

  shouldPublishLegacy(event) {
    if (!this.channel || this.channelForEvent(event)?.name === this.channel.name) return false;
    if (Date.now() < this.legacyBridgeUntil) return true;
    return this.legacyPresenceItems.some((item) => item.clientId !== this.user?.userId);
  }

  uniqueChannels(channels = []) {
    const seen = new Set();
    return channels.filter((channel) => {
      if (!channel || seen.has(channel.name)) return false;
      seen.add(channel.name);
      return true;
    });
  }

  rememberSignal(signalId) {
    if (!signalId) return;
    this.seenSignalIds.add(signalId);
    if (this.seenSignalIds.size > 500) {
      this.seenSignalIds = new Set(Array.from(this.seenSignalIds).slice(-250));
    }
  }

  isDuplicateSignal(payload = {}) {
    if (!payload.signalId) return false;
    if (this.seenSignalIds.has(payload.signalId)) return true;
    this.rememberSignal(payload.signalId);
    return false;
  }


  recordPublish(event) {
    const second = Math.floor(Date.now() / 1000);
    const key = `${second}:${event}`;
    const count = (this.publishCounters.get(key) || 0) + 1;
    this.publishCounters.set(key, count);
    if (count === 20) {
      console.warn(`[Havyn] High realtime publish rate for ${event}. This can trigger Ably limits.`);
    }
    if (this.publishCounters.size > 250) {
      const cutoff = second - 10;
      this.publishCounters.forEach((_value, itemKey) => {
        if (Number(itemKey.split(":")[0]) < cutoff) this.publishCounters.delete(itemKey);
      });
    }
  }

  async leaveRoom({ roomId, userId }) {
    if (this.room?.roomId === roomId && this.user?.userId === userId) {
      await this.broadcast("chat-message", systemMessage(`${this.user.displayName} left the room`));
      if (this.joinedCall) await this.broadcast("user-left-call", { userId });
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
    if (!this.room || !participant) return false;
    if (this.room.playbackMode === PLAYBACK_MODES.EVERYONE) return true;
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

  requestPlaybackSync({ userId } = {}) {
    this.broadcast("playback-sync-request", {
      userId: userId || this.user?.userId,
      requestedAt: Date.now()
    });
  }

  answerPlaybackSync({ userId } = {}) {
    if (!userId || userId === this.user?.userId) return;
    const current = this.currentParticipant(this.user?.userId);
    if (!current || !this.canControl(this.user.userId)) return;
    const state = projectedPlaybackState(this.room?.playbackState);
    if (!state) return;
    this.broadcast("playback-state-sync", {
      ...state,
      reason: "sync-response",
      targetUserId: userId
    });
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
