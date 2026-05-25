import { useCallback, useEffect, useRef, useState } from "react";

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
    // Production should add TURN/coturn here for users behind stricter NATs.
  ]
};

const mediaConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  },
  video: {
    width: { ideal: 640, max: 960 },
    height: { ideal: 360, max: 540 },
    frameRate: { ideal: 15, max: 20 }
  }
};

function buildMediaConstraints(audioDeviceId, videoDeviceId) {
  return {
    audio: {
      ...mediaConstraints.audio,
      ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {})
    },
    video: {
      ...mediaConstraints.video,
      ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {})
    }
  };
}

async function tuneSender(sender, kind) {
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  if (kind === "video") {
    parameters.encodings[0].maxBitrate = 320_000;
    parameters.encodings[0].maxFramerate = 20;
    parameters.degradationPreference = "maintain-framerate";
  }
  if (kind === "audio") {
    parameters.encodings[0].maxBitrate = 40_000;
  }
  await sender.setParameters(parameters).catch(() => {});
}

export function useWebRTC({ socket, room, user }) {
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(true);
  const [cameraOff, setCameraOff] = useState(true);
  const [callError, setCallError] = useState("");
  const [streams, setStreams] = useState([]);
  const [localPreviewStream, setLocalPreviewStream] = useState(null);
  const [devices, setDevices] = useState({ audioInputs: [], videoInputs: [] });
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState("");
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState("");
  const localStreamRef = useRef(null);
  const peersRef = useRef(new Map());
  const mutedRef = useRef(muted);
  const cameraOffRef = useRef(cameraOff);
  const joinedRef = useRef(joined);
  const reconnectTimersRef = useRef(new Map());
  const createPeerRef = useRef(null);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    cameraOffRef.current = cameraOff;
  }, [cameraOff]);

  useEffect(() => {
    joinedRef.current = joined;
  }, [joined]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const items = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const audioInputs = items.filter((device) => device.kind === "audioinput");
    const videoInputs = items.filter((device) => device.kind === "videoinput");
    setDevices({ audioInputs, videoInputs });
    setSelectedAudioDeviceId((current) => current || audioInputs[0]?.deviceId || "");
    setSelectedVideoDeviceId((current) => current || videoInputs[0]?.deviceId || "");
  }, []);

  const closePeer = useCallback((peerUserId) => {
    const timer = reconnectTimersRef.current.get(peerUserId);
    if (timer) window.clearTimeout(timer);
    reconnectTimersRef.current.delete(peerUserId);
    const peer = peersRef.current.get(peerUserId);
    if (peer) {
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.close();
    }
    peersRef.current.delete(peerUserId);
    setStreams((items) => items.filter((item) => item.userId !== peerUserId));
  }, []);

  const sendOffer = useCallback(async (peerUserId) => {
    const peer = peersRef.current.get(peerUserId);
    if (!peer || peer.signalingState !== "stable") return;
    const offer = await peer.createOffer({ iceRestart: true });
    await peer.setLocalDescription(offer);
    socket.emit("webrtc-offer", { roomId: room.roomId, fromUserId: user.id, toUserId: peerUserId, offer });
  }, [room?.roomId, socket, user.id]);

  const schedulePeerRepair = useCallback((peerUserId) => {
    if (!joinedRef.current || reconnectTimersRef.current.has(peerUserId)) return;
    const timer = window.setTimeout(async () => {
      reconnectTimersRef.current.delete(peerUserId);
      if (!joinedRef.current || !localStreamRef.current) return;
      closePeer(peerUserId);
      createPeerRef.current?.(peerUserId);
      if (String(user.id) > String(peerUserId)) {
        await sendOffer(peerUserId);
      }
    }, 1200);
    reconnectTimersRef.current.set(peerUserId, timer);
  }, [closePeer, sendOffer, user.id]);

  const watchRemoteTrack = useCallback((peerUserId, track) => {
    const repair = () => schedulePeerRepair(peerUserId);
    track.onended = repair;
    track.onmute = () => {
      window.setTimeout(() => {
        if (track.muted || track.readyState !== "live") repair();
      }, 2500);
    };
    track.onunmute = () => {
      const timer = reconnectTimersRef.current.get(peerUserId);
      if (timer) window.clearTimeout(timer);
      reconnectTimersRef.current.delete(peerUserId);
    };
  }, [schedulePeerRepair]);

  const publishRemoteStream = useCallback((peerUserId, stream) => {
    stream.getTracks().forEach((track) => watchRemoteTrack(peerUserId, track));
    setStreams((items) => {
      const next = items.filter((item) => item.userId !== peerUserId);
      return [...next, { userId: peerUserId, stream }];
    });
  }, [watchRemoteTrack]);

  const createPeer = useCallback((peerUserId) => {
    if (peersRef.current.has(peerUserId)) return peersRef.current.get(peerUserId);
    const peer = new RTCPeerConnection(rtcConfig);
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      const sender = peer.addTrack(track, localStreamRef.current);
      tuneSender(sender, "audio");
    });
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      const sender = peer.addTrack(track, localStreamRef.current);
      tuneSender(sender, "video");
    });

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("webrtc-ice-candidate", {
          roomId: room.roomId,
          fromUserId: user.id,
          toUserId: peerUserId,
          candidate: event.candidate
        });
      }
    };

    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) publishRemoteStream(peerUserId, stream);
    };

    const handlePeerState = () => {
      if (["failed", "disconnected", "closed"].includes(peer.connectionState) || ["failed", "disconnected"].includes(peer.iceConnectionState)) {
        schedulePeerRepair(peerUserId);
      }
    };
    peer.onconnectionstatechange = handlePeerState;
    peer.oniceconnectionstatechange = handlePeerState;

    peersRef.current.set(peerUserId, peer);
    return peer;
  }, [publishRemoteStream, room?.roomId, schedulePeerRepair, socket, user.id]);

  createPeerRef.current = createPeer;

  async function replaceLocalTrack(kind, deviceId) {
    if (!joined || !localStreamRef.current) return;
    setCallError("");
    const constraints = kind === "audio"
      ? { audio: buildMediaConstraints(deviceId, selectedVideoDeviceId).audio, video: false }
      : { audio: false, video: buildMediaConstraints(selectedAudioDeviceId, deviceId).video };
    const stream = await navigator.mediaDevices.getUserMedia(constraints).catch((error) => {
      setCallError(error.message || "Could not switch device.");
      return null;
    });
    const nextTrack = stream?.getTracks()[0];
    if (!nextTrack) return;

    nextTrack.enabled = kind === "audio" ? !mutedRef.current : !cameraOffRef.current;
    const currentTracks = kind === "audio"
      ? localStreamRef.current.getAudioTracks()
      : localStreamRef.current.getVideoTracks();
    currentTracks.forEach((track) => {
      localStreamRef.current.removeTrack(track);
      track.stop();
    });
    localStreamRef.current.addTrack(nextTrack);
    peersRef.current.forEach((peer) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === kind);
      sender?.replaceTrack(nextTrack);
      if (sender) tuneSender(sender, kind);
    });
    setLocalPreviewStream(new MediaStream(localStreamRef.current.getTracks()));
    await refreshDevices();
  }

  async function joinCall() {
    setCallError("");
    let stream = await navigator.mediaDevices.getUserMedia(buildMediaConstraints(selectedAudioDeviceId, selectedVideoDeviceId)).catch(() => null);
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia(mediaConstraints).catch((error) => {
        setCallError(error.message || "Camera or microphone could not be opened.");
        return null;
      });
    }
    if (!stream) return;
    stream.getAudioTracks().forEach((track) => { track.enabled = true; });
    stream.getVideoTracks().forEach((track) => { track.enabled = true; });
    localStreamRef.current = stream;
    setLocalPreviewStream(stream);
    setMuted(false);
    setCameraOff(false);
    setJoined(true);
    socket.emit("call-join", {
      roomId: room.roomId,
      user: { userId: user.id, displayName: user.displayName },
      muted: false,
      cameraOff: false
    });
    await refreshDevices();
  }

  function leaveCall() {
    socket.emit("call-leave", { roomId: room.roomId, userId: user.id });
    reconnectTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    reconnectTimersRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    peersRef.current.forEach((peer) => {
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.close();
    });
    peersRef.current.clear();
    setStreams([]);
    setLocalPreviewStream(null);
    setJoined(false);
    setMuted(true);
    setCameraOff(true);
  }

  function toggleMute() {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setMuted(next);
    socket.emit("call-status", { roomId: room.roomId, userId: user.id, muted: next, cameraOff });
  }

  function toggleCamera() {
    const next = !cameraOff;
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = !next; });
    setCameraOff(next);
    socket.emit("call-status", { roomId: room.roomId, userId: user.id, muted, cameraOff: next });
  }

  async function selectAudioDevice(deviceId) {
    setSelectedAudioDeviceId(deviceId);
    await replaceLocalTrack("audio", deviceId);
  }

  async function selectVideoDevice(deviceId) {
    setSelectedVideoDeviceId(deviceId);
    await replaceLocalTrack("video", deviceId);
  }

  useEffect(() => {
    const handleCallUsers = async (users) => {
      for (const peerUser of users) {
        createPeer(peerUser.userId);
        await sendOffer(peerUser.userId);
      }
    };

    const handleOffer = async ({ fromUserId, offer }) => {
      if (!joined) return;
      const peer = createPeer(fromUserId);
      if (peer.signalingState !== "stable") {
        await peer.setLocalDescription({ type: "rollback" }).catch(() => {});
      }
      await peer.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit("webrtc-answer", { roomId: room.roomId, fromUserId: user.id, toUserId: fromUserId, answer });
    };

    const handleAnswer = async ({ fromUserId, answer }) => {
      const peer = peersRef.current.get(fromUserId);
      if (peer) await peer.setRemoteDescription(new RTCSessionDescription(answer));
    };

    const handleIce = async ({ fromUserId, candidate }) => {
      const peer = peersRef.current.get(fromUserId);
      if (peer && candidate) await peer.addIceCandidate(new RTCIceCandidate(candidate));
    };

    const handleUserLeft = ({ userId }) => closePeer(userId);
    const handleCallFull = ({ message }) => {
      setCallError(message);
      leaveCall();
    };
    const handleReconnect = () => {
      if (!joinedRef.current || !localStreamRef.current) return;
      socket.emit("call-join", {
        roomId: room.roomId,
        user: { userId: user.id, displayName: user.displayName },
        muted: mutedRef.current,
        cameraOff: cameraOffRef.current
      });
    };

    socket.on("call-users", handleCallUsers);
    socket.on("webrtc-offer", handleOffer);
    socket.on("webrtc-answer", handleAnswer);
    socket.on("webrtc-ice-candidate", handleIce);
    socket.on("user-left-call", handleUserLeft);
    socket.on("call-full", handleCallFull);
    socket.io.on("reconnect", handleReconnect);

    return () => {
      socket.off("call-users", handleCallUsers);
      socket.off("webrtc-offer", handleOffer);
      socket.off("webrtc-answer", handleAnswer);
      socket.off("webrtc-ice-candidate", handleIce);
      socket.off("user-left-call", handleUserLeft);
      socket.off("call-full", handleCallFull);
      socket.io.off("reconnect", handleReconnect);
    };
  }, [closePeer, createPeer, joined, room?.roomId, sendOffer, socket, user.displayName, user.id]);

  useEffect(() => () => {
    reconnectTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    peersRef.current.forEach((peer) => {
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.close();
    });
  }, []);

  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshDevices);
  }, [refreshDevices]);

  return {
    joined,
    muted,
    cameraOff,
    callError,
    devices,
    selectedAudioDeviceId,
    selectedVideoDeviceId,
    localStream: localPreviewStream,
    streams,
    joinCall,
    leaveCall,
    toggleMute,
    toggleCamera,
    selectAudioDevice,
    selectVideoDevice
  };
}
