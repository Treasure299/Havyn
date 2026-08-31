import {
  defaultLiveShareState,
  defaultPlaybackState,
  isPlaybackMode,
  projectPlayback,
  type Participant,
  type MediaSuggestion,
  type PlaybackState,
  type RoomRole,
  type RoomState,
  type SelectedContent
} from "./protocol";

export interface EngineEvent {
  event: string;
  payload: unknown;
  targetUserId?: string;
  excludeSessionId?: string;
}

export interface EngineResult {
  events: EngineEvent[];
  stateChanged?: boolean;
  participantChanged?: boolean;
  closeCode?: number;
  closeReason?: string;
}

const PLAYBACK_ACTIONS: Record<string, string> = {
  "playback-play": "play",
  "playback-pause": "pause",
  "playback-seek": "seek",
  "playback-rate-change": "rate-change",
  "media-ended": "ended"
};

export class RoomEngine {
  state: RoomState;
  participants: Map<string, Participant>;
  preLiveSharePlayback: PlaybackState | null;

  constructor(state: RoomState, participants: Iterable<Participant> = [], preLiveSharePlayback: PlaybackState | null = null) {
    this.state = {
      ...state,
      playbackState: {
        ...state.playbackState,
        // Old rooms predate the explicit readiness gate. Treat their current
        // session as already underway instead of showing a stale overlay.
        sessionStartedAt: state.playbackState.sessionStartedAt === undefined && state.playbackState.mediaSessionId ? Date.now() : state.playbackState.sessionStartedAt ?? null
      },
      roomExperience: state.roomExperience === "live-share" ? "live-share" : "synced-media",
      liveShare: { ...defaultLiveShareState(), ...(state.liveShare || {}) },
      mediaSessionCounter: Number(state.mediaSessionCounter || 0),
      mediaSuggestions: Array.isArray(state.mediaSuggestions) ? state.mediaSuggestions : [],
      blockedGuestIds: Array.isArray(state.blockedGuestIds) ? state.blockedGuestIds : [],
      selectedContent: state.selectedContent || null
    };
    this.participants = new Map(Array.from(participants, (participant) => [participant.userId, participant]));
    this.preLiveSharePlayback = preLiveSharePlayback;
  }

  static create(roomId: string, hostUserId: string, room: Partial<RoomState> = {}): RoomEngine {
    const now = new Date().toISOString();
    return new RoomEngine({
      roomId,
      roomName: room.roomName || "Movie Night",
      hostUserId,
      visibility: room.visibility === "public" ? "public" : "private",
      playbackMode: isPlaybackMode(room.playbackMode) ? room.playbackMode : "host-only",
      playbackState: {
        ...defaultPlaybackState(hostUserId),
        ...(room.playbackState || {}),
        controllerUserId: room.playbackState?.controllerUserId || hostUserId,
        sequence: Number(room.playbackState?.sequence || 0)
      },
      roomExperience: "synced-media",
      liveShare: defaultLiveShareState(),
      mediaSessionCounter: Number(room.mediaSessionCounter || 0),
      mediaSuggestions: Array.isArray(room.mediaSuggestions) ? room.mediaSuggestions : [],
      blockedGuestIds: Array.isArray(room.blockedGuestIds) ? room.blockedGuestIds : [],
      selectedContent: room.selectedContent || null,
      createdAt: room.createdAt || now,
      revision: Number(room.revision || 1)
    });
  }

  snapshot(): RoomState & { participants: Participant[] } {
    return {
      ...this.state,
      playbackState: projectPlayback(this.state.playbackState),
      participants: this.listParticipants()
    };
  }

  listParticipants(): Participant[] {
    const roleOrder: Record<RoomRole, number> = { host: 0, cohost: 1, viewer: 2 };
    return Array.from(this.participants.values()).sort((left, right) => (
      roleOrder[left.role] - roleOrder[right.role] || left.displayName.localeCompare(right.displayName)
    ));
  }

  join(participant: Participant): EngineResult {
    const previous = this.participants.get(participant.userId);
    const role: RoomRole = this.state.hostUserId === participant.userId
      ? "host"
      : previous?.role || "viewer";
    this.participants.set(participant.userId, { ...previous, ...participant, role, online: true });
    const events: EngineEvent[] = [];
    if (!previous) events.push({ event: "chat-message", payload: systemMessage(`${participant.displayName} joined the room`) });
    events.push({ event: "room-state", payload: this.snapshot() });
    return { events, participantChanged: true };
  }

