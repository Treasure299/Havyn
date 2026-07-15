import { describe, expect, it, vi } from "vitest";
import { RoomEngine } from "../src/roomEngine";
import type { Participant } from "../src/protocol";

function participant(userId: string, role: Participant["role"] = "viewer"): Participant {
  const now = new Date().toISOString();
  return {
    sessionId: `session-${userId}`,
    userId,
    displayName: userId,
    role,
    online: true,
    mediaReady: false,
    callStatus: "idle",
    muted: true,
    cameraOff: true,
    joinedAt: now,
    lastSeenAt: now,
    capabilities: ["live-share-v1"]
  };
}

function roomWithTwoUsers(mode: "host-only" | "host-and-cohosts" | "everyone" = "host-only") {
  const engine = RoomEngine.create("ROOM1234", "host", { playbackMode: mode });
  engine.join(participant("host", "host"));
  engine.join(participant("viewer"));
  return engine;
}

function event(result: ReturnType<RoomEngine["handle"]>, eventName: string) {
  return result.events.find((item) => item.event === eventName);
}

describe("RoomEngine playback authority", () => {
  it("accepts host play and emits one authoritative playback command", () => {
    const engine = roomWithTwoUsers();
    const result = engine.handle("playback-play", { currentTime: 12 }, "host", "play-1");

    expect(result.stateChanged).toBe(true);
    expect(engine.state.playbackState).toMatchObject({
      isPlaying: true,
      currentTime: 12,
      controllerUserId: "host",
      commandId: "play-1",
      sequence: 1
    });
    expect(event(result, "playback-command")?.payload).toMatchObject({ action: "play", commandId: "play-1" });
    expect(event(result, "room-action")?.payload).toMatchObject({ message: "host played" });
  });

  it("broadcasts Treasure play so Vaultr can play and both see the action", () => {
    const engine = RoomEngine.create("ROOM1234", "treasure", { playbackMode: "everyone" });
    engine.join({ ...participant("treasure", "host"), displayName: "Treasure" });
    engine.join({ ...participant("vaultr"), displayName: "Vaultr" });

    const result = engine.handle("playback-play", { currentTime: 31.5 }, "treasure", "treasure-play-1");

    expect(event(result, "playback-command")?.targetUserId).toBeUndefined();
    expect(event(result, "playback-command")?.payload).toMatchObject({
      action: "play",
      state: expect.objectContaining({ isPlaying: true, currentTime: 31.5, controllerUserId: "treasure" })
    });
    expect(event(result, "room-action")?.payload).toMatchObject({ message: "Treasure played" });
  });

  it("rejects a viewer in host-only mode and sends a targeted correction", () => {
    const engine = roomWithTwoUsers();
    const result = engine.handle("playback-pause", { currentTime: 20 }, "viewer", "pause-1");

    expect(result.stateChanged).toBeUndefined();
    expect(engine.state.playbackState.sequence).toBe(0);
    expect(event(result, "permission-denied")?.targetUserId).toBe("viewer");
    expect(event(result, "playback-state-sync")?.targetUserId).toBe("viewer");
  });

  it("allows cohosts only in host-and-cohosts mode", () => {
    const engine = roomWithTwoUsers("host-and-cohosts");
    engine.participants.set("viewer", participant("viewer", "cohost"));

    const result = engine.handle("playback-seek", { currentTime: 87 }, "viewer", "seek-1");
    expect(result.stateChanged).toBe(true);
    expect(engine.state.playbackState).toMatchObject({ currentTime: 87, controllerUserId: "viewer" });
  });

  it("allows every participant in everyone mode", () => {
    const engine = roomWithTwoUsers("everyone");
    const result = engine.handle("playback-play", { currentTime: 7 }, "viewer", "play-viewer");
    expect(result.stateChanged).toBe(true);
    expect(engine.state.playbackState.controllerUserId).toBe("viewer");
  });

  it("lets only the host change playback mode, including from everyone mode", () => {
    const engine = roomWithTwoUsers("everyone");
    const denied = engine.handle("room-playback-mode", { playbackMode: "host-only" }, "viewer", "mode-viewer");
    expect(engine.state.playbackMode).toBe("everyone");
    expect(event(denied, "permission-denied")?.payload).toMatchObject({
      reason: "Only the host can change playback mode."
    });

    for (const playbackMode of ["host-only", "host-and-cohosts", "everyone"] as const) {
      const accepted = engine.handle("room-playback-mode", { playbackMode }, "host", `mode-${playbackMode}`);
      expect(event(accepted, "permission-denied")).toBeUndefined();
      expect(engine.state.playbackMode).toBe(playbackMode);
    }
  });

  it("increments playback sequence without multiplying events", () => {
    const engine = roomWithTwoUsers();
    const play = engine.handle("playback-play", { currentTime: 3 }, "host", "play-1");
    const pause = engine.handle("playback-pause", { currentTime: 4 }, "host", "pause-1");

    expect(engine.state.playbackState.sequence).toBe(2);
    expect(play.events.filter((item) => ["playback-command", "playback-play", "playback-state-sync"].includes(item.event))).toHaveLength(1);
    expect(pause.events.filter((item) => ["playback-command", "playback-pause", "playback-state-sync"].includes(item.event))).toHaveLength(1);
  });
});

