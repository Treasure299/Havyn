import { updateParticipant } from "./roomManager.js";

const MAX_CALL_PARTICIPANTS = 4;
const calls = new Map();

function getCallSet(roomId) {
  if (!calls.has(roomId)) calls.set(roomId, new Map());
  return calls.get(roomId);
}

export function joinCall(roomId, user) {
  const callUsers = getCallSet(roomId);
  if (!callUsers.has(user.userId) && callUsers.size >= MAX_CALL_PARTICIPANTS) {
    return { ok: false, reason: "Call is full. Maximum 4 participants allowed in MVP." };
  }

  callUsers.set(user.userId, {
    userId: user.userId,
    socketId: user.socketId,
    displayName: user.displayName,
    muted: Boolean(user.muted),
    cameraOff: Boolean(user.cameraOff)
  });
  updateParticipant(roomId, user.userId, {
    callStatus: "in-call",
    muted: Boolean(user.muted),
    cameraOff: Boolean(user.cameraOff)
  });

  return { ok: true, users: listCallUsers(roomId) };
}

export function leaveCall(roomId, userId) {
  const callUsers = getCallSet(roomId);
  callUsers.delete(userId);
  updateParticipant(roomId, userId, { callStatus: "idle", muted: true, cameraOff: true });
  return listCallUsers(roomId);
}

export function updateCallUser(roomId, userId, patch) {
  const callUsers = getCallSet(roomId);
  const user = callUsers.get(userId);
  if (!user) return null;
  Object.assign(user, patch);
  updateParticipant(roomId, userId, patch);
  return user;
}

export function removeSocketFromCalls(socketId) {
  for (const [roomId, callUsers] of calls.entries()) {
    for (const user of callUsers.values()) {
      if (user.socketId === socketId) {
        callUsers.delete(user.userId);
        updateParticipant(roomId, user.userId, { callStatus: "idle", muted: true, cameraOff: true });
        return { roomId, user };
      }
    }
  }
  return null;
}

export function listCallUsers(roomId) {
  return Array.from(getCallSet(roomId).values());
}
