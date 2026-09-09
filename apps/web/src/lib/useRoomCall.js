import { useCallback, useEffect, useRef, useState } from "react";
import { syncDebug } from "./roomConfig.js";
import { getManualIceConfig, recordRelayUsage } from "./turnConfig.js";

const fallbackIce = { iceServers: [{ urls: "stun:stun.expressturn.com:3478" }] };
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
  // Voice processing is the browser path most likely to alter audio levels or
  // routing when a call starts. Keep the room's provider audio foreground.
  const audio = isAppleBrowser()
    ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  return { audio, video: videoConstraints };
}

async function loadIceConfig(socket) {
  const manual = getManualIceConfig();
  if (manual) {
    syncDebug("call-ice-config", { relayConfigured: true, relayProvider: "custom" });
    return { iceServers: manual.iceServers };
  }
  try {
    const data = await socket?.loadIceConfig();
    if (!Array.isArray(data?.iceServers)) return fallbackIce;
    syncDebug("call-ice-config", { relayConfigured: data.relayConfigured === true, relayProvider: data.relayProvider || "none" });
    return { iceServers: data.iceServers };
  } catch (error) {
    syncDebug("call-ice-config-error", { message: error?.message || String(error) });
    return fallbackIce;
  }
}

export function useRoomCall({ room, socket, user, notify }) {
  const [joined, setJoined] = useState(false); const [muted, setMuted] = useState(false); const [cameraOff, setCameraOff] = useState(false);
  const [localStream, setLocalStream] = useState(null); const [remoteStreams, setRemoteStreams] = useState([]);
  const [connectionQuality, setConnectionQuality] = useState({});
  const peers = useRef(new Map()); const queuedIce = useRef(new Map()); const local = useRef(null); const joinedRef = useRef(false); const iceConfig = useRef(fallbackIce); const relayByteTotals = useRef(new Map());

  const closePeer = useCallback((userId) => { const entry = peers.current.get(userId); const peer = entry?.peer || entry; if (entry?.recoveryTimer) clearTimeout(entry.recoveryTimer); if (entry?.offerTimer) clearTimeout(entry.offerTimer); if (peer) peer.close(); peers.current.delete(userId); queuedIce.current.delete(userId); relayByteTotals.current.delete(userId); setRemoteStreams((streams) => streams.filter((stream) => stream.userId !== userId)); }, []);
  const createPeer = useCallback((userId) => {
    const existing = peers.current.get(userId); if (existing) return existing.peer || existing;
    const peer = new RTCPeerConnection(iceConfig.current); const meta = { peer, remoteStream: new MediaStream(), restarting: false, failedAfterRestart: false, offerPending: false, negotiated: false, recoveryTimer: null, offerTimer: null }; peers.current.set(userId, meta);
    local.current?.getTracks().forEach((track) => peer.addTrack(track, local.current));
    peer.onicecandidate = ({ candidate }) => { if (candidate) socket?.command("webrtc-ice-candidate", { toUserId: userId, candidate }); };
    peer.ontrack = ({ streams, track }) => {
      const incomingTracks = streams[0]?.getTracks() || [track];
      incomingTracks.forEach((incoming) => {
        if (!meta.remoteStream.getTracks().some((current) => current.id === incoming.id)) meta.remoteStream.addTrack(incoming);
        incoming.onended = () => {
          meta.remoteStream.removeTrack(incoming);
          if (!meta.remoteStream.getTracks().some((current) => current.readyState === "live")) setRemoteStreams((current) => current.filter((item) => item.userId !== userId));
        };
      });
      syncDebug("call-remote-track", { userId, kind: track.kind, muted: track.muted, streamless: !streams[0], trackKinds: meta.remoteStream.getTracks().map((item) => item.kind) });
      setRemoteStreams((current) => [...current.filter((item) => item.userId !== userId), { userId, stream: meta.remoteStream }]);
    };
    peer.onicecandidateerror = (event) => syncDebug("call-ice-candidate-error", { userId, code: event.errorCode, text: event.errorText, url: event.url });
    const restart = () => {
      if (peer.connectionState !== "failed" || meta.restarting) return;
      meta.restarting = true;
      meta.offerPending = true;
      peer.restartIce();
      void peer.createOffer({ iceRestart: true }).then(async (offer) => { await peer.setLocalDescription(offer); socket?.command("webrtc-offer", { toUserId: userId, offer: peer.localDescription }); }).catch(() => closePeer(userId));
    };
    peer.onconnectionstatechange = () => {
      syncDebug("call-peer-state", { userId, connectionState: peer.connectionState, iceConnectionState: peer.iceConnectionState });
      if (peer.connectionState === "connected") { clearTimeout(meta.recoveryTimer); clearTimeout(meta.offerTimer); meta.recoveryTimer = null; meta.offerTimer = null; meta.restarting = false; meta.failedAfterRestart = false; }
      if (peer.connectionState === "failed" && !meta.restarting) {
        if (String(user.userId) > String(userId)) restart();
        else if (!meta.recoveryTimer) meta.recoveryTimer = setTimeout(restart, 1800);
      } else if (peer.connectionState === "failed" && meta.restarting && !meta.failedAfterRestart) {
        meta.failedAfterRestart = true;
        notify("Direct and relay call paths failed. Try another relay under Account > Call relay, then rejoin.");
      }
      if (peer.connectionState === "closed") closePeer(userId);
    };
    return peer;
  }, [closePeer, notify, socket, user.userId]);
  const sendOffer = useCallback(async (userId) => {
    const peer = createPeer(userId);
    const meta = peers.current.get(userId);
    if (!peer || !meta || meta.offerPending || meta.negotiated || peer.signalingState !== "stable") return;
    meta.offerPending = true;
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket?.command("webrtc-offer", { toUserId: userId, offer: peer.localDescription });
      clearTimeout(meta.offerTimer);
      meta.offerTimer = setTimeout(() => {
        if (peer.connectionState === "connected" || peer.connectionState === "closed") return;
        meta.offerPending = false;
        meta.negotiated = false;
        syncDebug("call-offer-timeout", { userId, connectionState: peer.connectionState, signalingState: peer.signalingState });
        if (peer.signalingState === "have-local-offer") void peer.setLocalDescription({ type: "rollback" }).then(() => sendOffer(userId)).catch(() => closePeer(userId));
        else void sendOffer(userId);
      }, 5000);
    } catch (error) {
      meta.offerPending = false;
      syncDebug("call-offer-error", { userId, message: error?.message || String(error) });
    }
  }, [createPeer, socket]);
  const leave = useCallback(() => { socket?.command("call-leave"); peers.current.forEach((entry) => (entry.peer || entry).close()); peers.current.clear(); queuedIce.current.clear(); relayByteTotals.current.clear(); local.current?.getTracks().forEach((track) => track.stop()); local.current = null; configureAudioSession("playback"); joinedRef.current = false; setJoined(false); setMuted(false); setCameraOff(false); setLocalStream(null); setRemoteStreams([]); }, [socket]);
  const join = useCallback(async () => {
    if (joinedRef.current) return;
    // Explicitly establish a conference session before the microphone opens.
    // This tells supporting browsers that playback and recording coexist.
    configureAudioSession("play-and-record");
    let stream;
    try {
      const result = await Promise.all([navigator.mediaDevices.getUserMedia(callConstraints()), loadIceConfig(socket), socket?.waitUntilOpen()]);
      [stream] = result;
      const config = result[1];
      iceConfig.current = config;
      local.current = stream;
      syncDebug("call-local-tracks", { tracks: stream.getTracks().map((track) => ({ kind: track.kind, enabled: track.enabled, muted: track.muted, readyState: track.readyState, label: track.label })) });
      joinedRef.current = true;
      setLocalStream(stream);
      setJoined(true);
      setMuted(false);
      setCameraOff(false);
      if (!socket?.command("call-join", { muted: false, cameraOff: false })) throw new Error("The room connection is not ready.");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      local.current = null;
      joinedRef.current = false;
      setJoined(false);
      setLocalStream(null);
      configureAudioSession("playback");
      syncDebug("call-join-error", { message: error?.message || String(error) });
      notify(error?.name === "NotAllowedError" ? "Allow camera and microphone access to join the call." : "The call could not connect to the room. Try joining again.");
    }
  }, [notify, socket]);
  const toggleMute = useCallback(() => { const next = !muted; local.current?.getAudioTracks().forEach((track) => { track.enabled = !next; }); setMuted(next); socket?.command("call-status", { muted: next, cameraOff }); }, [cameraOff, muted, socket]);
  const toggleCamera = useCallback(() => { const next = !cameraOff; local.current?.getVideoTracks().forEach((track) => { track.enabled = !next; }); setCameraOff(next); socket?.command("call-status", { muted, cameraOff: next }); }, [cameraOff, muted, socket]);

  useEffect(() => {
    if (!socket) return undefined;
    const connectPeers = (participants) => { if (!joinedRef.current) return; (participants || []).forEach((participant) => { const userId = participant?.userId; if (!userId || userId === user.userId) return; createPeer(userId); if (String(user.userId) > String(userId)) void sendOffer(userId); }); };
    const acceptOffer = async ({ fromUserId, offer }) => { if (!joinedRef.current || !fromUserId || !offer) return; const peer = createPeer(fromUserId); const meta = peers.current.get(fromUserId); if (meta?.recoveryTimer) { clearTimeout(meta.recoveryTimer); meta.recoveryTimer = null; } if (peer.signalingState !== "stable") await peer.setLocalDescription({ type: "rollback" }).catch(() => {}); await peer.setRemoteDescription(offer); for (const candidate of queuedIce.current.get(fromUserId) || []) await peer.addIceCandidate(candidate).catch(() => {}); queuedIce.current.delete(fromUserId); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); if (meta) { meta.negotiated = true; meta.offerPending = false; } socket.command("webrtc-answer", { toUserId: fromUserId, answer: peer.localDescription }); };
    const acceptAnswer = async ({ fromUserId, answer }) => { const meta = peers.current.get(fromUserId); const peer = meta?.peer || meta; if (peer && answer) await peer.setRemoteDescription(answer).then(() => { if (meta?.peer) { meta.negotiated = true; meta.offerPending = false; } }).catch((error) => { if (meta?.peer) meta.offerPending = false; syncDebug("call-answer-error", { userId: fromUserId, message: error?.message || String(error) }); }); };
    const acceptIce = async ({ fromUserId, candidate }) => { if (!fromUserId || !candidate) return; const peer = peers.current.get(fromUserId)?.peer || peers.current.get(fromUserId); if (!peer?.remoteDescription) queuedIce.current.set(fromUserId, [...(queuedIce.current.get(fromUserId) || []), candidate]); else await peer.addIceCandidate(candidate).catch(() => {}); };
    const offOffer = socket.on("webrtc-offer", acceptOffer); const offAnswer = socket.on("webrtc-answer", acceptAnswer); const offIce = socket.on("webrtc-ice-candidate", acceptIce); const offLeave = socket.on("user-left-call", ({ userId }) => closePeer(userId)); const offFull = socket.on("call-full", ({ message }) => { notify(message || "This call is full."); leave(); }); const offCallUsers = socket.on("call-users", connectPeers); const offCallJoined = socket.on("call-user-joined", ({ user: participant }) => connectPeers([participant]));
    return () => { offOffer(); offAnswer(); offIce(); offLeave(); offFull(); offCallUsers(); offCallJoined(); };
  }, [closePeer, createPeer, leave, notify, sendOffer, socket, user.userId]);
  useEffect(() => {
    const self = room?.participants?.find((participant) => participant.userId === user.userId);
    if (!joinedRef.current && self?.callStatus === "connected") socket?.command("call-leave");
  }, [room?.participants, socket, user.userId]);
  useEffect(() => { if (!joined || !socket) return; const participants = (room?.participants || []).filter((participant) => participant.userId !== user.userId && participant.callStatus === "connected"); const ids = new Set(participants.map((participant) => participant.userId)); peers.current.forEach((_peer, userId) => { if (!ids.has(userId)) closePeer(userId); }); participants.forEach((participant) => { createPeer(participant.userId); if (String(user.userId) > String(participant.userId)) void sendOffer(participant.userId); }); }, [closePeer, createPeer, joined, room?.participants, sendOffer, socket, user.userId]);
  useEffect(() => {
    if (!joined) return undefined;
    const inspect = async () => {
      const next = { [user.userId]: "good" };
      await Promise.all(Array.from(peers.current.entries()).map(async ([userId, entry]) => {
        const peer = entry.peer || entry;
        try {
          const stats = await peer.getStats();
          let rtt = 0; let lost = 0; let received = 0; let relayBytes = 0; let selectedPair = null;
          stats.forEach((report) => {
            if (report.type === "candidate-pair" && (report.nominated || report.selected)) { selectedPair = report; if (Number.isFinite(report.currentRoundTripTime)) rtt = Math.max(rtt, report.currentRoundTripTime); }
            if (report.type === "inbound-rtp" && (report.kind === "audio" || report.kind === "video")) { lost += Number(report.packetsLost || 0); received += Number(report.packetsReceived || 0); relayBytes += Number(report.bytesReceived || 0); }
            if (report.type === "outbound-rtp" && (report.kind === "audio" || report.kind === "video")) relayBytes += Number(report.bytesSent || 0);
          });
          const localCandidate = selectedPair?.localCandidateId ? stats.get(selectedPair.localCandidateId) : null;
          const remoteCandidate = selectedPair?.remoteCandidateId ? stats.get(selectedPair.remoteCandidateId) : null;
          const relayActive = localCandidate?.candidateType === "relay" || remoteCandidate?.candidateType === "relay";
          const previousBytes = relayByteTotals.current.get(userId);
          if (relayActive && Number.isFinite(previousBytes)) recordRelayUsage(Math.max(0, relayBytes - previousBytes));
          relayByteTotals.current.set(userId, relayBytes);
          const loss = lost / Math.max(1, lost + received);
          next[userId] = peer.connectionState !== "connected" || !selectedPair ? "checking" : rtt > .65 || loss > .12 ? "poor" : rtt > .28 || loss > .045 ? "fair" : "good";
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