describe("RoomEngine media and late joins", () => {
  it("stores the selected source and exposes it in a late-join snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T20:00:00Z"));
    const engine = roomWithTwoUsers();
    engine.handle("media-selected", {
      media: {
        url: "https://media.example/movie.m3u8",
        pageUrl: "https://example.com/movie",
        frameUrl: "https://player.example/embed/1",
        title: "Movie",
        currentTime: 42,
        paused: false,
        playbackRate: 1
      }
    }, "host", "media-1");

    vi.advanceTimersByTime(2_000);
    engine.join(participant("late-viewer"));
    const snapshot = engine.snapshot();
    expect(snapshot.playbackState).toMatchObject({
      activeMediaUrl: "https://example.com/movie",
      activeMediaPageUrl: "https://example.com/movie",
      activeMediaFrameUrl: "https://player.example/embed/1",
      isPlaying: true
    });
    expect(snapshot.playbackState.currentTime).toBeCloseTo(44, 1);
    vi.useRealTimers();
  });

  it("keeps the shared page canonical and uses the child URL only as a frame locator", () => {
    const engine = roomWithTwoUsers();
    const result = engine.handle("media-selected", {
      media: {
        url: "https://player.example/embed/1",
        pageUrl: "https://example.com/movie",
        frameUrl: "https://player.example/embed/1",
        title: "Movie"
      }
    }, "host", "media-parent-page");

    expect(engine.state.playbackState).toMatchObject({
      activeMediaUrl: "https://example.com/movie",
      activeMediaPageUrl: "https://example.com/movie",
      activeMediaFrameUrl: "https://player.example/embed/1"
    });
    expect(event(result, "media-selected")?.payload).toMatchObject({
      media: {
        url: "https://example.com/movie",
        pageUrl: "https://example.com/movie",
        frameUrl: "https://player.example/embed/1"
      }
    });
  });

  it("targets drift correction only to the drifting viewer", () => {
    const engine = roomWithTwoUsers();
    engine.handle("playback-play", { currentTime: 50 }, "host", "play-1");
    const result = engine.handle("playback-drift-correction", { currentTime: 10 }, "viewer", "drift-1");

    const correction = event(result, "playback-state-sync");
    expect(correction?.targetUserId).toBe("viewer");
    expect(correction?.payload).toMatchObject({ reason: "drift-correction", correctedUserId: "viewer" });
  });

  it("replaces a participant record instead of duplicating the same user", () => {
    const engine = roomWithTwoUsers();
    engine.join({ ...participant("viewer"), sessionId: "replacement-session" });

    expect(engine.listParticipants()).toHaveLength(2);
    expect(engine.participants.get("viewer")?.sessionId).toBe("replacement-session");
  });

  it("removes an intentional room departure immediately", () => {
    const engine = roomWithTwoUsers();
    const result = engine.handle("room-leave", {}, "viewer", "leave-1");

    expect(engine.participants.has("viewer")).toBe(false);
    expect(event(result, "user-left-call")?.payload).toMatchObject({ userId: "viewer" });
    expect(event(result, "room-state")?.payload).toMatchObject({
      participants: [expect.objectContaining({ userId: "host" })]
    });
  });
});

