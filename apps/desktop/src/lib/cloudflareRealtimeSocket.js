import { supabase } from "./supabaseClient.js";

const PROTOCOL_VERSION = 2;
const DEFAULT_ENDPOINT = "http://localhost:8787";
const DO_NOT_QUEUE = new Set([
  "havyn-heartbeat",
  "playback-drift-correction",
  "webrtc-offer",
  "webrtc-answer",
  "webrtc-ice-candidate",
  "webrtc-ice-candidates"
]);
const MAX_RETRY_ATTEMPTS = 1;
const MAX_RETRY_AGE_MS = 15_000;

function queuedCommandGroup(event) {
  if (["playback-play", "playback-pause", "playback-seek", "playback-rate-change", "media-ended"].includes(event)) {
    return "playback-control";
  }
  if (["playback-sync-request", "media-detected", "participant-media-ready", "call-status"].includes(event)) {
    return event;
  }
  return null;
}

function coordinatorEndpoint() {
  return (import.meta.env?.VITE_CLOUDFLARE_ROOM_URL || DEFAULT_ENDPOINT).replace(/\/$/, "");
}

function websocketEndpoint(endpoint, roomId, ticket) {
  const url = new URL(`${endpoint}/v2/rooms/${encodeURIComponent(roomId)}/connect`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export class CloudflareRealtimeSocket {
  constructor() {
    this.handlers = new Map();
    this.ws = null;
    this.room = null;
    this.user = null;
    this.desiredConnection = null;
    this.pendingCommands = [];
    this.pendingAcks = new Map();
    this.intentionalClose = false;
    this.connecting = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.generation = 0;
    this.hasConnected = false;
    this.io = {
      on: (event, handler) => this.on(event, handler),
      off: (event, handler) => this.off(event, handler)
    };
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
    if (event === "room-create") {
      return this.connectRoom({ ...payload, room: null, creating: true, resuming: false });
    }
    if (event === "room-join") {
      return this.connectRoom({ ...payload, creating: false, resuming: false });
    }
    if (event === "room-resume") {
      return this.connectRoom({
        roomId: payload.room?.roomId,
        room: payload.room,
        user: payload.user,
        creating: false,
        resuming: true
      });
    }
    if (event === "room-leave") return this.leaveRoom(payload);
    if (event === "havyn-heartbeat") return this.heartbeat();
    return this.sendCommand(event, payload);
  }

  async connectRoom(connection) {
    if (!connection.roomId || !connection.user?.userId) return;
    const normalized = {
      ...connection,
      roomId: String(connection.roomId).toUpperCase(),
      room: connection.room ? { ...connection.room, roomId: String(connection.roomId).toUpperCase() } : null
    };
    const sameRoom = this.desiredConnection?.roomId === normalized.roomId && this.user?.userId === normalized.user.userId;
    this.desiredConnection = normalized;
    this.user = normalized.user;
    if (sameRoom && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws?.readyState)) return;
    this.intentionalClose = false;
    this.clearReconnect();
    return this.openConnection();
  }

  async openConnection() {
    if (this.connecting || !this.desiredConnection) return this.connecting;
    const generation = ++this.generation;
    this.connecting = this.requestTicket(this.desiredConnection)
      .then(({ ticket }) => {
        if (generation !== this.generation || !this.desiredConnection) return;
        this.ws?.close(4000, "Switching Havyn room connection");
        const ws = new WebSocket(websocketEndpoint(coordinatorEndpoint(), this.desiredConnection.roomId, ticket));
        this.ws = ws;
        this.localEmit("room-transport-state", { state: "connecting", provider: "cloudflare" });
        ws.addEventListener("open", () => {
          if (ws !== this.ws) return;
          this.reconnectAttempt = 0;
          this.localEmit("connect");
          if (this.hasConnected) this.localEmit("reconnect");
          this.hasConnected = true;
          this.localEmit("room-transport-state", { state: "connected", provider: "cloudflare" });
          this.flushPendingCommands();
        });
        ws.addEventListener("message", (message) => this.handleMessage(ws, message.data));
        ws.addEventListener("close", (closeEvent) => this.handleClose(ws, closeEvent));
        ws.addEventListener("error", () => {
          if (ws === this.ws) this.localEmit("room-transport-state", { state: "error", provider: "cloudflare" });
        });
      })
      .catch((error) => {
        this.localEmit("permission-denied", { reason: error.message || "Could not connect to the Havyn room coordinator." });
        this.localEmit("room-transport-state", { state: "error", provider: "cloudflare" });
        this.scheduleReconnect();
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  async requestTicket(connection) {
    const { data } = await supabase?.auth.getSession() || { data: null };
    const accessToken = data?.session?.access_token;
    const allowDevAuth = import.meta.env?.DEV && import.meta.env?.VITE_CLOUDFLARE_DEV_AUTH === "true";
    if (!accessToken && !allowDevAuth) throw new Error("Your Havyn session has expired. Please sign in again.");
    const response = await fetch(`${coordinatorEndpoint()}/v2/rooms/${encodeURIComponent(connection.roomId)}/ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
      },
      body: JSON.stringify({
        creating: Boolean(connection.creating),
        resuming: Boolean(connection.resuming),
        roomName: connection.roomName,
        visibility: connection.visibility,
        room: connection.room,
        displayName: connection.user.displayName,
        ...(allowDevAuth ? { devUser: { id: connection.user.userId, displayName: connection.user.displayName } } : {})
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ticket) throw new Error(result.error || "Could not enter this room.");
    return result;
  }

  sendCommand(event, payload = {}) {
    if (!this.desiredConnection?.roomId) return;
    const envelope = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: "command",
      roomId: this.desiredConnection.roomId,
      sentAt: Date.now(),
      event,
      payload
    };
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.queueCommand(envelope, 0);
      return envelope.id;
    }
    this.sendEnvelope(envelope, 0);
    return envelope.id;
  }

  sendEnvelope(envelope, attempts) {
    this.ws.send(JSON.stringify(envelope));
    this.pendingAcks.set(envelope.id, {
      envelope,
      attempts,
      lastSentAt: Date.now()
    });
    this.trimPendingAcks();
  }

  queueCommand(envelope, attempts = 0) {
    if (DO_NOT_QUEUE.has(envelope.event)) return;
    const group = queuedCommandGroup(envelope.event);
    if (group) {
      this.pendingCommands = this.pendingCommands.filter((item) => queuedCommandGroup(item.envelope.event) !== group);
    }
    this.pendingCommands.push({ envelope, attempts });
    this.pendingCommands = this.pendingCommands.slice(-40);
  }

  flushPendingCommands() {
    const pending = this.pendingCommands;
    this.pendingCommands = [];
    pending.forEach(({ envelope, attempts }) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return this.pendingCommands.push({ envelope, attempts });
      this.sendEnvelope(envelope, attempts);
    });
  }

  handleMessage(ws, rawMessage) {
    if (ws !== this.ws || rawMessage === "havyn-pong") return;
    let envelope;
    try {
      envelope = JSON.parse(rawMessage);
    } catch {
      return;
    }
    if (envelope.v !== PROTOCOL_VERSION) {
      this.localEmit("permission-denied", { reason: "This Havyn build uses an incompatible room protocol." });
      return;
    }
    if (envelope.type === "ack") {
      const command = this.pendingAcks.get(envelope.replyTo);
      this.pendingAcks.delete(envelope.replyTo);
      this.localEmit("room-command-ack", {
        commandId: envelope.replyTo,
        event: command?.envelope?.event || envelope.payload?.event,
        roundTripMs: command ? Date.now() - command.lastSentAt : null,
        duplicate: Boolean(envelope.payload?.duplicate)
      });
      return;
    }
    if (envelope.type === "snapshot") {
      this.room = envelope.payload;
      this.localEmit("room-state", envelope.payload);
      return;
    }
    if (envelope.type === "error") {
      this.localEmit(envelope.event || "permission-denied", envelope.payload);
      return;
    }
    if (envelope.type === "event" && envelope.event) {
      if (envelope.event === "room-state") this.room = envelope.payload;
      this.localEmit(envelope.event, envelope.payload);
    }
  }

  handleClose(ws, closeEvent) {
    if (ws !== this.ws) return;
    if (!this.intentionalClose) {
      const now = Date.now();
      this.pendingAcks.forEach(({ envelope, attempts }) => {
        if (attempts >= MAX_RETRY_ATTEMPTS) return;
        if (now - envelope.sentAt > MAX_RETRY_AGE_MS) return;
        this.queueCommand(envelope, attempts + 1);
      });
    }
    this.pendingAcks.clear();
    this.ws = null;
    this.localEmit("room-transport-state", {
      state: this.intentionalClose ? "disconnected" : "reconnecting",
      provider: "cloudflare",
      code: closeEvent.code
    });
    if (!this.intentionalClose && this.desiredConnection) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.intentionalClose || !this.desiredConnection || this.reconnectTimer) return;
    const delay = Math.min(10_000, 500 * (2 ** Math.min(this.reconnectAttempt, 5))) + Math.floor(Math.random() * 250);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openConnection();
    }, delay);
  }

  clearReconnect() {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  heartbeat() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("havyn-ping");
  }

  leaveRoom(payload = {}) {
    const activeSocket = this.ws;
    if (activeSocket?.readyState === WebSocket.OPEN) this.sendCommand("room-leave", payload);
    this.intentionalClose = true;
    this.desiredConnection = null;
    this.room = null;
    this.pendingCommands = [];
    this.pendingAcks.clear();
    this.clearReconnect();
    this.generation += 1;
    this.hasConnected = false;
    window.setTimeout(() => {
      if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(activeSocket?.readyState)) {
        activeSocket.close(1000, "Left Havyn room");
      }
      if (this.ws === activeSocket) this.ws = null;
    }, 80);
  }

  trimPendingAcks() {
    const cutoff = Date.now() - 30_000;
    this.pendingAcks.forEach((command, commandId) => {
      if (command.lastSentAt < cutoff) this.pendingAcks.delete(commandId);
    });
    if (this.pendingAcks.size > 200) {
      this.pendingAcks = new Map(Array.from(this.pendingAcks.entries()).slice(-120));
    }
  }
}
