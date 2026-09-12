import { PROTOCOL_VERSION, type ClientEnvelope, type Participant, type RoomState, type RoomTicketClaims, type ServerEnvelope } from "./protocol";
import { RoomEngine, type EngineEvent, type EngineResult } from "./roomEngine";
import { signTicket, verifyTicket } from "./ticket";

interface Env {
  HAVYN_ROOMS: DurableObjectNamespace;
  ENVIRONMENT: string;
  ROOM_TICKET_SECRET?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  CLIENT_ORIGIN?: string;
  TURN_URLS?: string;
  TURN_SHARED_SECRET?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  TURN_STUN_URL?: string;
  TURN_TTL_SECONDS?: string;
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ANALYTICS_API_TOKEN?: string;
}

interface ConnectionAttachment extends Participant {
  roomId: string;
  left?: boolean;
}

interface StoredRoom {
  state: RoomState;
  preLiveSharePlayback?: RoomState["playbackState"] | null;
  recentCommandIds: string[];
  pendingDisconnects: Record<string, { participant: ConnectionAttachment; expiresAt: number }>;
}

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

type ManagedTurnConfig = {
  mode: "cloudflare";
  accountId: string;
  keyId: string;
  turnApiToken: string;
  analyticsApiToken?: string;
  updatedAt: string;
  updatedBy: string;
} | {
  mode: "static";
  providerName: string;
  stunUrls: string[];
  turnUrls: string[];
  username: string;
  credential: string;
  updatedAt: string;
  updatedBy: string;
};

const MAX_RECENT_COMMANDS = 160;
const RECONNECT_GRACE_MS = 12_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return corsResponse(null, env, 204);
    if (url.pathname === "/health") {
      return corsResponse(JSON.stringify({ ok: true, service: "havyn-room-coordinator", protocol: PROTOCOL_VERSION, environment: env.ENVIRONMENT }), env);
    }
    if (url.pathname === "/v2/turn-usage" && request.method === "GET") {
      return issueTurnUsage(request, env);
    }
    if (url.pathname === "/v2/admin/turn-config" && ["GET", "PUT", "DELETE"].includes(request.method)) {
      return manageTurnConfig(request, env);
    }

    const ticketMatch = url.pathname.match(/^\/v2\/rooms\/([A-Z0-9-]{4,64})\/ticket$/i);
    if (ticketMatch && request.method === "POST") {
      return issueRoomTicket(request, env, ticketMatch[1].toUpperCase());
    }

    const iceMatch = url.pathname.match(/^\/v2\/rooms\/([A-Z0-9-]{4,64})\/ice$/i);
    if (iceMatch && request.method === "GET") return issueIceConfig(request, env, iceMatch[1].toUpperCase());

    const connectMatch = url.pathname.match(/^\/v2\/rooms\/([A-Z0-9-]{4,64})\/connect$/i);
    if (connectMatch && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const roomId = connectMatch[1].toUpperCase();
      const secret = ticketSecret(env);
      if (!secret) return new Response("Room coordinator is not configured", { status: 503 });
      const ticket = url.searchParams.get("ticket") || "";
      const claims = await verifyTicket(ticket, secret);
      if (!claims || claims.roomId !== roomId) return new Response("Invalid or expired room ticket", { status: 401 });
      const headers = new Headers(request.headers);
      headers.set("X-Havyn-Identity", encodeURIComponent(JSON.stringify(claims)));
      return env.HAVYN_ROOMS.getByName(roomId).fetch(new Request(request, { headers }));
    }

    return corsResponse(JSON.stringify({ error: "Not found" }), env, 404);
  }
};

