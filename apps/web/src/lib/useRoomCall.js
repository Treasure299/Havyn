import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase.js";
import { ROOM_ENDPOINT } from "./roomConfig.js";

const fallbackIce = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const videoConstraints = { width: { ideal: 640, max: 960 }, height: { ideal: 360, max: 540 }, frameRate: { ideal: 15, max: 20 } };

function isAppleBrowser() {
  const userAgent = navigator.userAgent || "";
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return isIOS || /^((?!chrome|android).)*safari/i.test(userAgent);
}

function configureAudioSession(type) {
  try {
    if ("audioSession" in navigator) navigator.audioSession.type = type;
  } catch {
    // Audio Session is optional. Browsers without it keep their normal behavior.
  }
}

function callConstraints() {
  // Safari and iOS can duck video playback when their voice-processing input
  // starts. Prefer an unprocessed track there so the film remains foreground.
  const audio = isAppleBrowser()
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  return { audio, video: videoConstraints };
}

async function loadIceConfig(roomId) {
  const token = (await supabase?.auth.getSession())?.data?.session?.access_token;
  if (!token || !roomId) return fallbackIce;
  const response = await fetch(`${ROOM_ENDPOINT}/v2/rooms/${encodeURIComponent(roomId)}/ice`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) return fallbackIce;
  const data = await response.json();
  return Array.isArray(data.iceServers) ? { iceServers: data.iceServers } : fallbackIce;
}

