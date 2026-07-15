import { useEffect, useMemo, useRef, useState } from "react";
import { domBrowserBridge } from "../lib/domBrowserBridge";
import { createPlaybackDelivery } from "../lib/playbackDelivery";

export function useMediaDetection({ socket, room, user, onMediaEvent }) {
  const [detectedMedia, setDetectedMedia] = useState([]);
  const [currentUrl, setCurrentUrl] = useState("");
  const browser = useMemo(() => window.havyn?.browser ? domBrowserBridge : null, []);
  const reportedMediaKey = useRef("");
  const recentMediaEvents = useRef(new Map());
  const playbackDelivery = useRef(null);

  useEffect(() => () => {
    playbackDelivery.current?.controller.dispose();
  }, []);

  function sortDetectedMedia(media = []) {
    return [...media].sort((a, b) => {
      const aFrameSource = a.url && a.pageUrl && a.url !== a.pageUrl ? 1 : 0;
      const bFrameSource = b.url && b.pageUrl && b.url !== b.pageUrl ? 1 : 0;
      if (aFrameSource !== bFrameSource) return bFrameSource - aFrameSource;
      const aHasSize = Number(a.width || 0) > 0 && Number(a.height || 0) > 0 ? 2 : 0;
      const bHasSize = Number(b.width || 0) > 0 && Number(b.height || 0) > 0 ? 2 : 0;
      const aReady = Number(a.readyState || 0) + (Number(a.duration || 0) > 0 ? 4 : 0) + aHasSize;
      const bReady = Number(b.readyState || 0) + (Number(b.duration || 0) > 0 ? 4 : 0) + bHasSize;
      return bReady - aReady;
    });
  }

  function reportDetectedMedia(media) {
    const sortedMedia = sortDetectedMedia(media || []);
    setDetectedMedia(sortedMedia);
    if (!room?.roomId || !sortedMedia?.length) return;
    const first = sortedMedia[0];
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
      const eventKey = event?.eventId || [
        event?.eventName,
        event?.media?.id,
        event?.media?.url,
        Math.round(Number(event?.media?.currentTime || 0) * 20),
        event?.media?.paused,
        event?.media?.playbackRate
      ].join("|");
      const now = Date.now();
      if (now - Number(recentMediaEvents.current.get(eventKey) || 0) < 500) return;
      recentMediaEvents.current.set(eventKey, now);
      if (recentMediaEvents.current.size > 120) {
        for (const [key, seenAt] of recentMediaEvents.current) {
          if (now - seenAt > 3000) recentMediaEvents.current.delete(key);
        }
      }
      if (event?.media) {
        setDetectedMedia((items) => sortDetectedMedia([
          event.media,
          ...items.filter((item) => `${item.id}|${item.url}` !== `${event.media.id}|${event.media.url}`)
        ]));
      }
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
    if (!browser || !state) return false;
    if (playbackDelivery.current?.browser !== browser) {
      playbackDelivery.current?.controller.dispose();
      playbackDelivery.current = {
        browser,
        controller: createPlaybackDelivery((command) => browser.applyPlayback(command))
      };
    }
    return playbackDelivery.current.controller.deliver(state);
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
    const shouldPlay = state.action ? state.action === "play" : Boolean(state.isPlaying);
    if (shouldPlay) await video.play().catch(() => {});
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