export class HavynRoom {
  private ctx: DurableObjectState;
  private stored: StoredRoom | null = null;
  private loading: Promise<StoredRoom | null> | null = null;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("havyn-ping", "havyn-pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/turn-config") {
      if (request.method === "GET") {
        const config = await this.ctx.storage.get<ManagedTurnConfig>("managed-turn-config");
        return Response.json(config || null);
      }
      if (request.method === "PUT") {
        const config = await request.json<ManagedTurnConfig>();
        await this.ctx.storage.put("managed-turn-config", config);
        return Response.json({ ok: true });
      }
      if (request.method === "DELETE") {
        await this.ctx.storage.delete("managed-turn-config");
        return Response.json({ ok: true });
      }
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const claims = decodeIdentity(request.headers.get("X-Havyn-Identity"));
    if (!claims) return new Response("Missing room identity", { status: 401 });

    let stored = await this.loadStored();
    if (!stored) {
      const hostUserId = claims.creating ? claims.userId : String(claims.room?.hostUserId || "");
      if (!hostUserId) return new Response("Room does not exist", { status: 404 });
      const engine = RoomEngine.create(claims.roomId, hostUserId, claims.room || {});
      stored = { state: engine.state, preLiveSharePlayback: null, recentCommandIds: [], pendingDisconnects: {} };
      await this.persist(stored);
    }
    if (claims.guest && stored.state.blockedGuestIds?.includes(claims.userId)) {
      return new Response("This guest no longer has access to the room", { status: 403 });
    }

    for (const existing of this.ctx.getWebSockets()) {
      const attachment = existing.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.userId === claims.userId) {
        existing.serializeAttachment({ ...attachment, left: true });
        existing.close(4009, "Replaced by a newer Havyn session");
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const now = new Date().toISOString();
    const engine = this.engine(stored);
    const previous = engine.participants.get(claims.userId);
    if (stored.pendingDisconnects[claims.userId]) {
      delete stored.pendingDisconnects[claims.userId];
      await this.persist(stored);
    }
    const attachment: ConnectionAttachment = {
      sessionId: crypto.randomUUID(),
      roomId: claims.roomId,
      userId: claims.userId,
      displayName: claims.displayName || previous?.displayName || "Havyn user",
      role: stored.state.hostUserId === claims.userId ? "host" : previous?.role || "viewer",
      guest: claims.guest === true,
      online: true,
      mediaReady: previous?.mediaReady || false,
      callStatus: previous?.callStatus || "idle",
      muted: previous?.muted ?? true,
      cameraOff: previous?.cameraOff ?? true,
      joinedAt: previous?.joinedAt || now,
      lastSeenAt: now,
      capabilities: claims.capabilities || []
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    const result = engine.join(attachment);
    result.events = result.events.map((event) => (
      event.event === "room-state"
        ? { ...event, excludeSessionId: attachment.sessionId }
        : event
    ));
    await this.dispatch(engine, result);
    this.send(server, "snapshot", undefined, engine.snapshot());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return this.sendError(socket, "Only JSON messages are supported");
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment) return this.sendError(socket, "Missing connection identity");
    let envelope: ClientEnvelope;
    try {
      envelope = JSON.parse(message) as ClientEnvelope;
    } catch {
      return this.sendError(socket, "Invalid JSON message");
    }
    if (envelope.v !== PROTOCOL_VERSION || envelope.roomId !== attachment.roomId || !envelope.id) {
      return this.sendError(socket, "Invalid room protocol envelope", envelope.id);
    }
    if (envelope.type === "ping") return this.send(socket, "pong", undefined, { receivedAt: Date.now() }, envelope.id);
    if (envelope.type === "ack") return;
    if (envelope.type !== "command" || !envelope.event) return this.sendError(socket, "Missing room command", envelope.id);

    const stored = await this.loadStored();
    if (!stored) return this.sendError(socket, "Room state is unavailable", envelope.id);
    if (stored.recentCommandIds.includes(envelope.id)) {
      return this.send(socket, "ack", undefined, { duplicate: true }, envelope.id);
    }
    stored.recentCommandIds.push(envelope.id);
    stored.recentCommandIds = stored.recentCommandIds.slice(-MAX_RECENT_COMMANDS);

    const engine = this.engine(stored);
    const participant = engine.participants.get(attachment.userId);
    if (participant) {
      const refreshed = { ...participant, lastSeenAt: new Date().toISOString() };
      engine.participants.set(attachment.userId, refreshed);
      socket.serializeAttachment({ ...attachment, ...refreshed });
    }
    const result = engine.handle(envelope.event, envelope.payload || {}, attachment.userId, envelope.id);
    await this.dispatch(engine, result);
    this.send(socket, "ack", undefined, { accepted: true, event: envelope.event }, envelope.id);
    if (envelope.event === "room-leave") {
      socket.serializeAttachment({ ...attachment, left: true });
      socket.close(1000, "Left Havyn room");
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment || attachment.left) return;
    const replacementExists = this.ctx.getWebSockets().some((candidate) => {
      if (candidate === socket) return false;
      const candidateAttachment = candidate.deserializeAttachment() as ConnectionAttachment | null;
      return candidateAttachment?.userId === attachment.userId;
    });
    if (replacementExists) return;
    const stored = await this.loadStored();
    if (!stored) return;
    stored.pendingDisconnects[attachment.userId] = {
      participant: { ...attachment, lastSeenAt: new Date().toISOString() },
      expiresAt: Date.now() + RECONNECT_GRACE_MS
    };
    await this.persist(stored);
    await this.scheduleDisconnectAlarm(stored);
    console.log(JSON.stringify({ level: "info", event: "room.reconnect-grace", roomId: attachment.roomId, userId: attachment.userId, code, reason }));
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    console.error(JSON.stringify({ level: "error", event: "room.websocket-error", roomId: attachment?.roomId, userId: attachment?.userId, error: String(error) }));
  }

  async alarm(): Promise<void> {
    const stored = await this.loadStored();
    if (!stored) return;
    const now = Date.now();
    const activeUserIds = new Set(this.ctx.getWebSockets().map((socket) => {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      return attachment?.userId;
    }).filter((userId): userId is string => Boolean(userId)));
    const engine = this.engine(stored);
    const departures: EngineResult[] = [];

    for (const [userId, pending] of Object.entries(stored.pendingDisconnects)) {
      if (activeUserIds.has(userId)) {
        delete stored.pendingDisconnects[userId];
        continue;
      }
      if (pending.expiresAt > now) continue;
      delete stored.pendingDisconnects[userId];
      departures.push(engine.leave(userId));
    }

    await this.persist(stored);
    for (const departure of departures) await this.dispatch(engine, departure);
    await this.scheduleDisconnectAlarm(stored);
  }

  private async loadStored(): Promise<StoredRoom | null> {
    if (this.stored) return this.stored;
    if (!this.loading) {
      this.loading = this.ctx.storage.get<StoredRoom>("room").then((stored) => {
        this.stored = stored ? {
          ...stored,
          recentCommandIds: stored.recentCommandIds || [],
          pendingDisconnects: stored.pendingDisconnects || {},
          preLiveSharePlayback: stored.preLiveSharePlayback || null
        } : null;
        this.loading = null;
        return this.stored;
      });
    }
    return this.loading;
  }

  private engine(stored: StoredRoom, excludedSocket?: WebSocket): RoomEngine {
    const pendingParticipants = Object.values(stored.pendingDisconnects).map((pending) => pending.participant);
    const activeParticipants = this.ctx.getWebSockets()
      .filter((socket) => socket !== excludedSocket)
      .map((socket) => socket.deserializeAttachment() as ConnectionAttachment | null)
      .filter((participant): participant is ConnectionAttachment => Boolean(participant?.userId));
    return new RoomEngine(stored.state, [...pendingParticipants, ...activeParticipants], stored.preLiveSharePlayback || null);
  }

  private async scheduleDisconnectAlarm(stored: StoredRoom): Promise<void> {
    const nextExpiry = Math.min(...Object.values(stored.pendingDisconnects).map((pending) => pending.expiresAt));
    if (Number.isFinite(nextExpiry)) await this.ctx.storage.setAlarm(nextExpiry);
  }

  private async persist(stored: StoredRoom): Promise<void> {
    await this.ctx.storage.put("room", stored);
    this.stored = stored;
  }

  private async dispatch(engine: RoomEngine, result: EngineResult): Promise<void> {
    const stored = await this.loadStored();
    if (!stored) return;
    if (result.stateChanged) {
      stored.state = engine.state;
      stored.preLiveSharePlayback = engine.preLiveSharePlayback;
      await this.persist(stored);
    } else {
      this.stored = { ...stored, state: engine.state };
    }
    if (result.participantChanged) this.syncParticipantAttachments(engine);
    for (const event of result.events) this.broadcast(event);
  }

  private syncParticipantAttachments(engine: RoomEngine): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (!attachment) continue;
      const participant = engine.participants.get(attachment.userId);
      if (participant) socket.serializeAttachment({ ...attachment, ...participant });
    }
  }

  private broadcast(event: EngineEvent): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (!attachment) continue;
      if (event.targetUserId && attachment.userId !== event.targetUserId) continue;
      if (event.excludeSessionId && attachment.sessionId === event.excludeSessionId) continue;
      this.send(socket, "event", event.event, event.payload);
    }
  }

  private send(socket: WebSocket, type: ServerEnvelope["type"], event?: string, payload?: unknown, replyTo?: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const envelope: ServerEnvelope = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type,
      roomId: this.stored?.state.roomId || "",
      sentAt: Date.now(),
      sequence: this.stored?.state.revision || 0,
      event,
      payload,
      replyTo
    };
    socket.send(JSON.stringify(envelope));
  }

  private sendError(socket: WebSocket, reason: string, replyTo?: string): void {
    this.send(socket, "error", "permission-denied", { reason }, replyTo);
  }
}

