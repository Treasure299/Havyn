import { supabase } from "./supabase.js";
import { ROOM_ENDPOINT, syncDebug } from "./roomConfig.js";

const PROTOCOL_VERSION = 2;

function socketUrl(roomId, ticket) {
  const url = new URL(`${ROOM_ENDPOINT}/v2/rooms/${encodeURIComponent(roomId)}/connect`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export class RoomSocket {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.connection = null;
    this.intentional = false;
    this.retry = null;
    this.connectionGeneration = 0;
  }

  on(event, handler) {
    const set = this.handlers.get(event) || new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  emit(event, payload) {
    this.handlers.get(event)?.forEach((handler) => handler(payload));
  }

  async connect(connection) {
    const generation = ++this.connectionGeneration;
    const nextRoomId = String(connection.roomId).toUpperCase();
    this.connection = { ...connection, roomId: String(connection.roomId).toUpperCase() };
    this.intentional = false;
    clearTimeout(this.retry);
    const isGuest = Boolean(this.connection.user?.guest);
    const { data } = isGuest ? { data: { session: null } } : await supabase.auth.getSession();
    let token = data.session?.access_token;
    if (!token && !isGuest) throw new Error("Sign in to enter a Havyn room.");
    const ticketRequest = () => fetch(`${ROOM_ENDPOINT}/v2/rooms/${encodeURIComponent(this.connection.roomId)}/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        creating: Boolean(this.connection.creating),
        roomName: this.connection.roomName,
        visibility: this.connection.visibility || "private",
        room: this.connection.room,
        displayName: this.connection.user.displayName,
        ...(isGuest ? { guest: { userId: this.connection.user.userId, displayName: this.connection.user.displayName } } : {})
      })
    });
    let response = await ticketRequest();
    if (!isGuest && response.status === 401) {
      const refreshed = await supabase.auth.refreshSession();
      token = refreshed.data.session?.access_token || "";
      if (token) response = await ticketRequest();
    }
    const ticketResponse = await response.json().catch(() => ({}));
    if (generation !== this.connectionGeneration) return;
    if (!response.ok || !ticketResponse.ticket) throw new Error(ticketResponse.error || "Could not enter this room.");
    this.ws?.close(4000, "Switching Havyn rooms");
    const ws = new WebSocket(socketUrl(this.connection.roomId, ticketResponse.ticket));
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws || generation !== this.connectionGeneration) return;
      syncDebug("socket-open", { endpoint: ROOM_ENDPOINT, roomId: this.connection.roomId });
      this.emit("connection", "connected");
    });
    ws.addEventListener("message", (message) => {
      if (this.ws === ws && generation === this.connectionGeneration) this.handleMessage(message.data);
    });
    ws.addEventListener("error", () => {
      if (this.ws === ws && generation === this.connectionGeneration) this.emit("connection", "error");
    });
    ws.addEventListener("close", () => {
      if (this.intentional || this.ws !== ws || generation !== this.connectionGeneration) return;
      this.emit("connection", "reconnecting");
      this.retry = setTimeout(() => {
        if (this.ws === ws && generation === this.connectionGeneration) this.connect({ ...this.connection, creating: false }).catch(() => {});
      }, 2500);
    });
  }

  handleMessage(raw) {
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return; }
    if (envelope.v !== PROTOCOL_VERSION) return this.emit("error", "This web build uses an incompatible room protocol.");
    if (envelope.type === "snapshot") {
      syncDebug("socket-snapshot", { roomId: envelope.roomId, sequence: envelope.payload?.playbackState?.sequence });
      return this.emit("room-state", envelope.payload);
    }
    if (envelope.type === "event") {
      if (String(envelope.event || "").startsWith("playback")) syncDebug("socket-event", { event: envelope.event, payload: envelope.payload });
      if (envelope.event === "room-state") this.emit("room-state", envelope.payload);
      if (envelope.event === "permission-denied") this.emit("permission-denied", envelope.payload);
      this.emit(envelope.event, envelope.payload);
    }
    if (envelope.type === "ack") syncDebug("socket-ack", { replyTo: envelope.replyTo, payload: envelope.payload });
    if (envelope.type === "error") {
      syncDebug("socket-error", { replyTo: envelope.replyTo, payload: envelope.payload });
      this.emit("error", envelope.payload?.reason || "Room action failed.");
    }
  }

  command(event, payload = {}) {
    if (!this.connection) return false;
    if (event.startsWith("playback") || event === "participant-sync-report") syncDebug("socket-command", { event, payload });
    const message = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: "command",
      roomId: this.connection.roomId,
      sentAt: Date.now(),
      event,
      payload
    });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
      return true;
    }
    return false;
  }

  close() {
    this.intentional = true;
    clearTimeout(this.retry);
    this.ws?.close(1000, "Leaving Havyn room");
    this.ws = null;
  }
}
