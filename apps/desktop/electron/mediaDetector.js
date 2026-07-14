(() => {
  const describeVideo = (video, index) => ({
    id: video.dataset.havynMediaId || `video-${index}`,
    index,
    title:
      document.querySelector("meta[property='og:title']")?.content ||
      document.title ||
      video.getAttribute("title") ||
      "Detected video",
    currentTime: video.currentTime || 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    paused: video.paused,
    playbackRate: video.playbackRate || 1,
    ended: video.ended,
    readyState: video.readyState,
    width: video.videoWidth || video.clientWidth || 0,
    height: video.videoHeight || video.clientHeight || 0,
    frameUrl: window.location.href,
    pageUrl: window.location.href,
    url: window.location.href
  });

  const getVideos = () => Array.from(document.querySelectorAll("video"));
  const sendDetected = (media) => window.__havynMediaDetected = media;
  const sendEvent = (payload) => window.__havynLastMediaEvent = payload;
  let pendingPlayback = null;
  let remotePlaybackExpectation = null;

  const matchesRemotePlaybackEvent = (expectation, eventName, media, now = Date.now()) => {
    if (!expectation || now > Number(expectation.expiresAt || 0)) return false;
    if (eventName === "play" || eventName === "playing") return expectation.action === "play";
    if (eventName === "pause") return expectation.action === "pause" || expectation.action === "ended";
    if (eventName === "ended") return expectation.action === "ended";
    if (eventName === "seeking" || eventName === "seeked") {
      return expectation.currentTime !== null && Math.abs(Number(media.currentTime || 0) - expectation.currentTime) <= 1.75;
    }
    if (eventName === "ratechange") {
      return expectation.playbackRate !== null && Math.abs(Number(media.playbackRate || 1) - expectation.playbackRate) <= 0.01;
    }
    return false;
  };

  const visibleText = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  const clickElement = (node) => {
    node?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    node?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    node?.click?.();
  };

  const dismissResumePrompt = () => {
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], a, div, span"));
    const hasResumePrompt = candidates.some((node) => /^continue from\s+/i.test(visibleText(node)));
    if (!hasResumePrompt) return;
    const cancel = candidates.find((node) => /^cancel$/i.test(visibleText(node)));
    if (cancel) clickElement(cancel);
  };

  const report = () => {
    const media = getVideos().map((video, index) => {
      video.dataset.havynMediaId = video.dataset.havynMediaId || `video-${index}`;
      return describeVideo(video, index);
    });
    sendDetected(media);
    return media;
  };

  const attach = (video) => {
    if (video.dataset.havynListenersAttached) return;
    video.dataset.havynListenersAttached = "true";
    ["play", "pause", "seeking", "seeked", "timeupdate", "loadedmetadata", "canplay", "ended", "ratechange"].forEach((eventName) => {
      video.addEventListener(eventName, () => {
        const index = getVideos().indexOf(video);
        const media = describeVideo(video, index);
        sendEvent({
          eventName,
          media,
          controlledByHavyn: matchesRemotePlaybackEvent(remotePlaybackExpectation, eventName, media)
        });
        console.debug("__havyn_media_event__");
      });
    });
  };

  const scan = () => {
    dismissResumePrompt();
    getVideos().forEach(attach);
    return report();
  };

  window.__havynScanMedia = scan;
  window.__havynReadMediaEvent = () => {
    const event = window.__havynLastMediaEvent;
    window.__havynLastMediaEvent = null;
    return event || null;
  };

  window.__havynApplyPlayback = ({ action, currentTime, playbackRate }) => {
    const video = getVideos().find((item) => item.readyState > 0) || getVideos()[0];
    if (!video) {
      pendingPlayback = { action, currentTime, playbackRate };
      return false;
    }
    remotePlaybackExpectation = {
      action: String(action || "sync"),
      currentTime: Number.isFinite(Number(currentTime)) ? Number(currentTime) : null,
      playbackRate: Number.isFinite(Number(playbackRate)) ? Number(playbackRate) : null,
      expiresAt: Date.now() + 1400
    };
    if (action !== "play") pendingPlayback = null;
    if (typeof playbackRate === "number") video.playbackRate = playbackRate;
    if (typeof currentTime === "number" && Math.abs(video.currentTime - currentTime) > 0.35) {
      video.currentTime = Math.max(0, currentTime);
    }
    if (action === "play" && video.paused) {
      pendingPlayback = { action, currentTime, playbackRate };
      video.play().then(() => {
        pendingPlayback = null;
      }).catch(() => {});
    }
    if (action === "pause" && !video.paused) video.pause();
    return true;
  };

  if (!window.__havynMediaDetectorInstalled) {
    window.__havynMediaDetectorInstalled = true;
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setInterval(scan, 1000);
    setInterval(() => {
      if (pendingPlayback) window.__havynApplyPlayback(pendingPlayback);
    }, 1500);
  }

  scan();
})();