async function issueRoomTicket(request: Request, env: Env, roomId: string): Promise<Response> {
  const secret = ticketSecret(env);
  if (!secret) return corsResponse(JSON.stringify({ error: "Room coordinator is not configured" }), env, 503);
  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  const requestedGuest = body.guest && typeof body.guest === "object" ? body.guest as Record<string, unknown> : null;
  const guestId = String(requestedGuest?.userId || "");
  const guestName = String(requestedGuest?.displayName || "").trim().slice(0, 80);
  const guest = guestId.startsWith("guest_") && /^[a-zA-Z0-9_-]{12,96}$/.test(guestId) && guestName
    ? { id: guestId, displayName: guestName, guest: true }
    : null;
  const user = guest || await authenticateUser(request, env, body);
  if (!user) return corsResponse(JSON.stringify({ error: "Authentication required" }), env, 401);
  const requestedRoom = (body.room || {}) as Partial<RoomState>;
  const capabilities = Array.isArray(body.capabilities)
    ? body.capabilities.map(String).filter((capability) => capability === "live-share-v1")
    : [];
  const creating = Boolean(body.creating);
  const claims: RoomTicketClaims = {
    roomId,
    userId: user.id,
    displayName: String(body.displayName || user.displayName || "Havyn user").slice(0, 80),
    creating,
    resuming: Boolean(body.resuming),
    room: {
      roomId,
      roomName: String(requestedRoom.roomName || body.roomName || "Movie Night").slice(0, 120),
      hostUserId: creating ? user.id : String(requestedRoom.hostUserId || ""),
      visibility: requestedRoom.visibility === "public" || body.visibility === "public" ? "public" : "private",
      playbackMode: requestedRoom.playbackMode,
      playbackState: requestedRoom.playbackState,
      selectedContent: requestedRoom.selectedContent,
      createdAt: requestedRoom.createdAt
    },
    exp: Date.now() + 60_000,
    jti: crypto.randomUUID(),
    capabilities,
    guest: Boolean(guest)
  };
  return corsResponse(JSON.stringify({ ticket: await signTicket(claims, secret), expiresAt: claims.exp, protocol: PROTOCOL_VERSION }), env);
}

