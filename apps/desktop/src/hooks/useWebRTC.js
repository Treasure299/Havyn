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

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    cameraOffRef.current = cameraOff;
  }, [cameraOff]);

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
    peersRef.current.get(peerUserId)?.close();
    peersRef.current.delete(peerUserId);
    setStreams((items) => items.filter((item) => item.userId !== peerUserId));
  }, []);

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
      setStreams((items) => {
        const next = items.filter((item) => item.userId !== peerUserId);
        return [...next, { userId: peerUserId, stream }];
      });
    };

    peersRef.current.set(peerUserId, peer);
    return peer;
  }, [room?.roomId, socket, user.id]);

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
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    peersRef.current.forEach((peer) => peer.close());
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
        const peer = createPeer(peerUser.userId);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit("webrtc-offer", { roomId: room.roomId, fromUserId: user.id, toUserId: peerUser.userId, offer });
      }
    };

    const handleOffer = async ({ fromUserId, offer }) => {
      if (!joined) return;
      const peer = createPeer(fromUserId);
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

    socket.on("call-users", handleCallUsers);
    socket.on("webrtc-offer", handleOffer);
    socket.on("webrtc-answer", handleAnswer);
    socket.on("webrtc-ice-candidate", handleIce);
    socket.on("user-left-call", handleUserLeft);
    socket.on("call-full", handleCallFull);

    return () => {
      socket.off("call-users", handleCallUsers);
      socket.off("webrtc-offer", handleOffer);
      socket.off("webrtc-answer", handleAnswer);
      socket.off("webrtc-ice-candidate", handleIce);
      socket.off("user-left-call", handleUserLeft);
      socket.off("call-full", handleCallFull);
    };
  }, [closePeer, createPeer, joined, room?.roomId, socket, user.id]);

  useEffect(() => () => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    peersRef.current.forEach((peer) => peer.close());
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
