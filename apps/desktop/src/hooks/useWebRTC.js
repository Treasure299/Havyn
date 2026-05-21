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
  const localStreamRef = useRef(null);
  const peersRef = useRef(new Map());

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

  async function joinCall() {
    setCallError("");
    const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
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

  return {
    joined,
    muted,
    cameraOff,
    callError,
    localStream: localPreviewStream,
    streams,
    joinCall,
    leaveCall,
    toggleMute,
    toggleCamera
  };
}