function configStub(env: Env): DurableObjectStub {
  return env.HAVYN_ROOMS.getByName("HAVYN-SYSTEM-CONFIG");
}

async function readManagedTurnConfig(env: Env): Promise<ManagedTurnConfig | null> {
  const response = await configStub(env).fetch("https://havyn.internal/internal/turn-config");
  return response.ok ? await response.json() as ManagedTurnConfig | null : null;
}

function environmentStunUrls(env: Env): string[] {
  return env.TURN_STUN_URL
    ? String(env.TURN_STUN_URL).split(",").map((value) => value.trim()).filter(Boolean)
    : ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53", "stun:stun.l.google.com:19302"];
}

async function generateCloudflareIceServers(keyId: string, token: string, ttl: number, customIdentifier: string): Promise<IceServerConfig[]> {
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl, customIdentifier })
  });
  const payload = await response.json().catch(() => ({})) as { iceServers?: IceServerConfig[]; error?: string };
  if (!response.ok || !Array.isArray(payload.iceServers)) throw new Error(payload.error || `TURN credential request failed (${response.status})`);
  return payload.iceServers.map((server) => ({
    ...server,
    urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => !String(url).includes(":53"))
  })).filter((server) => server.urls.length);
}

function splitIceUrls(value: unknown, protocols: string[]): string[] {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,]+/);
  return values.map(String).map((url) => url.trim()).filter((url) => protocols.some((protocol) => url.startsWith(`${protocol}:`)));
}

