import { useCallback, useEffect, useRef, useState } from "react";

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  // Production should add TURN/coturn when funding permits.
};

function diagnostic(event, details = {}) {
  window.havyn?.diagnostics?.log?.({ scope: "live-share", event, ...details });
}

async function tuneScreenSender(sender, maxBitrate = 2_000_000) {
  if (!sender?.track || sender.track.kind !== "video") return;
  const parameters = sender.getParameters();
  parameters.degradationPreference = "maintain-framerate";
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  parameters.encodings[0].maxBitrate = maxBitrate;
  parameters.encodings[0].maxFramerate = 30;
  await sender.setParameters(parameters).catch(() => {});
}

async function cropDisplayStream(sourceStream, cropRect, displayBounds) {
  const sourceVideo = document.createElement("video");
  sourceVideo.srcObject = sourceStream;
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  await sourceVideo.play();
  if (!sourceVideo.videoWidth || !sourceVideo.videoHeight) {
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Havyn could not read the shared display.")), 5_000);
      sourceVideo.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve();
      };
    });
  }

  const scaleX = sourceVideo.videoWidth / Math.max(1, Number(displayBounds?.width) || sourceVideo.videoWidth);
  const scaleY = sourceVideo.videoHeight / Math.max(1, Number(displayBounds?.height) || sourceVideo.videoHeight);
  const sourceX = Math.max(0, Math.round((Number(cropRect?.x) || 0) * scaleX));
  const sourceY = Math.max(0, Math.round((Number(cropRect?.y) || 0) * scaleY));
  const sourceWidth = Math.max(1, Math.min(sourceVideo.videoWidth - sourceX, Math.round((Number(cropRect?.width) || 1) * scaleX)));
  const sourceHeight = Math.max(1, Math.min(sourceVideo.videoHeight - sourceY, Math.round((Number(cropRect?.height) || 1) * scaleY)));
  const outputWidth = Math.min(1280, sourceWidth);
  const outputHeight = Math.max(1, Math.round(outputWidth * sourceHeight / sourceWidth));
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
  let stopped = false;

  const draw = () => {
    if (stopped || sourceVideo.readyState < 2) return;
    context.drawImage(sourceVideo, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
    if (sourceVideo.requestVideoFrameCallback) sourceVideo.requestVideoFrameCallback(draw);
  };
  if (sourceVideo.requestVideoFrameCallback) sourceVideo.requestVideoFrameCallback(draw);
  else {
    const interval = window.setInterval(draw, 1000 / 30);
    sourceVideo.__havynDrawInterval = interval;
  }

  const stream = canvas.captureStream(30);
  sourceStream.getAudioTracks().forEach((track) => stream.addTrack(track));
  const cleanup = () => {
    stopped = true;
    if (sourceVideo.__havynDrawInterval) window.clearInterval(sourceVideo.__havynDrawInterval);
    sourceVideo.pause();
    sourceVideo.srcObject = null;
    sourceStream.getTracks().forEach((track) => track.stop());
  };
  return { stream, cleanup, sourceVideoTrack: sourceStream.getVideoTracks()[0] };
}