  leave(userId: string): EngineResult {
    const participant = this.participants.get(userId);
    if (!participant) return { events: [] };
    const stopped = this.state.roomExperience === "live-share" && this.state.liveShare.hostUserId === userId
      ? this.stopLiveShare(userId, true)
      : null;
    this.participants.delete(userId);
    const wasLiveShareViewer = this.state.liveShare.viewerUserIds.includes(userId);
    if (this.state.roomExperience === "live-share") {
      this.state.liveShare.viewerUserIds = this.state.liveShare.viewerUserIds.filter((viewerUserId) => viewerUserId !== userId);
    }
    const events: EngineEvent[] = [
      ...(stopped?.events || []),
      { event: "chat-message", payload: systemMessage(`${participant.displayName} left the room`) },
      { event: "user-left-call", payload: { userId } },
      { event: "room-state", payload: this.snapshot() }
    ];
    return { events, participantChanged: true, stateChanged: Boolean(stopped || wasLiveShareViewer) };
  }

  canControl(userId: string): boolean {
    const participant = this.participants.get(userId);
    if (!participant) return false;
    if (this.state.playbackMode === "everyone") return true;
    if (participant.role === "host" || this.state.hostUserId === userId) return true;
    return this.state.playbackMode === "host-and-cohosts" && participant.role === "cohost";
  }

  handle(event: string, payload: Record<string, unknown>, actorUserId: string, commandId: string): EngineResult {
    if (PLAYBACK_ACTIONS[event]) return this.handlePlayback(event, payload, actorUserId, commandId);
    switch (event) {
      case "chat-message":
        return this.chat(payload, actorUserId, commandId);
      case "room-reaction":
        return this.reaction(payload, actorUserId, commandId);
      case "room-leave":
        return this.leave(actorUserId);
      case "room-playback-mode":
        return this.setPlaybackMode(payload, actorUserId);
      case "room-role-update":
        return this.setRole(payload, actorUserId);
      case "room-guest-revoke":
        return this.revokeGuest(payload, actorUserId);
      case "room-content-select":
        return this.selectContent(payload, actorUserId);
      case "media-detected":
        return this.mediaDetected(payload, actorUserId);
      case "media-selected":
        return this.selectMedia(payload, actorUserId, commandId);
      case "media-suggestion-accept":
        return this.acceptMediaSuggestion(payload, actorUserId, commandId);
      case "media-suggestion-decline":
        return this.declineMediaSuggestion(payload, actorUserId);
      case "participant-sync-report":
        return this.syncReport(payload, actorUserId);
      case "playback-sync-request":
        return { events: [{ event: "playback-state-sync", payload: { ...projectPlayback(this.state.playbackState), reason: "sync-response", targetUserId: actorUserId }, targetUserId: actorUserId }] };
      case "playback-drift-correction":
        return this.correctDrift(payload, actorUserId);
      case "call-join":
        return this.joinCall(payload, actorUserId);
      case "call-leave":
        return this.leaveCall(actorUserId);
      case "call-status":
        return this.callStatus(payload, actorUserId);
      case "live-share-start":
        return this.startLiveShare(payload, actorUserId);
      case "live-share-accept":
        return this.acceptLiveShare(payload, actorUserId);
      case "live-share-decline":
        return this.declineLiveShare(payload, actorUserId);
      case "live-share-stop":
        return this.stopLiveShare(actorUserId);
      case "live-share-viewer-left":
        return this.leaveLiveShare(payload, actorUserId);
      case "webrtc-offer":
      case "webrtc-answer":
      case "webrtc-ice-candidate":
      case "webrtc-ice-candidates":
        return this.directSignal(event, payload, actorUserId, commandId);
      case "screen-webrtc-offer":
      case "screen-webrtc-answer":
      case "screen-webrtc-ice-candidate":
      case "screen-webrtc-ice-candidates":
        return this.directScreenSignal(event, payload, actorUserId, commandId);
      case "participant-media-ready":
        return this.mediaReady(payload, actorUserId);
      case "havyn-heartbeat":
        return this.heartbeat(actorUserId);
      default:
        return { events: [{ event: "permission-denied", payload: { reason: `Unsupported room command: ${event}` }, targetUserId: actorUserId }] };
    }
  }

  private bumpRevision(): void {
    this.state.revision += 1;
  }

  private participantPatch(userId: string, patch: Partial<Participant>): Participant | null {
    const current = this.participants.get(userId);
    if (!current) return null;
    const next = { ...current, ...patch, lastSeenAt: new Date().toISOString() };
    this.participants.set(userId, next);
    return next;
  }