async function manageTurnConfig(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  if (request.method === "PUT") {
    try { body = await request.json() as Record<string, unknown>; } catch { return corsResponse(JSON.stringify({ error: "Invalid configuration" }), env, 400); }
  }
  const authenticated = env.ENVIRONMENT === "local" ? { id: "local-admin" } : await authenticateUser(request, env, body);
  if (!authenticated) return corsResponse(JSON.stringify({ error: "Signed-in admin access required" }), env, 401);

  if (request.method === "GET") {
    const current = await readManagedTurnConfig(env);
    return corsResponse(JSON.stringify({
      admin: true,
      source: current ? "admin" : "environment",
      mode: current?.mode || (env.CLOUDFLARE_TURN_KEY_ID ? "cloudflare" : "static"),
      providerName: current?.mode === "static" ? current.providerName : "Cloudflare",
      accountId: current?.mode === "cloudflare" ? current.accountId : env.CLOUDFLARE_ACCOUNT_ID || "",
      keyId: current?.mode === "cloudflare" ? current.keyId : env.CLOUDFLARE_TURN_KEY_ID || "",
      updatedAt: current?.updatedAt || null,
      updatedBy: current?.updatedBy || null
    }), env, 200);
  }

  if (request.method === "DELETE") {
    await configStub(env).fetch("https://havyn.internal/internal/turn-config", { method: "DELETE" });
    return corsResponse(JSON.stringify({ ok: true, source: "environment" }), env, 200);
  }

  const mode = body.mode === "static" ? "static" : "cloudflare";
  const updatedAt = new Date().toISOString();
  let config: ManagedTurnConfig;
  if (mode === "cloudflare") {
    const accountId = String(body.accountId || "").trim();
    const keyId = String(body.keyId || "").trim();
    const turnApiToken = String(body.turnApiToken || "").trim();
    const analyticsApiToken = String(body.analyticsApiToken || "").trim();
    if (!accountId || !keyId || !turnApiToken) return corsResponse(JSON.stringify({ error: "Account ID, TURN key ID, and TURN API token are required" }), env, 400);
    try {
      await generateCloudflareIceServers(keyId, turnApiToken, 600, `HAVYN-ADMIN-TEST:${authenticated.id}`);
    } catch (error) {
      return corsResponse(JSON.stringify({ error: error instanceof Error ? error.message : "Cloudflare TURN validation failed" }), env, 400);
    }
    config = { mode, accountId, keyId, turnApiToken, ...(analyticsApiToken ? { analyticsApiToken } : {}), updatedAt, updatedBy: authenticated.id };
  } else {
    const providerName = String(body.providerName || "Custom TURN").trim().slice(0, 80) || "Custom TURN";
    const stunUrls = splitIceUrls(body.stunUrls, ["stun", "stuns"]);
    const turnUrls = splitIceUrls(body.turnUrls, ["turn", "turns"]);
    const username = String(body.username || "").trim();
    const credential = String(body.credential || "");
    if (!turnUrls.length || !username || !credential) return corsResponse(JSON.stringify({ error: "TURN URLs, username, and password are required" }), env, 400);
    config = { mode, providerName, stunUrls, turnUrls, username, credential, updatedAt, updatedBy: authenticated.id };
  }
  const stored = await configStub(env).fetch("https://havyn.internal/internal/turn-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config)
  });
  if (!stored.ok) return corsResponse(JSON.stringify({ error: "Relay configuration could not be stored" }), env, 500);
  return corsResponse(JSON.stringify({ ok: true, mode: config.mode, providerName: config.mode === "cloudflare" ? "Cloudflare" : config.providerName, updatedAt }), env, 200);
}