describe("RoomEngine call signaling", () => {
  it("routes WebRTC offers only to the intended participant", () => {
    const engine = roomWithTwoUsers();
    const result = engine.handle("webrtc-offer", {
      toUserId: "viewer",
      description: { type: "offer", sdp: "test" }
    }, "host", "signal-1");

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ event: "webrtc-offer", targetUserId: "viewer" });
    expect(result.events[0].payload).toMatchObject({ fromUserId: "host", signalId: "signal-1" });
  });

  it("enforces the four-person call limit", () => {
    const engine = RoomEngine.create("ROOM1234", "host");
    ["host", "two", "three", "four", "five"].forEach((id, index) => {
      engine.join(participant(id, index === 0 ? "host" : "viewer"));
    });
    ["host", "two", "three", "four"].forEach((id) => {
      engine.handle("call-join", { muted: false, cameraOff: false }, id, `call-${id}`);
    });

    const result = engine.handle("call-join", { muted: false, cameraOff: false }, "five", "call-five");
    expect(event(result, "call-full")?.targetUserId).toBe("five");
    expect(engine.participants.get("five")?.callStatus).toBe("idle");
  });

  it("keeps mute and camera state in the participant snapshot", () => {
    const engine = roomWithTwoUsers();
    engine.handle("call-join", { muted: false, cameraOff: false }, "viewer", "call-1");
    engine.handle("call-status", { muted: true, cameraOff: false }, "viewer", "status-1");

    expect(engine.snapshot().participants.find((item) => item.userId === "viewer")).toMatchObject({
      callStatus: "connected",
      muted: true,
      cameraOff: false
    });
  });
});

