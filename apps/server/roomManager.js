export const PLAYBACK_MODES = {
  HOST_ONLY: "host-only",
  HOST_AND_COHOSTS: "host-and-cohosts",
  EVERYONE: "everyone"
};

export const ROOM_ROLES = {
  HOST: "host",
  COHOST: "cohost",
  VIEWER: "viewer"
};

const rooms = new Map();

const defaultPlaybackState = () => ({
  isPlaying: false,
  currentTime: 0,
  updatedAt: Date.now(),
  playbackRate: 1,
  activeMediaUrl: "",
  activeMediaTitle: "",
  controllerUserId: null
});

function normalizePlaybackState(state) {
  return {
    ...defaultPlaybackState(),
    ...(state || {}),
    updatedAt: Date.now()
  };
}

export function getOrCreateRoom(roomId, { roomName, hostUserId, hostName } = {}) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      roomName: roomName || "Untitled Havyn Room",
      hostUserId,
      playbackMode: PLAYBACK_MODES.HOST_ONLY,
      participants: new Map(),
      chatMessages: [],
      playbackState: defaultPlaybackState(),
      createdAt: new Date().toISOString()
    });
  }

  const room = rooms.get(roomId);
  if (!room.hostUserId && hostUserId) room.hostUserId = hostUserId;
  if (roomName) room.roomName = roomName;
  if (hostName && hostUserId && !room.participants.has(hostUserId)) {
    addParticipant(roomId, { userId: hostUserId, displayName: hostName, role: ROOM_ROLES.HOST });
  }
  return room;
}

export function restoreRoom(snapshot = {}) {
  const existed = rooms.has(snapshot.roomId);
  const room = getOrCreateRoom(snapshot.roomId, {
    roomName: snapshot.roomName,
    hostUserId: snapshot.hostUserId
  });
  if (existed) return room;
  if (snapshot.hostUserId) room.hostUserId = snapshot.hostUserId;
  if (snapshot.roomName) room.roomName = snapshot.roomName;
  if (Object.values(PLAYBACK_MODES).includes(snapshot.playbackMode)) {
    room.playbackMode = snapshot.playbackMode;
  }
  if (snapshot.playbackState) {
    room.playbackState = normalizePlaybackState(snapshot.playbackState);
  }
  return room;
}

export function addParticipant(roomId, participant) {
  const room = getOrCreateRoom(roomId, {
    roomName: participant.roomName,
    hostUserId: participant.isCreating ? participant.userId : undefined
  });

  const existing = room.participants.get(participant.userId);
  const role = participant.role || existing?.role || (room.hostUserId === participant.userId ? ROOM_ROLES.HOST : ROOM_ROLES.VIEWER);

  room.participants.set(participant.userId, {
    userId: participant.userId,
    socketId: participant.socketId,
    displayName: participant.displayName || "Havyn User",
    role,
    online: true,
    callStatus: existing?.callStatus || "idle",
    mediaReady: existing?.mediaReady || false,
    muted: existing?.muted ?? true,
    cameraOff: existing?.cameraOff ?? true,
    joinedAt: existing?.joinedAt || new Date().toISOString()
  });

  return room.participants.get(participant.userId);
}

export function removeSocketParticipant(socketId) {
  for (const room of rooms.values()) {
    for (const participant of room.participants.values()) {
      if (participant.socketId === socketId) {
        participant.online = false;
        participant.socketId = null;
        participant.callStatus = "idle";
        return { room, participant };
      }
    }
  }
  return null;
}

export function getRoom(roomId) {
  return rooms.get(roomId);
}

export function getParticipant(roomId, userId) {
  return rooms.get(roomId)?.participants.get(userId);
}

export function getParticipantBySocket(roomId, socketId) {
  return listParticipants(roomId).find((participant) => participant.socketId === socketId);
}

export function listParticipants(roomId) {
  return Array.from(rooms.get(roomId)?.participants.values() || []);
}

export function updateParticipant(roomId, userId, patch) {
  const participant = getParticipant(roomId, userId);
  if (!participant) return null;
  Object.assign(participant, patch);
  return participant;
}

export function setParticipantRole(roomId, actorUserId, targetUserId, role) {
  const room = getRoom(roomId);
  const actor = getParticipant(roomId, actorUserId);
  const target = getParticipant(roomId, targetUserId);
  if (!room || !actor || !target) return null;
  if (actor.role !== ROOM_ROLES.HOST || target.role === ROOM_ROLES.HOST) return null;
  if (![ROOM_ROLES.COHOST, ROOM_ROLES.VIEWER].includes(role)) return null;
  target.role = role;
  return target;
}

export function setPlaybackMode(roomId, playbackMode) {
  const room = getRoom(roomId);
  if (!room || !Object.values(PLAYBACK_MODES).includes(playbackMode)) return null;
  room.playbackMode = playbackMode;
  return room;
}

export function serializeRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) return null;
  return {
    roomId: room.roomId,
    roomName: room.roomName,
    hostUserId: room.hostUserId,
    playbackMode: room.playbackMode,
    createdAt: room.createdAt,
    participants: listParticipants(roomId),
    playbackState: room.playbackState
  };
}
