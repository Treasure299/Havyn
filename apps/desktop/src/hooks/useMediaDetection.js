import { useEffect, useMemo, useRef, useState } from "react";

export function useMediaDetection({ socket, room, user, onMediaEvent }) {
  const [detectedMedia, setDetectedMedia] = useState([]);
  const [currentUrl, setCurrentUrl] = useState("");
  const browser = useMemo(() => window.havyn?.browser, []);
  const reportedMediaKey = useRef("");

  function reportDetectedMedia(media) {
    setDetectedMedia(media || []);
    if (!room?.roomId || !media?.length) return;
    const first = media[0];
    const key = `${first.url || ""}|${first.id || first.index || 0}|${Math.round(first.duration || 0)}|${first.src || ""}`;
    if (reportedMediaKey.current === key) return;
    reportedMediaKey.current = key;
    socket.emit("media-detected", { roomId: room.roomId, userId: user.id, media: first });
  }

  function reportWebMedia(media) {
    reportDetectedMedia(media);
  }

  useEffect(() => {
    if (!browser) return undefined;
    const removeMedia = browser.onMediaDetected(reportDetectedMedia);
    const removeEvent = browser.onMediaEvent((event) => {
      if (event?.media) setDetectedMedia((items) => [event.media, ...items.filter((item) => item.id !== event.media.id)]);
      onMediaEvent?.(event);
    });
    const removeNav = browser.onNavigation(({ url }) => setCurrentUrl(url));
    return () => {
      removeMedia();
      removeEvent();
      removeNav();
    };
  }, [browser, room?.roomId, socket, user.id, onMediaEvent]);

  async function loadUrl(url) {
    const loaded = await browser?.loadUrl(url);
    setCurrentUrl(loaded || url);
  }

  async function applyPlayback(state) {
    return browser?.applyPlayback(state);
  }

  async function scanMedia() {
    return browser?.scanMedia?.();
  }

  async function applyWebPlayback(video, state) {
    if (!video || !state) return false;
    if (typeof state.playbackRate === "number") video.playbackRate = state.playbackRate;
    if (typeof state.currentTime === "number" && Math.abs(video.currentTime - state.currentTime) > 0.35) {
      video.currentTime = Math.max(0, state.currentTime);
    }
    if (state.isPlaying) await video.play().catch(() => {});
    else video.pause();
    return true;
  }

  return {
    browser,
    currentUrl,
    detectedMedia,
    loadUrl,
    scanMedia,
    applyPlayback,
    applyWebPlayback,
    reportWebMedia
  };
}