export function useRoomCall({ room, socket, user, notify }) {
  const [joined, setJoined] = useState(false); const [muted, setMuted] = useState(false); const [cameraOff, setCameraOff] = useState(false);
  const [localStream, setLocalStream] = useState(null); const [remoteStreams, setRemoteStreams] = useState([]);
  const [connectionQuality, setConnectionQuality] = useState({});
  const peers = useRef(new Map()); const queuedIce = useRef(new Map()); const local = useRef(null); const joinedRef = useRef(false); const iceConfig = useRef(fallbackIce);

  const closePeer = useCallback((userId) => { const peer = peers.current.get(userId)?.peer || peers.current.get(userId); if (peer) peer.close(); peers.current.delete(userId); queuedIce.current.delete(userId); setRemoteStreams((streams) => streams.filter((stream) => stream.userId !== userId)); }, []);
  const createPeer = useCallback((userId) => {
    const existing = peers.current.get(userId); if (existing) return existing.peer || existing;
    const peer = new RTCPeerConnection(iceConfig.current); const meta = { peer, restarting: false }; peers.current.set(userId, meta);
    local.current?.getTracks().forEach((track) => peer.addTrack(track, local.current));
    peer.onicecandidate = ({ candidate }) => { if (candidate) socket?.command("webrtc-ice-candidate", { toUserId: userId, candidate }); };
    peer.ontrack = ({ streams, track }) => { const stream = streams[0] || new MediaStream([track]); track.onunmute = () => setRemoteStreams((current) => [...current.filter((item) => item.userId !== userId), { userId, stream }]); setRemoteStreams((current) => [...current.filter((item) => item.userId !== userId), { userId, stream }]); };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed" && !meta.restarting) { meta.restarting = true; peer.restartIce(); void peer.createOffer({ iceRestart: true }).then(async (offer) => { await peer.setLocalDescription(offer); socket?.command("webrtc-offer", { toUserId: userId, offer: peer.localDescription }); }).catch(() => closePeer(userId)); }
      if (peer.connectionState === "closed") closePeer(userId);
    };
    return peer;
  }, [closePeer, socket]);
  const sendOffer = useCallback(async (userId) => { const peer = createPeer(userId); if (!peer || peer.signalingState !== "stable") return; const offer = await peer.createOffer(); await peer.setLocalDescription(offer); socket?.command("webrtc-offer", { toUserId: userId, offer: peer.localDescription }); }, [createPeer, socket]);
  const leave = useCallback(() => { socket?.command("call-leave"); peers.current.forEach((entry) => (entry.peer || entry).close()); peers.current.clear(); queuedIce.current.clear(); local.current?.getTracks().forEach((track) => track.stop()); local.current = null; configureAudioSession("playback"); joinedRef.current = false; setJoined(false); setMuted(false); setCameraOff(false); setLocalStream(null); setRemoteStreams([]); }, [socket]);
  const join = useCallback(async () => { if (joinedRef.current) return; configureAudioSession("play-and-record"); try { const [stream, config] = await Promise.all([navigator.mediaDevices.getUserMedia(callConstraints()), loadIceConfig(room?.roomId)]); iceConfig.current = config; local.current = stream; joinedRef.current = true; setLocalStream(stream); setJoined(true); setMuted(false); setCameraOff(false); socket?.command("call-join", { muted: false, cameraOff: false }); } catch (error) { configureAudioSession("playback"); notify(error?.name === "NotAllowedError" ? "Allow camera and microphone access to join the call." : "The call could not start. Check your camera, microphone, and network."); } }, [notify, room?.roomId, socket]);
  const toggleMute = useCallback(() => { const next = !muted; local.current?.getAudioTracks().forEach((track) => { track.enabled = !next; }); setMuted(next); socket?.command("call-status", { muted: next, cameraOff }); }, [cameraOff, muted, socket]);
  const toggleCamera = useCallback(() => { const next = !cameraOff; local.current?.getVideoTracks().forEach((track) => { track.enabled = !next; }); setCameraOff(next); socket?.command("call-status", { muted, cameraOff: next }); }, [cameraOff, muted, socket]);

  useEffect(() => {
    if (!socket) return undefined;
    const connectPeers = (participants) => { if (!joinedRef.current) return; (participants || []).forEach((participant) => { const userId = participant?.userId; if (!userId || userId === user.userId) return; createPeer(userId); if (String(user.userId) > String(userId)) void sendOffer(userId); }); };
    const acceptOffer = async ({ fromUserId, offer }) => { if (!joinedRef.current || !fromUserId || !offer) return; const peer = createPeer(fromUserId); if (peer.signalingState !== "stable") await peer.setLocalDescription({ type: "rollback" }).catch(() => {}); await peer.setRemoteDescription(offer); for (const candidate of queuedIce.current.get(fromUserId) || []) await peer.addIceCandidate(candidate).catch(() => {}); queuedIce.current.delete(fromUserId); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); socket.command("webrtc-answer", { toUserId: fromUserId, answer: peer.localDescription }); };
    const acceptAnswer = async ({ fromUserId, answer }) => { const peer = peers.current.get(fromUserId)?.peer || peers.current.get(fromUserId); if (peer && answer) await peer.setRemoteDescription(answer).catch(() => {}); };
    const acceptIce = async ({ fromUserId, candidate }) => { if (!fromUserId || !candidate) return; const peer = peers.current.get(fromUserId)?.peer || peers.current.get(fromUserId); if (!peer?.remoteDescription) queuedIce.current.set(fromUserId, [...(queuedIce.current.get(fromUserId) || []), candidate]); else await peer.addIceCandidate(candidate).catch(() => {}); };
    const offOffer = socket.on("webrtc-offer", acceptOffer); const offAnswer = socket.on("webrtc-answer", acceptAnswer); const offIce = socket.on("webrtc-ice-candidate", acceptIce); const offLeave = socket.on("user-left-call", ({ userId }) => closePeer(userId)); const offFull = socket.on("call-full", ({ message }) => { notify(message || "This call is full."); leave(); }); const offCallUsers = socket.on("call-users", connectPeers); const offCallJoined = socket.on("call-user-joined", ({ user: participant }) => connectPeers([participant]));
    return () => { offOffer(); offAnswer(); offIce(); offLeave(); offFull(); offCallUsers(); offCallJoined(); };
  }, [closePeer, createPeer, leave, notify, sendOffer, socket, user.userId]);
  useEffect(() => { if (!joined || !socket) return; const participants = (room?.participants || []).filter((participant) => participant.userId !== user.userId && participant.callStatus === "connected"); const ids = new Set(participants.map((participant) => participant.userId)); peers.current.forEach((_peer, userId) => { if (!ids.has(userId)) closePeer(userId); }); participants.forEach((participant) => { createPeer(participant.userId); if (String(user.userId) > String(participant.userId)) void sendOffer(participant.userId); }); }, [closePeer, createPeer, joined, room?.participants, sendOffer, socket, user.userId]);
  useEffect(() => {
    if (!joined) return undefined;
    const inspect = async () => {
      const next = { [user.userId]: "good" };
      await Promise.all(Array.from(peers.current.entries()).map(async ([userId, entry]) => {
        const peer = entry.peer || entry;
        try {
          const stats = await peer.getStats();
          let rtt = 0; let lost = 0; let received = 0;
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && (report.nominated || report.selected) && Number.isFinite(report.currentRoundTripTime)) rtt = Math.max(rtt, report.currentRoundTripTime);
            if (report.type === "inbound-rtp" && (report.kind === "audio" || report.kind === "video")) { lost += Number(report.packetsLost || 0); received += Number(report.packetsReceived || 0); }
          });
          const loss = lost / Math.max(1, lost + received);
          next[userId] = rtt > .65 || loss > .12 ? "poor" : rtt > .28 || loss > .045 ? "fair" : "good";
        } catch { next[userId] = "checking"; }
      }));
      setConnectionQuality(next);
    };
    void inspect();
    const interval = setInterval(() => void inspect(), 3500);
    return () => clearInterval(interval);
  }, [joined, user.userId]);
  useEffect(() => () => { peers.current.forEach((entry) => (entry.peer || entry).close()); local.current?.getTracks().forEach((track) => track.stop()); configureAudioSession("playback"); }, []);
  return { joined, muted, cameraOff, localStream, remoteStreams, connectionQuality, join, leave, toggleMute, toggleCamera };
}
