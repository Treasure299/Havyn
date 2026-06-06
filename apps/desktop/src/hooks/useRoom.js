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
  const seenMessageIdsRef = useRef(new Set());

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

  function normalizeSavedPlaybackState(savedRoom) {
    const savedState = savedRoom?.active_media_state;
    if (!savedState || typeof savedState !== "object") {
      return {
        activeMediaUrl: savedRoom?.active_media_url || "",
        activeMediaTitle: savedRoom?.active_media_title || "",
        isPlaying: false,
        currentTime: 0,
        playbackRate: 1,
        updatedAt: Date.now(),
        controllerUserId: savedRoom?.host_user_id
      };
    }
    return projectedPlaybackState({
      activeMediaUrl: savedState.activeMediaUrl || savedRoom?.active_media_url || "",
      activeMediaTitle: savedState.activeMediaTitle || savedRoom?.active_media_title || "",
      isPlaying: Boolean(savedState.isPlaying),
      currentTime: Number(savedState.currentTime || 0),
      playbackRate: Number(savedState.playbackRate || 1),
      updatedAt: Number(savedState.updatedAt || Date.now()),
      controllerUserId: savedState.controllerUserId || savedRoom?.host_user_id
    });
  }

  async function loadSavedRoomSnapshot(roomId) {
    if (!supabase) return null;
    let { data: savedRoom, error: savedRoomError } = await supabase
      .from("rooms")
      .select("id,name,host_user_id,visibility,playback_mode,active_media_url,active_media_title,active_media_state")
      .eq("id", roomId)
      .maybeSingle();
    if (savedRoomError?.message?.includes("active_media_state") || savedRoomError?.message?.includes("visibility")) {
      const fallback = await supabase
        .from("rooms")
        .select("id,name,host_user_id,playback_mode,active_media_url,active_media_title")
        .eq("id", roomId)
        .maybeSingle();
      savedRoom = fallback.data;
    }
    if (!savedRoom) return null;
    return {
      roomId: savedRoom.id,
      roomName: savedRoom.name,
      hostUserId: savedRoom.host_user_id,
      visibility: savedRoom.visibility,
      playbackMode: savedRoom.playback_mode,
      playbackState: normalizeSavedPlaybackState(savedRoom)
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
      const messageKey = message?.id || `${message?.displayName || ""}:${message?.message || ""}:${message?.createdAt || ""}`;
      if (seenMessageIdsRef.current.has(messageKey)) return;
      seenMessageIdsRef.current.add(messageKey);
      if (seenMessageIdsRef.current.size > 250) {
        seenMessageIdsRef.current = new Set(Array.from(seenMessageIdsRef.current).slice(-160));
      }
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

    const resumeRoom = async () => {
      const currentRoom = roomRef.current;
      if (!currentRoom?.roomId) return;
      if (leavingRoomIdRef.current === currentRoom.roomId) return;
      const savedSnapshot = await loadSavedRoomSnapshot(currentRoom.roomId);
      const participant = currentRoom.participants?.find((item) => item.userId === user.id);
      socket.emit("room-resume", {
        room: savedSnapshot || {
          roomId: currentRoom.roomId,
          roomName: currentRoom.roomName,
          hostUserId: currentRoom.hostUserId,
          visibility: currentRoom.visibility,
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

  useEffect(() => {
    if (!user) return undefined;
    const sendHeartbeat = () => {
      socket.emit("havyn-heartbeat", {
        roomId: roomRef.current?.roomId,
        userId: user.id,
        sentAt: Date.now()
      });
    };
    sendHeartbeat();
    const timer = window.setInterval(sendHeartbeat, 25_000);
    return () => window.clearInterval(timer);
  }, [socket, user]);

  async function createRoom(name, options = {}) {
    if (!user) return null;
    leavingRoomIdRef.current = null;
    const roomId = crypto.randomUUID().slice(0, 8).toUpperCase();
    const roomName = name || "Friday Watch";
    const visibility = options.visibility === "public" || options.isPublic ? "public" : "private";
    socket.emit("room-create", {
      roomId,
      roomName,
      visibility,
      user: { userId: user.id, displayName: user.displayName }
    });
    seenMessageIdsRef.current.clear();

    if (supabase) {
      await supabase.from("profiles").upsert(
        { id: user.id, display_name: user.displayName },
        { onConflict: "id" }
      );
      const roomInsert = {
        id: roomId,
        name: roomName,
        host_user_id: user.id,
        playback_mode: "host-only",
        visibility,
        last_seen_at: new Date().toISOString()
      };
      const { error: insertError } = await supabase.from("rooms").insert(roomInsert);
      if (insertError?.message?.includes("visibility") || insertError?.message?.includes("last_seen_at")) {
        await supabase.from("rooms").insert({
          id: roomId,
          name: roomName,
          host_user_id: user.id,
          playback_mode: "host-only"
        });
      } else if (insertError) {
        throw insertError;
      }
      await supabase.from("room_members").insert({ room_id: roomId, user_id: user.id, role: "host" });
    }
    return roomId;
  }

  async function joinRoom(roomId) {
    if (!user) return;
    const normalizedRoomId = roomId.trim().toUpperCase();
    leavingRoomIdRef.current = null;
    let roomSnapshot = null;
    if (supabase) {
      roomSnapshot = await loadSavedRoomSnapshot(normalizedRoomId);
    }
    socket.emit("room-join", {
      roomId: normalizedRoomId,
      room: roomSnapshot,
      user: { userId: user.id, displayName: user.displayName }
    });
    seenMessageIdsRef.current.clear();
    if (supabase) {
      await supabase.from("profiles").upsert(
        { id: user.id, display_name: user.displayName },
        { onConflict: "id" }
      );
      await supabase.from("room_members").upsert(
        { room_id: normalizedRoomId, user_id: user.id, role: "viewer" },
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
    seenMessageIdsRef.current.clear();
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
    if (!["host-only", "host-and-cohosts", "everyone"].includes(playbackMode)) return;
    const participant = room.participants?.find((item) => item.userId === user.id);
    const canChangeMode = room.playbackMode === "everyone" ||
      participant?.role === "host" ||
      (room.playbackMode === "host-and-cohosts" && participant?.role === "cohost");
    if (!canChangeMode) {
      setPermissionNotice("Only room controllers can change playback mode.");
      window.setTimeout(() => setPermissionNotice(""), 2200);
      return;
    }
    setRoom((currentRoom) => {
      if (!currentRoom) return currentRoom;
      const nextRoom = { ...currentRoom, playbackMode };
      roomRef.current = nextRoom;
      return nextRoom;
    });
    if (supabase) {
      supabase
        .from("rooms")
        .update({ playback_mode: playbackMode, updated_at: new Date().toISOString() })
        .eq("id", room.roomId)
        .then(() => {});
    }
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
