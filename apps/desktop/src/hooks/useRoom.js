import { useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "../lib/socketClient";
import { supabase } from "../lib/supabaseClient";

export function useRoom(user) {
  const socket = useMemo(() => getSocket(), []);
  const userId = user?.id;
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [permissionNotice, setPermissionNotice] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const roomRef = useRef(null);
  const leavingRoomIdRef = useRef(null);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  function projectedPlaybackState(state) {
    if (!state?.isPlaying) return state;
    return {
      ...state,
      currentTime: state.currentTime + ((Date.now() - state.updatedAt) / 1000) * (state.playbackRate || 1),
      updatedAt: Date.now()
    };
  }

  function playTone(kind) {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = kind === "join" ? 660 : 460;
      gain.gain.setValueAtTime(0.0001, audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(kind === "join" ? 0.035 : 0.025, audio.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start();
      oscillator.stop(audio.currentTime + 0.2);
    } catch {
      // Sound cues are a polish layer; ignore browsers that block them.
    }
  }

  useEffect(() => {
    const handleRoomState = (nextRoom) => {
      if (nextRoom?.roomId && leavingRoomIdRef.current === nextRoom.roomId) return;
      setRoom(nextRoom);
    };
    const handleMessage = (message) => {
      setMessages((items) => [...items.slice(-120), message]);
      if (/joined the room|created the room/i.test(message.message || "")) playTone("join");
      else if (message.userId !== userId) playTone("message");
    };
    const handleAction = (action) => {
      setActionNotice(action.message);
      window.setTimeout(() => setActionNotice(""), 1800);
    };
    const handleDenied = ({ reason }) => {
      setPermissionNotice(reason);
      window.setTimeout(() => setPermissionNotice(""), 2200);
    };

    socket.on("room-state", handleRoomState);
    socket.on("chat-message", handleMessage);
    socket.on("room-action", handleAction);
    socket.on("permission-denied", handleDenied);
    return () => {
      socket.off("room-state", handleRoomState);
      socket.off("chat-message", handleMessage);
      socket.off("room-action", handleAction);
      socket.off("permission-denied", handleDenied);
    };
  }, [socket, userId]);

  useEffect(() => {
    if (!user) return undefined;

    const resumeRoom = () => {
      const currentRoom = roomRef.current;
      if (!currentRoom?.roomId) return;
      if (leavingRoomIdRef.current === currentRoom.roomId) return;
      const participant = currentRoom.participants?.find((item) => item.userId === user.id);
      socket.emit("room-resume", {
        room: {
          roomId: currentRoom.roomId,
          roomName: currentRoom.roomName,
          hostUserId: currentRoom.hostUserId,
          playbackMode: currentRoom.playbackMode,
          playbackState: projectedPlaybackState(currentRoom.playbackState)
        },
        user: {
          userId: user.id,
          displayName: user.displayName,
          role: participant?.role
        }
      });
    };

    socket.on("connect", resumeRoom);
    socket.io.on("reconnect", resumeRoom);
    return () => {
      socket.off("connect", resumeRoom);
      socket.io.off("reconnect", resumeRoom);
    };
  }, [socket, user]);

  async function createRoom(name) {
    if (!user) return null;
    leavingRoomIdRef.current = null;
    const roomId = crypto.randomUUID().slice(0, 8).toUpperCase();
    const roomName = name || "Friday Watch";
    socket.emit("room-create", {
      roomId,
      roomName,
      user: { userId: user.id, displayName: user.displayName }
    });

    if (supabase) {
      await supabase.from("profiles").upsert(
        { id: user.id, display_name: user.displayName },
        { onConflict: "id" }
      );
      await supabase.from("rooms").insert({
        id: roomId,
        name: roomName,
        host_user_id: user.id,
        playback_mode: "host-only"
      });
      await supabase.from("room_members").insert({ room_id: roomId, user_id: user.id, role: "host" });
    }
    return roomId;
  }

  async function joinRoom(roomId) {
    if (!user) return;
    leavingRoomIdRef.current = null;
    socket.emit("room-join", {
      roomId: roomId.trim().toUpperCase(),
      user: { userId: user.id, displayName: user.displayName }
    });
    if (supabase) {
      await supabase.from("profiles").upsert(
        { id: user.id, display_name: user.displayName },
        { onConflict: "id" }
      );
      await supabase.from("room_members").upsert(
        { room_id: roomId.trim().toUpperCase(), user_id: user.id, role: "viewer" },
        { onConflict: "room_id,user_id" }
      );
    }
  }

  function leaveRoom() {
    if (!room || !user) return;
    leavingRoomIdRef.current = room.roomId;
    roomRef.current = null;
    socket.emit("room-leave", { roomId: room.roomId, userId: user.id });
    setRoom(null);
    setMessages([]);
  }

  function sendMessage(message) {
    if (!room || !user) return;
    socket.emit("chat-message", {
      roomId: room.roomId,
      user: { userId: user.id, displayName: user.displayName },
      message
    });
  }

  function setPlaybackMode(playbackMode) {
    if (!room || !user) return;
    socket.emit("room-playback-mode", { roomId: room.roomId, userId: user.id, playbackMode });
  }

  function setParticipantRole(targetUserId, role) {
    if (!room || !user) return;
    socket.emit("room-role-update", { roomId: room.roomId, actorUserId: user.id, targetUserId, role });
  }

  function updatePlaybackSnapshot(playbackState) {
    if (!playbackState) return;
    setRoom((currentRoom) => {
      if (!currentRoom) return currentRoom;
      const nextRoom = { ...currentRoom, playbackState };
      roomRef.current = nextRoom;
      return nextRoom;
    });
  }

  return {
    socket,
    room,
    messages,
    permissionNotice,
    actionNotice,
    createRoom,
    joinRoom,
    leaveRoom,
    sendMessage,
    setPlaybackMode,
    setParticipantRole,
    updatePlaybackSnapshot
  };
}