describe("RoomEngine Live Share", () => {
  it("allows only the host to start and stop while preserving playback exactly", () => {
    const engine = roomWithTwoUsers("everyone");
    engine.handle("playback-play", { currentTime: 42, playbackRate: 1.25 }, "host", "play-before-share");
    const before = { ...engine.state.playbackState };

    const denied = engine.handle("live-share-start", { shareId: "share-1", hasAudio: true }, "viewer", "share-denied");
    expect(event(denied, "live-share-error")?.targetUserId).toBe("viewer");

    const started = engine.handle("live-share-start", { shareId: "share-1", hasAudio: true }, "host", "share-start");
    expect(event(started, "live-share-available")?.payload).toMatchObject({ shareId: "share-1", hasAudio: true });
    expect(engine.state.roomExperience).toBe("live-share");
    expect(engine.preLiveSharePlayback).toMatchObject({ currentTime: expect.any(Number), isPlaying: true });

    const playbackDuringShare = engine.handle("playback-pause", { currentTime: 80 }, "host", "pause-during-share");
    expect(event(playbackDuringShare, "playback-command")).toBeUndefined();

    const stopped = engine.handle("live-share-stop", {}, "host", "share-stop");
    expect(event(stopped, "live-share-ended")?.payload).toMatchObject({ shareId: "share-1" });
    expect(engine.state.roomExperience).toBe("synced-media");
    expect(engine.state.playbackState).toMatchObject({
      activeMediaUrl: before.activeMediaUrl,
      playbackRate: before.playbackRate,
      isPlaying: before.isPlaying
    });
    expect(engine.preLiveSharePlayback).toBeNull();
  });

  it("supports accept, decline, leave, reaccept, and targeted screen signaling", () => {
    const engine = roomWithTwoUsers();
    engine.handle("live-share-start", { shareId: "share-2" }, "host", "share-start");

    const declined = engine.handle("live-share-decline", { shareId: "share-2" }, "viewer", "decline");
    expect(event(declined, "live-share-decline")?.targetUserId).toBe("host");

    const accepted = engine.handle("live-share-accept", { shareId: "share-2" }, "viewer", "accept");
    expect(event(accepted, "live-share-accept")?.targetUserId).toBe("host");
    expect(engine.state.liveShare.viewerUserIds).toEqual(["viewer"]);

    const revisionAfterAccept = engine.state.revision;
    const reconnected = engine.handle("live-share-accept", { shareId: "share-2" }, "viewer", "accept-again");
    expect(event(reconnected, "live-share-accept")?.targetUserId).toBe("host");
    expect(event(reconnected, "room-state")).toBeUndefined();
    expect(engine.state.revision).toBe(revisionAfterAccept);

    const signal = engine.handle("screen-webrtc-offer", {
      shareId: "share-2",
      toUserId: "viewer",
      description: { type: "offer", sdp: "screen-only" }
    }, "host", "screen-signal");
    expect(signal.events).toHaveLength(1);
    expect(signal.events[0]).toMatchObject({ event: "screen-webrtc-offer", targetUserId: "viewer" });

    const unaccepted = participant("observer");
    engine.join(unaccepted);
    expect(engine.handle("screen-webrtc-answer", {
      shareId: "share-2",
      toUserId: "host",
      description: { type: "answer", sdp: "not-accepted" }
    }, "observer", "unaccepted-signal").events).toHaveLength(0);

    engine.handle("live-share-viewer-left", { shareId: "share-2" }, "viewer", "viewer-left");
    expect(engine.state.liveShare.viewerUserIds).toEqual([]);
    engine.handle("live-share-accept", { shareId: "share-2" }, "viewer", "reaccept");
    expect(engine.state.liveShare.viewerUserIds).toEqual(["viewer"]);
  });

  it("enforces four room participants and blocks unsupported clients", () => {
    const engine = RoomEngine.create("ROOM1234", "host");
    ["host", "two", "three", "four", "five"].forEach((id, index) => {
      engine.join(participant(id, index === 0 ? "host" : "viewer"));
    });
    expect(event(engine.handle("live-share-start", { shareId: "too-many" }, "host", "start"), "live-share-error")?.payload)
      .toMatchObject({ reason: "Live Share supports up to 4 room participants." });

    const compatible = roomWithTwoUsers();
    compatible.participants.set("viewer", { ...participant("viewer"), capabilities: [] });
    expect(event(compatible.handle("live-share-start", { shareId: "old-client" }, "host", "start-old"), "live-share-error")?.payload)
      .toMatchObject({ reason: expect.stringContaining("newer Havyn build") });
  });

  it("limits an active share to three viewers, including late joiners", () => {
    const engine = RoomEngine.create("ROOM1234", "host");
    engine.join(participant("host", "host"));
    ["two", "three", "four"].forEach((id) => engine.join(participant(id)));
    engine.handle("live-share-start", { shareId: "share-full" }, "host", "start");
    ["two", "three", "four"].forEach((id) => engine.handle("live-share-accept", { shareId: "share-full" }, id, `accept-${id}`));

    engine.join(participant("late"));
    const denied = engine.handle("live-share-accept", { shareId: "share-full" }, "late", "accept-late");
    expect(event(denied, "live-share-error")?.targetUserId).toBe("late");
    expect(engine.state.liveShare.viewerUserIds).toEqual(["two", "three", "four"]);
  });

  it("stops automatically when the host leaves", () => {
    const engine = roomWithTwoUsers();
    engine.handle("live-share-start", { shareId: "share-host-leave" }, "host", "start");
    const result = engine.leave("host");
    expect(event(result, "live-share-ended")?.payload).toMatchObject({ shareId: "share-host-leave" });
    expect(engine.state.roomExperience).toBe("synced-media");
  });

  it("keeps call presence intact throughout Live Share", () => {
    const engine = roomWithTwoUsers();
    engine.handle("call-join", { muted: false, cameraOff: false }, "host", "host-call");
    engine.handle("call-join", { muted: true, cameraOff: false }, "viewer", "viewer-call");

    engine.handle("live-share-start", { shareId: "share-with-call" }, "host", "share-start");
    engine.handle("live-share-accept", { shareId: "share-with-call" }, "viewer", "share-accept");
    engine.handle("live-share-stop", {}, "host", "share-stop");

    expect(engine.snapshot().participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "host", callStatus: "connected", muted: false, cameraOff: false }),
      expect.objectContaining({ userId: "viewer", callStatus: "connected", muted: true, cameraOff: false })
    ]));
  });
});