  private denied(userId: string, reason = "Playback is controlled by the host."): EngineResult {
    return {
      events: [
        { event: "permission-denied", payload: { reason }, targetUserId: userId },
        { event: "playback-state-sync", payload: { ...projectPlayback(this.state.playbackState), reason: "permission-correction", targetUserId: userId }, targetUserId: userId }
      ]
    };
  }

  private revokeGuest(payload: Record<string, unknown>, actorUserId: string): EngineResult {
    if (this.state.hostUserId !== actorUserId) return this.denied(actorUserId, "Only the host can remove a guest.");
    const targetUserId = String(payload.targetUserId || "");
    const target = this.participants.get(targetUserId);
    if (!target?.guest) return this.denied(actorUserId, "Only guest participants can be removed this way.");

    this.state.blockedGuestIds = Array.from(new Set([...(this.state.blockedGuestIds || []), targetUserId])).slice(-80);
    this.participants.delete(targetUserId);
    this.bumpRevision();
    return {
      stateChanged: true,
      participantChanged: true,
      events: [
        { event: "guest-revoked", payload: { reason: "The host removed this guest from the room." }, targetUserId },
        { event: "room-action", payload: { message: `${target.displayName} was removed from the room.` } },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private handlePlayback(event: string, payload: Record<string, unknown>, userId: string, commandId: string): EngineResult {
    if (this.state.roomExperience === "live-share") {
      return { events: [{ event: "permission-denied", payload: { reason: "Playback controls are paused during Live Share." }, targetUserId: userId }] };
    }
    const action = PLAYBACK_ACTIONS[event];
    if (!this.canControl(userId)) return this.denied(userId);
    const now = Date.now();
    const projected = projectPlayback(this.state.playbackState, now);
    const next: PlaybackState = {
      ...this.state.playbackState,
      currentTime: finiteNumber(payload.currentTime, projected.currentTime),
      updatedAt: now,
      playbackRate: finiteNumber(payload.playbackRate, this.state.playbackState.playbackRate || 1),
      controllerUserId: userId,
      commandId,
      sequence: this.state.playbackState.sequence + 1
    };
    if (action === "play") {
      next.isPlaying = true;
      next.sessionStartedAt ||= now;
    }
    if (action === "pause" || action === "ended") next.isPlaying = false;
    if (action === "seek") next.currentTime = Math.max(0, finiteNumber(payload.currentTime, 0));
    if (action !== "rate-change") next.playbackRate = this.state.playbackState.playbackRate || 1;
    if (action === "rate-change") next.playbackRate = Math.min(4, Math.max(0.25, next.playbackRate));
    this.state.playbackState = next;
    console.log(JSON.stringify({ event: "room.playback-command", roomId: this.state.roomId, actorUserId: userId, action, sequence: next.sequence, currentTime: next.currentTime, isPlaying: next.isPlaying }));
    this.bumpRevision();
    const participant = this.participants.get(userId);
    return {
      stateChanged: true,
      participantChanged: true,
      events: [
        { event: "playback-command", payload: { action, state: next, commandId } },
        { event: "room-action", payload: roomAction(`${participant?.displayName || "Someone"} ${actionLabel(action)}`) },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private chat(payload: Record<string, unknown>, userId: string, commandId: string): EngineResult {
    const participant = this.participants.get(userId);
    const message = String(payload.message || "").trim().slice(0, 800);
    if (!participant || !message) return { events: [] };
    return {
      events: [{
        event: "chat-message",
        payload: {
          id: String(payload.id || commandId),
          type: "user",
          userId,
          displayName: participant.displayName,
          message,
          createdAt: new Date().toISOString()
        }
      }]
    };
  }

  private reaction(payload: Record<string, unknown>, userId: string, commandId: string): EngineResult {
    const participant = this.participants.get(userId);
    const emoji = String(payload.emoji || "").trim().slice(0, 16);
    if (!participant || !emoji) return { events: [] };
    return {
      events: [{
        event: "room-reaction",
        payload: {
          id: String(payload.id || commandId),
          userId,
          displayName: participant.displayName,
          emoji,
          createdAt: new Date().toISOString()
        }
      }]
    };
  }

  private setPlaybackMode(payload: Record<string, unknown>, userId: string): EngineResult {
    const playbackMode = payload.playbackMode;
    if (!isPlaybackMode(playbackMode)) return { events: [] };
    const participant = this.participants.get(userId);
    if (participant?.role !== "host" && this.state.hostUserId !== userId) {
      return this.denied(userId, "Only the host can change playback mode.");
    }
    this.state.playbackMode = playbackMode;
    this.bumpRevision();
    return {
      stateChanged: true,
      events: [
        { event: "room-action", payload: roomAction(`${participant?.displayName || "Someone"} set controls to ${playbackMode}`) },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private setRole(payload: Record<string, unknown>, userId: string): EngineResult {
    const actor = this.participants.get(userId);
    const targetUserId = String(payload.targetUserId || "");
    const target = this.participants.get(targetUserId);
    const role = payload.role === "cohost" ? "cohost" : "viewer";
    if (actor?.role !== "host" || !target || target.role === "host") {
      return this.denied(userId, "Only the host can manage cohosts.");
    }
    this.participantPatch(targetUserId, { role });
    return {
      participantChanged: true,
      events: [
        { event: "room-action", payload: roomAction(`${target.displayName} is now ${role === "cohost" ? "a cohost" : "a viewer"}`) },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private selectContent(payload: Record<string, unknown>, userId: string): EngineResult {
    const participant = this.participants.get(userId);
    if (!participant || (participant.role !== "host" && participant.role !== "cohost" && this.state.hostUserId !== userId)) {
      return this.denied(userId, "Only the host or a cohost can choose a title.");
    }

    const raw = (payload.content || {}) as Record<string, unknown>;
    const title = String(raw.title || "").trim().slice(0, 180);
    const id = String(raw.id || "").trim().slice(0, 120);
    if (!title || !id) {
      return this.denied(userId, "Choose a valid movie or series.");
    }
    const mediaType = raw.mediaType === "tv" ? "tv" : "movie";

    const providerRaw = raw.provider && typeof raw.provider === "object"
      ? raw.provider as Record<string, unknown>
      : null;
    const destination = String(providerRaw?.destination || "").trim().slice(0, 2048);
    const adapterId = ["cinesrc", "strigil", "moviesapi", "youtube"].includes(String(providerRaw?.adapterId || ""))
      ? String(providerRaw?.adapterId || "") as "cinesrc" | "strigil" | "moviesapi" | "youtube"
      : undefined;
    const origins: Record<string, string> = { cinesrc: "https://cinesrc.st", strigil: "https://strigil.cc", moviesapi: "https://moviesapi.to", youtube: "https://www.youtube.com" };
    let destinationOrigin = "";
    try { destinationOrigin = new URL(destination).origin; } catch { /* The empty capability below keeps malformed destinations manual. */ }
    const capability = adapterId && destinationOrigin === origins[adapterId] ? "synced" as const : "manual" as const;
    const provider = providerRaw && destination
      ? {
          id: String(providerRaw.id || providerRaw.name || "").slice(0, 120),
          name: String(providerRaw.name || "Provider").slice(0, 120),
          destination,
          capability,
          kind: providerRaw.kind === "embed" ? "embed" as const : "service" as const,
          source: String(providerRaw.source || "").slice(0, 80) || undefined,
          adapterId,
          origin: capability === "synced" && adapterId ? origins[adapterId] : undefined
        }
      : null;
    const content: SelectedContent = {
      id,
      mediaType,
      title,
      year: String(raw.year || "").slice(0, 16) || undefined,
      overview: String(raw.overview || "").slice(0, 1500) || undefined,
      posterUrl: String(raw.posterUrl || "").slice(0, 2048) || undefined,
      backdropUrl: String(raw.backdropUrl || "").slice(0, 2048) || undefined,
      provider,
      selectedByUserId: userId,
      selectedAt: Date.now()
    };
    this.state.selectedContent = content;
    // Choosing a provider is a source change, even before the host presses
    // play. Establish its session here so reports and remote commands agree.
    this.state.mediaSessionCounter = Number(this.state.mediaSessionCounter || 0) + 1;
    const mediaSessionId = `${this.state.roomId}:${this.state.mediaSessionCounter}`;
    const sourceFingerprint = fingerprintMedia({
      url: provider?.destination || `havyn:${mediaType}:${id}`,
      pageUrl: provider?.destination || "",
      frameUrl: provider?.destination || "",
      title
    });
    this.state.playbackState = {
      ...this.state.playbackState,
      isPlaying: false,
      currentTime: 0,
      updatedAt: Date.now(),
      playbackRate: 1,
      activeMediaUrl: provider?.destination || "",
      activeMediaPageUrl: provider?.destination || "",
      activeMediaFrameUrl: provider?.destination || "",
      activeMediaTitle: title,
      controllerUserId: userId,
      commandId: undefined,
      sequence: this.state.playbackState.sequence + 1,
      mediaSessionId,
      sourceFingerprint,
      sessionStartedAt: null
    };
    for (const current of this.participants.values()) {
      this.participantPatch(current.userId, { syncStatus: "checking", syncDriftSeconds: undefined, mediaSessionId: "", sourceFingerprint: "", lastAppliedSequence: 0, buffering: false });
    }
    this.bumpRevision();
    return {
      stateChanged: true,
      events: [
        { event: "room-content-selected", payload: content },
        { event: "room-action", payload: roomAction(`${participant.displayName} selected ${title}`) },
        { event: "playback-state-sync", payload: this.state.playbackState },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private mediaDetected(payload: Record<string, unknown>, userId: string): EngineResult {
    this.participantPatch(userId, { mediaReady: true });
    return {
      participantChanged: true,
      events: [
        { event: "media-detected", payload: { userId, media: payload.media } },
        { event: "participant-media-ready", payload: { userId, mediaReady: true } },
        { event: "playback-state-sync", payload: { ...projectPlayback(this.state.playbackState), reason: "media-detected" }, targetUserId: userId },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private mediaReady(payload: Record<string, unknown>, userId: string): EngineResult {
    this.participantPatch(userId, { mediaReady: Boolean(payload.mediaReady ?? true) });
    return { participantChanged: true, events: [{ event: "room-state", payload: this.snapshot() }] };
  }

  private selectMedia(payload: Record<string, unknown>, userId: string, commandId: string): EngineResult {
    const participant = this.participants.get(userId);
    if (!participant) return { events: [] };
    const media = (payload.media || {}) as Record<string, unknown>;
    const pageUrl = String(media.pageUrl || media.url || media.frameUrl || "");
    const frameUrl = String(media.frameUrl || media.url || pageUrl);
    const normalizedMedia = {
      ...media,
      // Keep the compatibility URL canonical. Participants navigate to the
      // shared page; frameUrl is used only to locate the embedded video.
      url: pageUrl,
      pageUrl,
      frameUrl
    };
    const sourceFingerprint = fingerprintMedia(normalizedMedia);
    if (participant.role !== "host" && this.state.hostUserId !== userId) {
      if (participant.role !== "cohost") return this.denied(userId, "Only the host can change the room source.");
      const suggestion: MediaSuggestion = {
        id: commandId,
        userId,
        displayName: participant.displayName,
        media: normalizedMedia,
        sourceFingerprint,
        createdAt: new Date().toISOString()
      };
      this.state.mediaSuggestions = [
        ...(this.state.mediaSuggestions || []).filter((item) => item.userId !== userId),
        suggestion
      ].slice(-4);
      this.bumpRevision();
      return {
        stateChanged: true,
        events: [
          { event: "media-suggestion-created", payload: suggestion, targetUserId: this.state.hostUserId },
          { event: "room-action", payload: roomAction(`${participant.displayName} suggested a source`), targetUserId: this.state.hostUserId },
          { event: "room-state", payload: this.snapshot() }
        ]
      };
    }
    return this.activateMedia(normalizedMedia, sourceFingerprint, userId, commandId);
  }

  private activateMedia(media: Record<string, unknown>, sourceFingerprint: string, userId: string, commandId: string): EngineResult {
    const pageUrl = String(media.pageUrl || media.url || media.frameUrl || "");
    const frameUrl = String(media.frameUrl || media.url || pageUrl);
    const now = Date.now();
    this.state.mediaSessionCounter = Number(this.state.mediaSessionCounter || 0) + 1;
    const mediaSessionId = `${this.state.roomId}:${this.state.mediaSessionCounter}`;
    this.state.playbackState = {
      ...this.state.playbackState,
      isPlaying: media.paused === false,
      currentTime: Math.max(0, finiteNumber(media.currentTime, 0)),
      updatedAt: now,
      playbackRate: finiteNumber(media.playbackRate, 1),
      activeMediaUrl: pageUrl,
      activeMediaPageUrl: pageUrl,
      activeMediaFrameUrl: frameUrl,
      activeMediaTitle: String(media.title || "Detected media"),
      controllerUserId: userId,
      commandId,
      sequence: this.state.playbackState.sequence + 1,
      mediaSessionId,
      sourceFingerprint,
      sessionStartedAt: null
    };
    this.state.mediaSuggestions = [];
    for (const participant of this.participants.values()) {
      this.participantPatch(participant.userId, {
        syncStatus: "checking",
        syncDriftSeconds: undefined,
        mediaSessionId: "",
        sourceFingerprint: "",
        lastAppliedSequence: 0,
        buffering: false
      });
    }
    this.bumpRevision();
    return {
      stateChanged: true,
      participantChanged: true,
      events: [
        { event: "media-selected", payload: { media, playbackState: this.state.playbackState, mediaSessionId, sourceFingerprint } },
        { event: "playback-state-sync", payload: this.state.playbackState },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private acceptMediaSuggestion(payload: Record<string, unknown>, userId: string, commandId: string): EngineResult {
    if (userId !== this.state.hostUserId) return this.denied(userId, "Only the host can accept source suggestions.");
    const suggestionId = String(payload.suggestionId || "");
    const suggestion = (this.state.mediaSuggestions || []).find((item) => item.id === suggestionId);
    if (!suggestion) return { events: [] };
    return this.activateMedia(suggestion.media, suggestion.sourceFingerprint, userId, commandId);
  }

  private declineMediaSuggestion(payload: Record<string, unknown>, userId: string): EngineResult {
    if (userId !== this.state.hostUserId) return this.denied(userId, "Only the host can decline source suggestions.");
    const suggestionId = String(payload.suggestionId || "");
    const previous = this.state.mediaSuggestions || [];
    const suggestion = previous.find((item) => item.id === suggestionId);
    this.state.mediaSuggestions = previous.filter((item) => item.id !== suggestionId);
    if (this.state.mediaSuggestions.length === previous.length) return { events: [] };
    this.bumpRevision();
    const host = this.participants.get(userId);
    return {
      stateChanged: true,
      events: [
        {
          event: "room-action",
          payload: roomAction(`${host?.displayName || "Host"} declined ${suggestion?.displayName || "a cohost"}'s source suggestion`)
        },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private syncReport(payload: Record<string, unknown>, userId: string): EngineResult {
    const participant = this.participants.get(userId);
    if (!participant) return { events: [] };
    const authoritative = projectPlayback(this.state.playbackState);
    const mediaSessionId = String(payload.mediaSessionId || "");
    const sourceFingerprint = String(payload.sourceFingerprint || "");
    const currentTime = Math.max(0, finiteNumber(payload.currentTime, 0));
    const drift = Math.abs(currentTime - authoritative.currentTime);
    const buffering = Boolean(payload.buffering);
    const sequence = Math.max(0, finiteNumber(payload.lastAppliedSequence, 0));
    const localPlaying = Boolean(payload.isPlaying);
    let syncStatus: Participant["syncStatus"] = "checking";
    if (!authoritative.mediaSessionId) syncStatus = "checking";
    else if (mediaSessionId !== authoritative.mediaSessionId || sourceFingerprint !== authoritative.sourceFingerprint) syncStatus = "out-of-sync";
    else if (buffering) syncStatus = "buffering";
    else if (sequence < authoritative.sequence || localPlaying !== authoritative.isPlaying) syncStatus = "catching-up";
    else if (drift <= 0.85) syncStatus = "synced";
    else if (drift <= 2.5) syncStatus = "catching-up";
    else syncStatus = "out-of-sync";
    const changed = participant.syncStatus !== syncStatus || participant.mediaSessionId !== mediaSessionId;
    if (changed) console.log(JSON.stringify({ event: "room.sync-status", roomId: this.state.roomId, userId, syncStatus, drift: Math.round(drift * 100) / 100, sequence }));
    this.participantPatch(userId, {
      syncStatus,
      syncDriftSeconds: Math.round(drift * 10) / 10,
      syncReportedAt: Date.now(),
      mediaSessionId,
      sourceFingerprint,
      lastAppliedSequence: sequence,
      buffering
    });
    return {
      participantChanged: true,
      events: changed ? [{ event: "participant-sync-status", payload: { userId, syncStatus, driftSeconds: drift } }, { event: "room-state", payload: this.snapshot() }] : []
    };
  }

  private correctDrift(payload: Record<string, unknown>, userId: string): EngineResult {
    if (this.canControl(userId)) return { events: [] };
    const state = projectPlayback(this.state.playbackState);
    if (Math.abs(finiteNumber(payload.currentTime, 0) - state.currentTime) <= 1.5) return { events: [] };
    return {
      events: [{
        event: "playback-state-sync",
        payload: { ...state, reason: "drift-correction", correctedUserId: userId },
        targetUserId: userId
      }]
    };
  }

  private joinCall(payload: Record<string, unknown>, userId: string): EngineResult {
    const connected = this.listParticipants().filter((participant) => participant.callStatus === "connected");
    if (!connected.some((participant) => participant.userId === userId) && connected.length >= 4) {
      return { events: [{ event: "call-full", payload: { message: "Call is full. Maximum 4 participants allowed in MVP." }, targetUserId: userId }] };
    }
    const participant = this.participantPatch(userId, {
      callStatus: "connected",
      muted: Boolean(payload.muted),
      cameraOff: Boolean(payload.cameraOff)
    });
    if (!participant) return { events: [] };
    const peers = connected.filter((peer) => peer.userId !== userId);
    return {
      participantChanged: true,
      events: [
        { event: "call-users", payload: peers, targetUserId: userId },
        { event: "call-user-joined", payload: { user: { ...participant, socketId: participant.userId } }, excludeSessionId: participant.sessionId },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private leaveCall(userId: string): EngineResult {
    if (!this.participantPatch(userId, { callStatus: "idle", muted: true, cameraOff: true })) return { events: [] };
    return {
      participantChanged: true,
      events: [
        { event: "user-left-call", payload: { userId } },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private callStatus(payload: Record<string, unknown>, userId: string): EngineResult {
    if (!this.participantPatch(userId, {
      callStatus: "connected",
      muted: Boolean(payload.muted),
      cameraOff: Boolean(payload.cameraOff)
    })) return { events: [] };
    return {
      participantChanged: true,
      events: [
        { event: "call-status", payload: { userId, muted: Boolean(payload.muted), cameraOff: Boolean(payload.cameraOff) } },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private directSignal(event: string, payload: Record<string, unknown>, userId: string, commandId: string): EngineResult {
    const targetUserId = String(payload.toUserId || "");
    if (!targetUserId || !this.participants.has(targetUserId)) return { events: [] };
    return {
      events: [{
        event,
        payload: { ...payload, fromUserId: userId, signalId: String(payload.signalId || commandId) },
        targetUserId
      }]
    };
  }

  private startLiveShare(payload: Record<string, unknown>, userId: string): EngineResult {
    if (this.state.hostUserId !== userId) {
      return { events: [{ event: "live-share-error", payload: { reason: "Only the host can start Live Share." }, targetUserId: userId }] };
    }
    if (this.listParticipants().length > 4) {
      return { events: [{ event: "live-share-error", payload: { reason: "Live Share supports up to 4 room participants." }, targetUserId: userId }] };
    }
    const unsupported = this.listParticipants().find((participant) => !participant.capabilities?.includes("live-share-v1"));
    if (unsupported) {
      return { events: [{ event: "live-share-error", payload: { reason: `${unsupported.displayName} needs a newer Havyn build for Live Share.` }, targetUserId: userId }] };
    }
    if (this.state.roomExperience === "live-share") return { events: [] };
    const shareId = String(payload.shareId || crypto.randomUUID());
    this.preLiveSharePlayback = projectPlayback(this.state.playbackState);
    this.state.roomExperience = "live-share";
    this.state.liveShare = {
      status: "available",
      shareId,
      hostUserId: userId,
      hasAudio: Boolean(payload.hasAudio),
      startedAt: Date.now(),
      viewerUserIds: []
    };
    this.bumpRevision();
    const host = this.participants.get(userId);
    return {
      stateChanged: true,
      events: [
        { event: "live-share-available", payload: { ...this.state.liveShare, hostDisplayName: host?.displayName || "The host" } },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private acceptLiveShare(payload: Record<string, unknown>, userId: string): EngineResult {
    if (this.state.roomExperience !== "live-share" || String(payload.shareId || "") !== this.state.liveShare.shareId) return { events: [] };
    if (userId === this.state.liveShare.hostUserId) return { events: [] };
    const participant = this.participants.get(userId);
    if (!participant?.capabilities?.includes("live-share-v1")) {
      return { events: [{ event: "live-share-error", payload: { reason: "Update Havyn to watch Live Share." }, targetUserId: userId }] };
    }
    const alreadyWatching = this.state.liveShare.viewerUserIds.includes(userId);
    if (!alreadyWatching && this.state.liveShare.viewerUserIds.length >= 3) {
      return { events: [{ event: "live-share-error", payload: { reason: "Live Share supports up to 4 participants, including the host." }, targetUserId: userId }] };
    }
    if (!alreadyWatching) this.state.liveShare.viewerUserIds.push(userId);
    this.state.liveShare.status = "active";
    if (!alreadyWatching) this.bumpRevision();
    return {
      stateChanged: !alreadyWatching,
      events: [
        { event: "live-share-accept", payload: { shareId: this.state.liveShare.shareId, viewerUserId: userId }, targetUserId: this.state.liveShare.hostUserId || undefined },
        ...(!alreadyWatching ? [{ event: "room-state", payload: this.snapshot() }] : [])
      ]
    };
  }

  private declineLiveShare(payload: Record<string, unknown>, userId: string): EngineResult {
    if (this.state.roomExperience !== "live-share" || String(payload.shareId || "") !== this.state.liveShare.shareId) return { events: [] };
    return {
      events: [{
        event: "live-share-decline",
        payload: { shareId: this.state.liveShare.shareId, viewerUserId: userId },
        targetUserId: this.state.liveShare.hostUserId || undefined
      }]
    };
  }

  private leaveLiveShare(payload: Record<string, unknown>, userId: string): EngineResult {
    if (this.state.roomExperience !== "live-share" || String(payload.shareId || "") !== this.state.liveShare.shareId) return { events: [] };
    this.state.liveShare.viewerUserIds = this.state.liveShare.viewerUserIds.filter((viewerUserId) => viewerUserId !== userId);
    this.state.liveShare.status = this.state.liveShare.viewerUserIds.length ? "active" : "available";
    this.bumpRevision();
    return {
      stateChanged: true,
      events: [
        { event: "live-share-viewer-left", payload: { shareId: this.state.liveShare.shareId, viewerUserId: userId }, targetUserId: this.state.liveShare.hostUserId || undefined },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private stopLiveShare(userId: string, hostDeparture = false): EngineResult {
    if (this.state.roomExperience !== "live-share") return { events: [] };
    if (!hostDeparture && this.state.hostUserId !== userId) {
      return { events: [{ event: "live-share-error", payload: { reason: "Only the host can stop Live Share." }, targetUserId: userId }] };
    }
    const shareId = this.state.liveShare.shareId;
    const restoredPlaybackState = this.preLiveSharePlayback ? { ...this.preLiveSharePlayback } : { ...this.state.playbackState };
    this.state.playbackState = restoredPlaybackState;
    this.state.roomExperience = "synced-media";
    this.state.liveShare = defaultLiveShareState();
    this.preLiveSharePlayback = null;
    this.bumpRevision();
    return {
      stateChanged: true,
      events: [
        { event: "live-share-ended", payload: { shareId, playbackState: restoredPlaybackState } },
        { event: "room-state", payload: this.snapshot() }
      ]
    };
  }

  private directScreenSignal(event: string, payload: Record<string, unknown>, userId: string, commandId: string): EngineResult {
    if (this.state.roomExperience !== "live-share") return { events: [] };
    if (String(payload.shareId || "") !== this.state.liveShare.shareId) return { events: [] };
    const targetUserId = String(payload.toUserId || "");
    if (!targetUserId || !this.participants.has(targetUserId)) return { events: [] };
    const hostUserId = this.state.liveShare.hostUserId;
    const viewers = this.state.liveShare.viewerUserIds;
    const hostToViewer = userId === hostUserId && viewers.includes(targetUserId);
    const viewerToHost = targetUserId === hostUserId && viewers.includes(userId);
    if (!hostToViewer && !viewerToHost) return { events: [] };
    return {
      events: [{
        event,
        payload: { ...payload, fromUserId: userId, signalId: String(payload.signalId || commandId) },
        targetUserId
      }]
    };
  }

  private heartbeat(userId: string): EngineResult {
    if (!this.participantPatch(userId, {})) return { events: [] };
    return { participantChanged: true, events: [] };
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function systemMessage(message: string) {
  return { id: crypto.randomUUID(), type: "system", displayName: "Havyn", message, createdAt: new Date().toISOString() };
}

function roomAction(message: string) {
  return { id: crypto.randomUUID(), type: "playback", message, createdAt: new Date().toISOString() };
}

function fingerprintMedia(media: Record<string, unknown>): string {
  const raw = [
    String(media.pageUrl || media.url || "").trim().toLowerCase(),
    String(media.frameUrl || "").trim().toLowerCase(),
    String(media.title || "").trim().toLowerCase(),
    Math.round(finiteNumber(media.duration, 0))
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `media-${(hash >>> 0).toString(36)}`;
}

function actionLabel(action: string): string {
  return ({
    play: "played",
    pause: "paused",
    seek: "seeked",
    "rate-change": "changed speed",
    ended: "ended playback"
  } as Record<string, string>)[action] || "updated playback";
}