export function useScreenShare({ socket, room, user, enabled }) {
  const peersRef = useRef(new Map());
  const localStreamRef = useRef(null);
  const remoteIceRef = useRef(new Map());
  const shareIdRef = useRef(null);
  const stoppingRef = useRef(false);
  const watchingRef = useRef(false);
  const statsTimerRef = useRef(null);
  const captureCleanupRef = useRef(null);
  const declinedShareIdRef = useRef(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [invitation, setInvitation] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [watching, setWatching] = useState(false);
  const [starting, setStarting] = useState(false);
  const [viewerMuted, setViewerMuted] = useState(false);
  const [viewerVolume, setViewerVolume] = useState(1);
  const [captureMode, setCaptureMode] = useState("source");

  const isHost = room?.hostUserId === user?.id;
  const liveShare = room?.liveShare;
  const isRoomLive = enabled && room?.roomExperience === "live-share" && Boolean(liveShare?.shareId);
  const isHosting = isRoomLive && liveShare?.hostUserId === user?.id && Boolean(localStream);

  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(""), 1800);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!error) return undefined;
    const timeout = window.setTimeout(() => setError(""), 2400);
    return () => window.clearTimeout(timeout);
  }, [error]);

  const closePeer = useCallback((peerUserId) => {
    const peer = peersRef.current.get(peerUserId);
    if (peer) {
      peer.ontrack = null;
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }
    peersRef.current.delete(peerUserId);
    remoteIceRef.current.delete(peerUserId);
  }, []);

  const closeAllPeers = useCallback(() => {
    Array.from(peersRef.current.keys()).forEach(closePeer);
    setRemoteStream(null);
  }, [closePeer]);

  const emitSignal = useCallback((event, toUserId, payload = {}) => {
    if (!shareIdRef.current || !toUserId) return;
    socket.emit(event, {
      roomId: room?.roomId,
      shareId: shareIdRef.current,
      fromUserId: user.id,
      toUserId,
      ...payload
    });
  }, [room?.roomId, socket, user.id]);

  const flushRemoteIce = useCallback(async (peerUserId, peer) => {
    const candidates = remoteIceRef.current.get(peerUserId) || [];
    remoteIceRef.current.delete(peerUserId);
    for (const candidate of candidates) {
      await peer.addIceCandidate(candidate).catch(() => {});
    }
  }, []);

  const addRemoteIce = useCallback(async (peerUserId, candidate) => {
    if (!candidate) return;
    const peer = peersRef.current.get(peerUserId);
    if (!peer?.remoteDescription) {
      const queue = remoteIceRef.current.get(peerUserId) || [];
      queue.push(candidate);
      remoteIceRef.current.set(peerUserId, queue.slice(-80));
      return;
    }
    await peer.addIceCandidate(candidate).catch(() => {});
  }, []);

  const createPeer = useCallback((peerUserId, role) => {
    closePeer(peerUserId);
    const peer = new RTCPeerConnection(rtcConfig);
    if (role === "host") {
      localStreamRef.current?.getTracks().forEach((track) => {
        const sender = peer.addTrack(track, localStreamRef.current);
        if (track.kind === "video") void tuneScreenSender(sender);
      });
    } else {
      peer.addTransceiver("video", { direction: "recvonly" });
      peer.addTransceiver("audio", { direction: "recvonly" });
    }
    peer.onicecandidate = ({ candidate }) => {
      if (candidate) emitSignal("screen-webrtc-ice-candidate", peerUserId, { candidate });
    };
    peer.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (!stream) return;
      diagnostic("remote-track", { shareId: shareIdRef.current, peerUserId, tracks: stream.getTracks().map((track) => ({ kind: track.kind, state: track.readyState })) });
      setRemoteStream(stream);
      setNotice("");
    };
    peer.onconnectionstatechange = () => {
      diagnostic("peer-state", { shareId: shareIdRef.current, peerUserId, state: peer.connectionState });
      if (["failed", "closed"].includes(peer.connectionState)) closePeer(peerUserId);
    };
    peersRef.current.set(peerUserId, peer);
    return peer;
  }, [closePeer, emitSignal]);

  const offerViewer = useCallback(async (viewerUserId) => {
    if (!localStreamRef.current || !shareIdRef.current) return;
    const peer = createPeer(viewerUserId, "host");
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    emitSignal("screen-webrtc-offer", viewerUserId, { description: peer.localDescription });
    diagnostic("offer-sent", { shareId: shareIdRef.current, viewerUserId });
  }, [createPeer, emitSignal]);

  const stopLocalCapture = useCallback(() => {
    captureCleanupRef.current?.();
    captureCleanupRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    localStreamRef.current = null;
    setLocalStream(null);
    setCaptureMode("source");
  }, []);

  const resetViewer = useCallback(() => {
    watchingRef.current = false;
    setWatching(false);
    setRemoteStream(null);
    setViewerMuted(false);
    setViewerVolume(1);
  }, []);

  const stopShare = useCallback(async () => {
    if (!isHost || !shareIdRef.current || stoppingRef.current) return;
    stoppingRef.current = true;
    const shareId = shareIdRef.current;
    stopLocalCapture();
    closeAllPeers();
    socket.emit("live-share-stop", { roomId: room?.roomId, shareId, userId: user.id });
    diagnostic("host-stop", { shareId });
    window.setTimeout(() => { stoppingRef.current = false; }, 300);
  }, [closeAllPeers, isHost, room?.roomId, socket, stopLocalCapture, user.id]);

  const startShare = useCallback(async ({ sourceId, withAudio, browserRect }) => {
    if (!enabled || !isHost || starting || isRoomLive) return false;
    setStarting(true);
    setError("");
    try {
      const armedResult = await window.havyn?.screenShare?.selectSource?.(sourceId, withAudio, browserRect);
      const armed = armedResult === true || Boolean(armedResult?.armed);
      if (!armed) throw new Error("The selected screen is no longer available.");
      const sourceStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: Boolean(withAudio)
      });
      let stream = sourceStream;
      let sourceVideoTrack = sourceStream.getVideoTracks()[0];
      if (["browser-region", "browser-window-region"].includes(armedResult?.captureMode)) {
        const cropped = await cropDisplayStream(sourceStream, armedResult.cropRect, armedResult.displayBounds);
        stream = cropped.stream;
        sourceVideoTrack = cropped.sourceVideoTrack;
        captureCleanupRef.current = cropped.cleanup;
      } else {
        captureCleanupRef.current = () => sourceStream.getTracks().forEach((track) => track.stop());
      }
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack || videoTrack.readyState !== "live") {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Havyn could not capture the selected screen.");
      }
      const audioTrack = stream.getAudioTracks().find((track) => track.readyState === "live");
      const shareId = crypto.randomUUID();
      shareIdRef.current = shareId;
      localStreamRef.current = stream;
      setLocalStream(stream);
      setCaptureMode(armedResult?.captureMode || "source");
      if (sourceVideoTrack) sourceVideoTrack.onended = () => { void stopShare(); };
      socket.emit("live-share-start", {
        roomId: room.roomId,
        shareId,
        hasAudio: Boolean(audioTrack)
      });
      setNotice(audioTrack ? "Live Share started with system audio" : "Live Share started without system audio");
      diagnostic("capture-started", { shareId, captureMode: armedResult?.captureMode || "source", hasAudio: Boolean(audioTrack), videoState: videoTrack.readyState });
      return true;
    } catch (captureError) {
      await window.havyn?.screenShare?.cancel?.().catch(() => {});
      setError(captureError?.message || "Screen sharing was cancelled.");
      diagnostic("capture-failed", {
        reason: captureError?.name || "capture-error",
        message: captureError?.message || "Screen capture failed",
        captureMode: armedResult?.captureMode || "unknown"
      });
      return false;
    } finally {
      setStarting(false);
    }
  }, [enabled, isHost, isRoomLive, room?.roomId, socket, starting, stopShare]);

  const acceptShare = useCallback(() => {
    const shareId = liveShare?.shareId;
    if (!shareId || isHost) return;
    shareIdRef.current = shareId;
    watchingRef.current = true;
    declinedShareIdRef.current = null;
    setWatching(true);
    setInvitation(null);
    setNotice("Connecting to Live Share...");
    socket.emit("live-share-accept", { roomId: room.roomId, shareId, userId: user.id });
    diagnostic("viewer-accepted", { shareId });
  }, [isHost, liveShare?.shareId, room?.roomId, socket, user.id]);

  const declineShare = useCallback(() => {
    const shareId = liveShare?.shareId;
    if (!shareId || isHost) return;
    declinedShareIdRef.current = shareId;
    setInvitation(null);
    socket.emit("live-share-decline", { roomId: room.roomId, shareId, userId: user.id });
    diagnostic("viewer-declined", { shareId });
  }, [isHost, liveShare?.shareId, room?.roomId, socket, user.id]);

  const leaveShare = useCallback(() => {
    const shareId = shareIdRef.current || liveShare?.shareId;
    closeAllPeers();
    resetViewer();
    if (shareId) socket.emit("live-share-viewer-left", { roomId: room?.roomId, shareId, userId: user.id });
    diagnostic("viewer-left", { shareId });
  }, [closeAllPeers, liveShare?.shareId, resetViewer, room?.roomId, socket, user.id]);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleAvailable = (payload) => {
      if (!payload?.shareId) return;
      shareIdRef.current = payload.shareId;
      if (
        payload.hostUserId !== user.id
        && !watchingRef.current
        && declinedShareIdRef.current !== payload.shareId
      ) setInvitation(payload);
    };
    const handleAccept = ({ shareId, viewerUserId }) => {
      if (shareId !== shareIdRef.current || !localStreamRef.current) return;
      void offerViewer(viewerUserId);
    };
    const handleOffer = async ({ shareId, fromUserId, description }) => {
      if (!watchingRef.current || shareId !== shareIdRef.current) return;
      const peer = createPeer(fromUserId, "viewer");
      await peer.setRemoteDescription(description);
      await flushRemoteIce(fromUserId, peer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      emitSignal("screen-webrtc-answer", fromUserId, { description: peer.localDescription });
      diagnostic("answer-sent", { shareId, hostUserId: fromUserId });
    };
    const handleAnswer = async ({ shareId, fromUserId, description }) => {
      if (shareId !== shareIdRef.current) return;
      const peer = peersRef.current.get(fromUserId);
      if (!peer) return;
      await peer.setRemoteDescription(description);
      await flushRemoteIce(fromUserId, peer);
    };
    const handleIce = ({ shareId, fromUserId, candidate }) => {
      if (shareId === shareIdRef.current) void addRemoteIce(fromUserId, candidate);
    };
    const handleIceBatch = ({ shareId, fromUserId, candidates }) => {
      if (shareId !== shareIdRef.current || !Array.isArray(candidates)) return;
      candidates.forEach((candidate) => void addRemoteIce(fromUserId, candidate));
    };
    const handleViewerLeft = ({ viewerUserId }) => closePeer(viewerUserId);
    const handleEnded = ({ playbackState }) => {
      closeAllPeers();
      stopLocalCapture();
      resetViewer();
      shareIdRef.current = null;
      declinedShareIdRef.current = null;
      setInvitation(null);
      setNotice("Live Share ended");
      diagnostic("share-ended", { restoredPlaying: Boolean(playbackState?.isPlaying) });
    };
    const handleError = ({ reason }) => {
      setError(reason || "Live Share could not continue.");
      if (localStreamRef.current) stopLocalCapture();
      closeAllPeers();
      if (!isHost) resetViewer();
      shareIdRef.current = null;
      declinedShareIdRef.current = null;
    };
    const handleReconnect = () => {
      if (watchingRef.current && shareIdRef.current && !isHost) {
        closeAllPeers();
        socket.emit("live-share-accept", { roomId: room?.roomId, shareId: shareIdRef.current, userId: user.id });
      }
    };

    socket.on("live-share-available", handleAvailable);
    socket.on("live-share-accept", handleAccept);
    socket.on("live-share-viewer-left", handleViewerLeft);
    socket.on("live-share-ended", handleEnded);
    socket.on("live-share-error", handleError);
    socket.on("screen-webrtc-offer", handleOffer);
    socket.on("screen-webrtc-answer", handleAnswer);
    socket.on("screen-webrtc-ice-candidate", handleIce);
    socket.on("screen-webrtc-ice-candidates", handleIceBatch);
    socket.io.on("reconnect", handleReconnect);
    return () => {
      socket.off("live-share-available", handleAvailable);
      socket.off("live-share-accept", handleAccept);
      socket.off("live-share-viewer-left", handleViewerLeft);
      socket.off("live-share-ended", handleEnded);
      socket.off("live-share-error", handleError);
      socket.off("screen-webrtc-offer", handleOffer);
      socket.off("screen-webrtc-answer", handleAnswer);
      socket.off("screen-webrtc-ice-candidate", handleIce);
      socket.off("screen-webrtc-ice-candidates", handleIceBatch);
      socket.io.off("reconnect", handleReconnect);
    };
  }, [addRemoteIce, closeAllPeers, closePeer, createPeer, emitSignal, enabled, flushRemoteIce, isHost, offerViewer, resetViewer, room?.roomId, socket, stopLocalCapture, user.id]);

  useEffect(() => {
    if (!enabled || !isRoomLive) {
      declinedShareIdRef.current = null;
      return;
    }
    shareIdRef.current = liveShare.shareId;
    if (
      !isHost
      && !watchingRef.current
      && !invitation
      && declinedShareIdRef.current !== liveShare.shareId
    ) {
      const host = room.participants?.find((participant) => participant.userId === liveShare.hostUserId);
      setInvitation({ ...liveShare, hostDisplayName: host?.displayName || "The host" });
    }
  }, [enabled, invitation, isHost, isRoomLive, liveShare, room?.participants]);

  useEffect(() => {
    if (!isHosting) return undefined;
    statsTimerRef.current = window.setInterval(async () => {
      for (const peer of peersRef.current.values()) {
        const sender = peer.getSenders().find((item) => item.track?.kind === "video");
        if (!sender) continue;
        const stats = await peer.getStats().catch(() => null);
        let constrained = false;
        stats?.forEach((report) => {
          if (report.type === "remote-inbound-rtp" && report.kind === "video") {
            constrained ||= Number(report.fractionLost || 0) > 0.08 || Number(report.roundTripTime || 0) > 0.4;
          }
        });
        await tuneScreenSender(sender, constrained ? 1_000_000 : 2_000_000);
      }
    }, 5_000);
    return () => window.clearInterval(statsTimerRef.current);
  }, [isHosting]);

  useEffect(() => () => {
    if (statsTimerRef.current) window.clearInterval(statsTimerRef.current);
    closeAllPeers();
    stopLocalCapture();
    void window.havyn?.screenShare?.cancel?.().catch(() => {});
  }, [closeAllPeers, stopLocalCapture]);

  return {
    enabled,
    isHost,
    isRoomLive,
    isHosting,
    starting,
    watching,
    invitation,
    available: isRoomLive && !isHost && !watching,
    localStream,
    remoteStream,
    notice,
    error,
    viewerMuted,
    viewerVolume,
    captureMode,
    startShare,
    stopShare,
    acceptShare,
    declineShare,
    leaveShare,
    setViewerMuted,
    setViewerVolume,
    clearError: () => setError("")
  };
}
