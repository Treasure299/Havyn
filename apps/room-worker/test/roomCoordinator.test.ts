import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ServerEnvelope } from "../src/protocol";

const worker = (exports as unknown as {
  default: { fetch(request: Request): Promise<Response> };
}).default;
const testEnv = env as unknown as { HAVYN_ROOMS: DurableObjectNamespace };

interface TestClient {
  socket: WebSocket;
  messages: ServerEnvelope[];
  send(event: string, payload?: Record<string, unknown>): string;
  waitFor(predicate: (message: ServerEnvelope) => boolean, timeoutMs?: number): Promise<ServerEnvelope>;
}

const clients: TestClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => new Promise<void>((resolve) => {
    if (client.socket.readyState === WebSocket.CLOSED) return resolve();
    const timeout = setTimeout(resolve, 250);
    client.socket.addEventListener("close", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    client.socket.close(1000, "Test complete");
  })));
});

async function roomTicket(roomId: string, userId: string, creating: boolean, capabilities = ["live-share-v1"]) {
  const response = await worker.fetch(new Request(`https://havyn.test/v2/rooms/${roomId}/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      creating,
      room: { roomId, roomName: "Test room", hostUserId: "host", playbackMode: "host-only" },
      displayName: userId,
      devUser: { id: userId, displayName: userId },
      capabilities
    })
  }));
  expect(response.status).toBe(200);
  return (await response.json() as { ticket: string }).ticket;
}

async function guestRoomTicket(roomId: string, userId: string, creating: boolean) {
  const response = await worker.fetch(new Request(`https://havyn.test/v2/rooms/${roomId}/ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      creating,
      room: { roomId, roomName: "Guest room", hostUserId: userId, playbackMode: "host-only" },
      displayName: "Guest caller",
      guest: { userId, displayName: "Guest caller" }
    })
  }));
  expect(response.status).toBe(200);
  return (await response.json() as { ticket: string }).ticket;
}

describe("call relay credentials", () => {
  it("returns pricing metadata when account analytics is not configured", async () => {
    const response = await worker.fetch(new Request("https://havyn.test/v2/turn-usage"));
    const payload = await response.json() as { configured?: boolean; freeTierBytes?: number; ratePerGb?: number };
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ configured: false, freeTierBytes: 1_000_000_000_000, ratePerGb: 0.05 });
  });

  it("accepts a fresh room ticket for ICE configuration", async () => {
    const roomId = `ICE-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();
    const ticket = await guestRoomTicket(roomId, `guest_${crypto.randomUUID().replaceAll("-", "")}`, true);
    const response = await worker.fetch(new Request(
      `https://havyn.test/v2/rooms/${roomId}/ice?ticket=${encodeURIComponent(ticket)}`
    ));
    const payload = await response.json() as { iceServers?: Array<{ urls: string | string[] }>; relayConfigured?: boolean };
    expect(response.status).toBe(200);
    expect(payload.iceServers?.[0]?.urls).toEqual(expect.arrayContaining([
      "stun:stun.cloudflare.com:3478",
      "stun:stun.cloudflare.com:53",
      "stun:stun.l.google.com:19302",
    ]));
    expect(payload.relayConfigured).toBe(false);
  });

  it("rejects ICE configuration without room authorization", async () => {
    const response = await worker.fetch(new Request("https://havyn.test/v2/rooms/NO-AUTH/ice"));
    expect(response.status).toBe(401);
  });
});