async function issueIceConfig(request: Request, env: Env, roomId: string): Promise<Response> {
  const secret = ticketSecret(env);
  const ticket = new URL(request.url).searchParams.get("ticket") || "";
  const claims = secret && ticket ? await verifyTicket(ticket, secret) : null;
  if (claims?.roomId !== roomId) return corsResponse(JSON.stringify({ error: "Room authorization required" }), env, 401);
  const authenticated = { id: claims.userId };
  const managed = await readManagedTurnConfig(env);
  const stun = { urls: managed?.mode === "static" ? managed.stunUrls : environmentStunUrls(env) };
  const ttl = Math.max(300, Math.min(86_400, Number(env.TURN_TTL_SECONDS || 21_600)));
  const cloudflareKeyId = managed ? managed.mode === "cloudflare" ? managed.keyId : undefined : env.CLOUDFLARE_TURN_KEY_ID;
  const cloudflareTurnToken = managed ? managed.mode === "cloudflare" ? managed.turnApiToken : undefined : env.CLOUDFLARE_TURN_API_TOKEN;
  if (cloudflareKeyId && cloudflareTurnToken) {
    try {
      const iceServers = await generateCloudflareIceServers(cloudflareKeyId, cloudflareTurnToken, ttl, `${roomId}:${authenticated.id}`);
      return corsResponse(JSON.stringify({ iceServers, relayConfigured: true, relayProvider: "cloudflare" }), env, 200);
    } catch (error) {
      console.error("Cloudflare TURN credential generation failed", error instanceof Error ? error.message : String(error));
    }
  }
  if (managed?.mode === "static") {
    return corsResponse(JSON.stringify({
      iceServers: [...(managed.stunUrls.length ? [stun] : []), { urls: managed.turnUrls, username: managed.username, credential: managed.credential }],
      relayConfigured: true,
      relayProvider: `managed:${managed.providerName}`
    }), env, 200);
  }
  const urls = String(env.TURN_URLS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (urls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    return corsResponse(JSON.stringify({
      iceServers: [stun, { urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }],
      relayConfigured: true,
      relayProvider: "express-turn"
    }), env, 200);
  }
  if (!urls.length || !env.TURN_SHARED_SECRET) return corsResponse(JSON.stringify({ iceServers: [stun], relayConfigured: false }), env, 200);
  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:${authenticated.id}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TURN_SHARED_SECRET), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return corsResponse(JSON.stringify({ iceServers: [stun, { urls, username, credential }], relayConfigured: true, relayProvider: "express-turn" }), env, 200);
}

type TurnAnalyticsManagedConfig = Pick<Extract<ManagedTurnConfig, { mode: "cloudflare" }>, "mode" | "accountId" | "analyticsApiToken"> | { mode: "static" };

export function selectTurnAnalyticsCredentials(
  managed: TurnAnalyticsManagedConfig | null,
  environment: Pick<Env, "CLOUDFLARE_ACCOUNT_ID" | "CLOUDFLARE_ANALYTICS_API_TOKEN">
) {
  if (managed?.mode === "static") return { accountId: undefined, analyticsToken: undefined };
  return {
    accountId: managed?.accountId || environment.CLOUDFLARE_ACCOUNT_ID,
    analyticsToken: managed?.analyticsApiToken || environment.CLOUDFLARE_ANALYTICS_API_TOKEN
  };
}

