export const PROTOCOL_VERSION = 2 as const;

export const PLAYBACK_MODES = ["host-only", "host-and-cohosts", "everyone"] as const;
export type PlaybackMode = typeof PLAYBACK_MODES[number];
export type RoomRole = "host" | "cohost" | "viewer";
export type RoomExperience = "synced-media" | "live-share";

export interface LiveShareState {
  status: "idle" | "available" | "active";
  shareId: string | null;
  hostUserId: string | null;
  hasAudio: boolean;
  startedAt: number | null;
  viewerUserIds: string[];
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  updatedAt: number;
  playbackRate: number;
  activeMediaUrl: string;
  activeMediaPageUrl?: string;
  activeMediaFrameUrl?: string;
  activeMediaTitle: string;
  controllerUserId: string | null;
  commandId?: string;
  sequence: number;
}

export interface Participant {
  sessionId: string;
  userId: string;
  displayName: string;
  role: RoomRole;
  online: boolean;
  mediaReady: boolean;
  callStatus: "idle" | "connected";
  muted: boolean;
  cameraOff: boolean;
  joinedAt: string;
  lastSeenAt: string;
  capabilities?: string[];
}

export interface RoomState {
  roomId: string;
  roomName: string;
  hostUserId: string;
  visibility: "private" | "public";
  playbackMode: PlaybackMode;
  playbackState: PlaybackState;
  roomExperience: RoomExperience;
  liveShare: LiveShareState;
  createdAt: string;
  revision: number;
}

export interface RoomTicketClaims {
  roomId: string;
  userId: string;
  displayName: string;
  creating: boolean;
  resuming: boolean;
  room?: Partial<RoomState>;
  exp: number;
  jti: string;
  capabilities?: string[];
}

export interface ClientEnvelope {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: "command" | "ack" | "ping";
  roomId: string;
  sentAt: number;
  event?: string;
  payload?: Record<string, unknown>;
  sequence?: number;
}

export interface ServerEnvelope {
  v: typeof PROTOCOL_VERSION;
  id: string;
  type: "event" | "snapshot" | "ack" | "error" | "pong";
  roomId: string;
  sentAt: number;
  sequence: number;
  event?: string;
  payload?: unknown;
  replyTo?: string;
}

export function isPlaybackMode(value: unknown): value is PlaybackMode {
  return PLAYBACK_MODES.includes(value as PlaybackMode);
}

export function defaultPlaybackState(hostUserId: string | null): PlaybackState {
  return {
    isPlaying: false,
    currentTime: 0,
    updatedAt: Date.now(),
    playbackRate: 1,
    activeMediaUrl: "",
    activeMediaTitle: "",
    controllerUserId: hostUserId,
    sequence: 0
  };
}

export function defaultLiveShareState(): LiveShareState {
  return {
    status: "idle",
    shareId: null,
    hostUserId: null,
    hasAudio: false,
    startedAt: null,
    viewerUserIds: []
  };
}

export function projectPlayback(state: PlaybackState, at = Date.now()): PlaybackState {
  if (!state.isPlaying) return { ...state };
  return {
    ...state,
    currentTime: Math.max(0, state.currentTime + ((at - state.updatedAt) / 1000) * state.playbackRate),
    updatedAt: at
  };
}