async function connect(roomId: string, userId: string, creating = false, capabilities = ["live-share-v1"]): Promise<TestClient> {
  const ticket = await roomTicket(roomId, userId, creating, capabilities);
  const response = await worker.fetch(new Request(
    `https://havyn.test/v2/rooms/${roomId}/connect?ticket=${encodeURIComponent(ticket)}`,
    { headers: { Upgrade: "websocket" } }
  ));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  socket!.accept();

  const messages: ServerEnvelope[] = [];
  const waiters = new Set<{
    predicate: (message: ServerEnvelope) => boolean;
    resolve: (message: ServerEnvelope) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  socket!.addEventListener("message", (message: MessageEvent) => {
    if (typeof message.data !== "string") return;
    const envelope = JSON.parse(message.data) as ServerEnvelope;
    messages.push(envelope);
    waiters.forEach((waiter) => {
      if (!waiter.predicate(envelope)) return;
      waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(envelope);
    });
  });

  const client: TestClient = {
    socket: socket!,
    messages,
    send(event, payload = {}) {
      const id = crypto.randomUUID();
      socket!.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        id,
        type: "command",
        roomId,
        sentAt: Date.now(),
        event,
        payload
      }));
      return id;
    },
    waitFor(predicate, timeoutMs = 2_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timeout: 0 as unknown as ReturnType<typeof setTimeout> };
        waiter.timeout = setTimeout(() => {
          if (!waiters.delete(waiter)) return;
          reject(new Error(`Timed out waiting for room message. Received: ${messages.map((item) => item.event || item.type).join(", ")}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    }
  };
  clients.push(client);
  await client.waitFor((message) => message.type === "snapshot");
  return client;
}

describe("HavynRoom Durable Object", () => {
  it("gives a newcomer one snapshot while existing participants receive the join update", async () => {
    const roomId = `JOIN${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    const viewer = await connect(roomId, "viewer");
    await host.waitFor((message) => Boolean(
      message.event === "room-state" &&
      (message.payload as { participants?: Array<{ userId: string }> })?.participants?.some((item) => item.userId === "viewer")
    ));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(viewer.messages.filter((message) => message.type === "snapshot")).toHaveLength(1);
    expect(viewer.messages.filter((message) => message.event === "room-state")).toHaveLength(0);
  });

  it("coordinates play and pause across two clients with host authority", async () => {
    const roomId = `SYNC${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    const viewer = await connect(roomId, "viewer");
    const playId = host.send("playback-play", { currentTime: 18, playbackRate: 1 });

    const [hostPlay, viewerPlay] = await Promise.all([
      host.waitFor((message) => message.event === "playback-command" && (message.payload as { commandId?: string })?.commandId === playId),
      viewer.waitFor((message) => message.event === "playback-command" && (message.payload as { commandId?: string })?.commandId === playId)
    ]);
    expect(hostPlay.payload).toMatchObject({ action: "play" });
    expect(viewerPlay.payload).toMatchObject({ action: "play" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(viewer.messages.filter((message) => (
      message.event === "playback-command" && (message.payload as { commandId?: string })?.commandId === playId
    ))).toHaveLength(1);

    viewer.send("playback-pause", { currentTime: 19 });
    const rejection = await viewer.waitFor((message) => message.event === "permission-denied");
    expect(rejection.payload).toMatchObject({ reason: "Playback is controlled by the host." });

    const pauseId = host.send("playback-pause", { currentTime: 21 });
    const viewerPause = await viewer.waitFor((message) => (
      message.event === "playback-command" && (message.payload as { commandId?: string })?.commandId === pauseId
    ));
    expect(viewerPause.payload).toMatchObject({ action: "pause" });
  });

  it("acknowledges a retried command ID without broadcasting playback twice", async () => {
    const roomId = `RETRY${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    const viewer = await connect(roomId, "viewer");
    const commandId = host.send("playback-play", { currentTime: 22 });
    await viewer.waitFor((message) => (
      message.event === "playback-command" &&
      (message.payload as { commandId?: string })?.commandId === commandId
    ));
    host.socket.send(JSON.stringify({
      v: PROTOCOL_VERSION,
      id: commandId,
      type: "command",
      roomId,
      sentAt: Date.now(),
      event: "playback-play",
      payload: { currentTime: 22 }
    }));
    const duplicateAck = await host.waitFor((message) => message.type === "ack" && message.replyTo === commandId && (
      message.payload as { duplicate?: boolean }
    )?.duplicate === true);
    expect(duplicateAck.payload).toMatchObject({ duplicate: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(viewer.messages.filter((message) => (
      message.event === "playback-command" &&
      (message.payload as { commandId?: string })?.commandId === commandId
    ))).toHaveLength(1);
  });

  it("keeps room state and live sockets through Durable Object eviction", async () => {
    const roomId = `EVICT${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    const viewer = await connect(roomId, "viewer");
    const playId = host.send("playback-play", { currentTime: 30 });
    await viewer.waitFor((message) => message.event === "playback-command" && (message.payload as { commandId?: string })?.commandId === playId);

    await evictDurableObject(testEnv.HAVYN_ROOMS.getByName(roomId));

    const pauseId = host.send("playback-pause", { currentTime: 31 });
    const pause = await viewer.waitFor((message) => (
      message.event === "playback-command" && (message.payload as { commandId?: string })?.commandId === pauseId
    ));
    expect(pause.payload).toMatchObject({ action: "pause", state: { currentTime: 31, isPlaying: false } });
  });

  it("routes WebRTC signaling without broadcasting it to the sender", async () => {
    const roomId = `CALL${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    const viewer = await connect(roomId, "viewer");
    const signalId = host.send("webrtc-offer", {
      toUserId: "viewer",
      description: { type: "offer", sdp: "test-offer" }
    });

    const offer = await viewer.waitFor((message) => (
      message.event === "webrtc-offer" && (message.payload as { signalId?: string })?.signalId === signalId
    ));
    expect(offer.payload).toMatchObject({ fromUserId: "host", toUserId: "viewer" });
    expect(host.messages.some((message) => message.event === "webrtc-offer")).toBe(false);
  });

  it("coordinates Live Share acceptance, targeted signaling, and exact playback restoration", async () => {
    const roomId = `SHARE${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    const viewer = await connect(roomId, "viewer");

    const seekId = host.send("playback-seek", { currentTime: 57.25 });
    await viewer.waitFor((message) => (
      message.event === "playback-command" && (message.payload as { commandId?: string })?.commandId === seekId
    ));

    host.send("live-share-start", { shareId: "share-integration", hasAudio: true });
    const invitation = await viewer.waitFor((message) => message.event === "live-share-available");
    expect(invitation.payload).toMatchObject({ shareId: "share-integration", hasAudio: true });

    viewer.send("live-share-accept", { shareId: "share-integration" });
    await host.waitFor((message) => (
      message.event === "live-share-accept"
      && (message.payload as { viewerUserId?: string })?.viewerUserId === "viewer"
    ));

    const offerId = host.send("screen-webrtc-offer", {
      shareId: "share-integration",
      toUserId: "viewer",
      description: { type: "offer", sdp: "screen-offer" }
    });
    const offer = await viewer.waitFor((message) => (
      message.event === "screen-webrtc-offer"
      && (message.payload as { signalId?: string })?.signalId === offerId
    ));
    expect(offer.payload).toMatchObject({ fromUserId: "host", toUserId: "viewer" });
    expect(host.messages.some((message) => message.event === "screen-webrtc-offer")).toBe(false);

    const answerId = viewer.send("screen-webrtc-answer", {
      shareId: "share-integration",
      toUserId: "host",
      description: { type: "answer", sdp: "screen-answer" }
    });
    const answer = await host.waitFor((message) => (
      message.event === "screen-webrtc-answer"
      && (message.payload as { signalId?: string })?.signalId === answerId
    ));
    expect(answer.payload).toMatchObject({ fromUserId: "viewer", toUserId: "host" });

    host.send("playback-play", { currentTime: 70 });
    const blocked = await host.waitFor((message) => (
      message.event === "permission-denied"
      && (message.payload as { reason?: string })?.reason === "Playback controls are paused during Live Share."
    ));
    expect(blocked.payload).toMatchObject({ reason: "Playback controls are paused during Live Share." });

    host.send("live-share-stop", { shareId: "share-integration" });
    const ended = await viewer.waitFor((message) => message.event === "live-share-ended");
    expect(ended.payload).toMatchObject({
      shareId: "share-integration",
      playbackState: expect.objectContaining({ currentTime: 57.25, isPlaying: false })
    });
  });

  it("restores an active Live Share after Durable Object eviction and invites a late joiner", async () => {
    const roomId = `SHAREEVICT${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    const seekId = host.send("playback-seek", { currentTime: 91.5 });
    await host.waitFor((message) => (
      message.event === "playback-command" && (message.payload as { commandId?: string })?.commandId === seekId
    ));
    host.send("live-share-start", { shareId: "share-persisted", hasAudio: false });
    await host.waitFor((message) => message.event === "live-share-available");

    await evictDurableObject(testEnv.HAVYN_ROOMS.getByName(roomId));

    const late = await connect(roomId, "late-viewer");
    const snapshot = late.messages.find((message) => message.type === "snapshot");
    expect(snapshot?.payload).toMatchObject({
      roomExperience: "live-share",
      liveShare: { shareId: "share-persisted", status: "available" }
    });
    late.send("live-share-accept", { shareId: "share-persisted" });
    await host.waitFor((message) => (
      message.event === "live-share-accept"
      && (message.payload as { viewerUserId?: string })?.viewerUserId === "late-viewer"
    ));

    host.send("live-share-stop", { shareId: "share-persisted" });
    const ended = await late.waitFor((message) => message.event === "live-share-ended");
    expect(ended.payload).toMatchObject({
      playbackState: expect.objectContaining({ currentTime: 91.5, isPlaying: false })
    });
  });

  it("keeps ordinary rooms working when a connected client does not support Live Share", async () => {
    const roomId = `COMPAT${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    await connect(roomId, "older-viewer", false, []);
    host.send("live-share-start", { shareId: "unsupported" });
    const error = await host.waitFor((message) => message.event === "live-share-error");
    expect(error.payload).toMatchObject({ reason: expect.stringContaining("newer Havyn build") });

    const playId = host.send("playback-play", { currentTime: 12 });
    const play = await host.waitFor((message) => (
      message.event === "playback-command" && (message.payload as { commandId?: string })?.commandId === playId
    ));
    expect(play.payload).toMatchObject({ action: "play" });
  });

  it("preserves call presence when a participant reconnects inside the grace window", async () => {
    const roomId = `REJOIN${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    const viewer = await connect(roomId, "viewer");
    viewer.send("call-join", { muted: false, cameraOff: false });
    await host.waitFor((message) => Boolean(
      message.event === "room-state"
      && (message.payload as { participants?: Array<{ userId: string; callStatus: string }> })?.participants
        ?.some((participant) => participant.userId === "viewer" && participant.callStatus === "connected")
    ));

    const departureCount = host.messages.filter((message) => message.event === "user-left-call").length;
    viewer.socket.close(1012, "Temporary network interruption");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const rejoined = await connect(roomId, "viewer");
    const snapshot = await rejoined.waitFor((message) => message.type === "snapshot");
    expect((snapshot.payload as { participants: Array<{ userId: string; callStatus: string }> }).participants)
      .toContainEqual(expect.objectContaining({ userId: "viewer", callStatus: "connected" }));
    expect(host.messages.filter((message) => message.event === "user-left-call")).toHaveLength(departureCount);
  });

  it("broadcasts an intentional room departure without waiting for reconnect grace", async () => {
    const roomId = `LEAVE${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const host = await connect(roomId, "host", true);
    const viewer = await connect(roomId, "viewer");
    viewer.send("room-leave");

    const left = await host.waitFor((message) => message.event === "user-left-call");
    expect(left.payload).toMatchObject({ userId: "viewer" });
  });
});