export const TURN_USAGE_QUERY = `query TurnUsage($accountId: String!, $dateFrom: Date!, $dateTo: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountId }) {
      callsTurnUsageAdaptiveGroups(
        limit: 1
        filter: { date_geq: $dateFrom, date_leq: $dateTo }
      ) { sum { egressBytes } }
    }
  }
}`;

async function issueTurnUsage(request: Request, env: Env): Promise<Response> {
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const nextResetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const freeTierBytes = 1_000_000_000_000;
  const ratePerGb = 0.05;
  if (env.ENVIRONMENT !== "local" && !await authenticateUser(request, env, {})) {
    return corsResponse(JSON.stringify({ error: "Authentication required" }), env, 401);
  }
  const managed = await readManagedTurnConfig(env);
  const { accountId, analyticsToken } = selectTurnAnalyticsCredentials(managed, env);
  if (!accountId || !analyticsToken) {
    return corsResponse(JSON.stringify({
      configured: false,
      errorCode: !accountId ? "account-id-missing" : "analytics-token-missing",
      month,
      nextResetAt,
      freeTierBytes,
      ratePerGb
    }), env, 200);
  }
  const dateFrom = `${month}-01`;
  const dateTo = new Date().toISOString().slice(0, 10);
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${analyticsToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: TURN_USAGE_QUERY, variables: { accountId, dateFrom, dateTo } })
    });
    const payload = await response.json() as {
      data?: { viewer?: { accounts?: Array<{ callsTurnUsageAdaptiveGroups?: Array<{ sum?: { egressBytes?: number } }> }> } };
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.[0]?.message || `Analytics request failed (${response.status})`);
    const groups = payload.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups || [];
    const egressBytes = groups.reduce((total, group) => total + Number(group.sum?.egressBytes || 0), 0);
    const overageBytes = Math.max(0, egressBytes - freeTierBytes);
    return corsResponse(JSON.stringify({
      configured: true,
      source: "cloudflare-analytics",
      month,
      nextResetAt,
      refreshedAt: new Date().toISOString(),
      egressBytes,
      freeTierBytes,
      overageBytes,
      ratePerGb,
      estimatedCostUsd: overageBytes / 1_000_000_000 * ratePerGb
    }), env, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Cloudflare TURN analytics request failed", message);
    const denied = /auth|permission|access|unauthorized|forbidden/i.test(message);
    return corsResponse(JSON.stringify({
      configured: false,
      errorCode: denied ? "analytics-token-denied" : "analytics-query-failed",
      month,
      nextResetAt,
      freeTierBytes,
      ratePerGb,
      unavailable: true
    }), env, 200);
  }
}

async function authenticateUser(request: Request, env: Env, body: Record<string, unknown>): Promise<{ id: string; displayName?: string } | null> {
  if (env.ENVIRONMENT === "local" && body.devUser && typeof body.devUser === "object") {
    const devUser = body.devUser as Record<string, unknown>;
    if (devUser.id) return { id: String(devUser.id), displayName: String(devUser.displayName || "Test user") };
  }
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ") || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: env.SUPABASE_ANON_KEY }
  });
  if (!response.ok) return null;
  const user = await response.json<Record<string, unknown>>();
  const metadata = (user.user_metadata || {}) as Record<string, unknown>;
  return { id: String(user.id || ""), displayName: String(metadata.display_name || metadata.name || "") };
}

function decodeIdentity(value: string | null): RoomTicketClaims | null {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value)) as RoomTicketClaims;
  } catch {
    return null;
  }
}

function ticketSecret(env: Env): string | null {
  if (env.ROOM_TICKET_SECRET) return env.ROOM_TICKET_SECRET;
  return env.ENVIRONMENT === "local" ? "havyn-local-room-ticket-secret-not-for-production" : null;
}

function corsResponse(body: BodyInit | null, env: Env, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": env.CLIENT_ORIGIN || "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS"
    }
  });
}
