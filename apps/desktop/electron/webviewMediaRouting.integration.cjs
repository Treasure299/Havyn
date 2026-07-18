const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow, ipcMain, webContents } = require("electron");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function waitFor(check, timeoutMs = 10_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {}
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error("Timed out waiting for embedded media event"));
      setTimeout(poll, 50);
    };
    poll();
  });
}

const childServer = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body style="margin:0;background:#000">
    <div id="player" style="position:relative;width:640px;height:360px">
      <video id="media" muted playsinline style="width:640px;height:360px"></video>
      <a id="surface" role="button" href="https://popup.invalid/ad" target="_blank" onclick="event.preventDefault()" style="position:absolute;inset:0"></a>
      <button id="sitePlay" aria-label="Play" style="position:absolute;left:16px;top:16px;z-index:2">Play</button>
    </div>
    <script>
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d');
      context.fillStyle = '#e21b2d'; context.fillRect(0, 0, 320, 180);
      const media = document.querySelector('#media');
      media.srcObject = canvas.captureStream(5);
      window.siteSurfaceClickCount = 0;
      window.siteControlClickCount = 0;
      document.querySelector('#surface').addEventListener('click', () => {
        window.siteSurfaceClickCount += 1;
        if (media.paused) media.play();
        else media.pause();
      });
      document.querySelector('#sitePlay').addEventListener('click', () => {
        window.siteControlClickCount += 1;
        if (media.paused) media.play();
        else media.pause();
      });
      document.addEventListener('keydown', (event) => {
        if (event.code !== 'Space') return;
        if (media.paused) media.play();
        else media.pause();
      });
    </script>
  </body></html>`);
});

let parentServer;
let window;
let captureWindow;

(async () => {
  process.env.HAVYN_SKIP_APP_BOOTSTRAP = "1";
  const {
    FRAME_DETECTOR_SCRIPT,
    enterWebviewTheatre,
    exitWebviewTheatre,
    scanWebviewMedia,
    setMainWindowForIntegrationTest
  } = await import("./main.js");
  const childPort = await listen(childServer);
  parentServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body style="margin:24px">
      <main id="page-shell" style="position:relative;width:920px;height:520px;overflow:hidden;transform:translateZ(0);contain:paint">
        <section id="player-shell" style="position:relative;width:760px;height:460px;overflow:hidden;transform:scale(1)">
          <iframe src="http://127.0.0.1:${childPort}/player" allow="fullscreen" style="width:700px;height:420px"></iframe>
        </section>
      </main>
    </body></html>`);
  });
  const parentPort = await listen(parentServer);
  const parentUrl = `http://127.0.0.1:${parentPort}/host`;

  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      disableHtmlFullscreenWindowResize: true
    }
  });
  await window.loadURL("data:text/html,<html><body></body></html>");

  ipcMain.on("browser:media-event-from-page", (event, payload) => {
    window.webContents.executeJavaScript(
      `window.__mediaEvents.push(${JSON.stringify({ ...payload, sourceFrameUrl: payload.media?.frameUrl || event.senderFrame?.url || "" })})`,
      true
    ).catch(() => {});
  });

  const preloadUrl = pathToFileURL(path.join(__dirname, "browserPreload.js")).href;
  await window.webContents.executeJavaScript(`
    window.__mediaEvents = [];
    const view = document.createElement('webview');
    view.id = 'guest';
    view.src = ${JSON.stringify(parentUrl)};
    view.preload = ${JSON.stringify(preloadUrl)};
    view.style.width = '760px';
    view.style.height = '480px';
    view.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,nodeIntegrationInSubFrames=yes,sandbox=no,disableHtmlFullscreenWindowResize=yes');
    document.body.appendChild(view);
    true;
  `);

  const guest = await waitFor(() => webContents.getAllWebContents().find((item) => (
    item.id !== window.webContents.id && item.getURL() === parentUrl
  )));
  const childFrame = await waitFor(() => guest.mainFrame.frames.find((frame) => frame.url.includes(`:${childPort}/player`)));
  await waitFor(() => childFrame.executeJavaScript("Boolean(document.querySelector('video')?.srcObject)", true));

  captureWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  await captureWindow.loadURL(parentUrl);
  captureWindow.webContents.session.setPermissionCheckHandler((requestingWebContents, permission) => (
    requestingWebContents?.id === captureWindow.webContents.id && ["display-capture", "media"].includes(permission)
  ));
  captureWindow.webContents.session.setPermissionRequestHandler((requestingWebContents, permission, callback) => {
    callback(requestingWebContents?.id === captureWindow.webContents.id && ["display-capture", "media"].includes(permission));
  });
  captureWindow.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ video: guest.mainFrame });
  });
  const embeddedCapture = await captureWindow.webContents.executeJavaScript(`
    (async () => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = stream.getVideoTracks()[0];
      const result = { kind: track?.kind, readyState: track?.readyState };
      stream.getTracks().forEach((item) => item.stop());
      return result;
    })()
  `, true);
  assert.deepEqual(embeddedCapture, { kind: "video", readyState: "live" }, "The embedded browser frame must be directly capturable");
  captureWindow.destroy();
  captureWindow = null;

  guest.session.setPermissionCheckHandler((_contents, permission) => permission === "fullscreen");
  guest.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "fullscreen"));

  guest.on("console-message", async (details) => {
    const message = details?.message || "";
    if (!message.startsWith("__HAVYN_FRAME_MEDIA_EVENT__") || !details?.frame) return;
    const payload = JSON.parse(message.slice("__HAVYN_FRAME_MEDIA_EVENT__".length));
    await window.webContents.executeJavaScript(
      `window.__mediaEvents.push(${JSON.stringify({ ...payload, sourceFrameUrl: payload.media?.frameUrl || details.frame.url || "" })})`,
      true
    ).catch(() => {});
  });
  await childFrame.executeJavaScript(FRAME_DETECTOR_SCRIPT, true);

  const clickSurface = async () => {
    await childFrame.executeJavaScript(`
      (() => {
        const surface = document.querySelector('#surface');
        const rect = surface.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        surface.dispatchEvent(new PointerEvent('pointerdown', init));
        surface.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
        return true;
      })();
    `, true);
  };

  await clickSurface();
  assert.equal(
    await childFrame.executeJavaScript("window.siteSurfaceClickCount", true),
    1,
    "A physical guest click must reach the popup-wrapped player surface"
  );
  const playEvent = await waitFor(async () => {
    const events = await window.webContents.executeJavaScript("window.__mediaEvents", true);
    return events.find((event) => event.eventName === "play");
  });
  assert.equal(playEvent.media.frameUrl, `http://127.0.0.1:${childPort}/player`);
  const normalizedMedia = await scanWebviewMedia(guest.id);
  assert.equal(normalizedMedia[0]?.pageUrl, parentUrl, "Detected child media must retain the exact shared parent page URL");
  assert.equal(normalizedMedia[0]?.frameUrl, `http://127.0.0.1:${childPort}/player`);
  assert.equal(playEvent.sourceFrameUrl, `http://127.0.0.1:${childPort}/player`);
  assert.equal(playEvent.controlledByHavyn, false);
  assert.equal(await childFrame.executeJavaScript("window.siteSurfaceClickCount", true), 1);

  const windowBoundsBeforeNativeFullscreen = window.getBounds();
  let nativeFullscreenEntered = false;
  guest.once("enter-html-full-screen", () => { nativeFullscreenEntered = true; });
  const nativeFullscreenResult = await childFrame.executeJavaScript(
    "document.querySelector('#player').requestFullscreen().then(() => true)",
    true
  );
  assert.equal(nativeFullscreenResult, true, "A child player should be allowed to request native HTML fullscreen");
  await waitFor(() => nativeFullscreenEntered);
  assert.equal(
    await childFrame.executeJavaScript("document.fullscreenElement?.id", true),
    "player",
    "Native HTML fullscreen should retain the embedded player"
  );
  assert.deepEqual(
    window.getBounds(),
    windowBoundsBeforeNativeFullscreen,
    "HTML fullscreen must stay inside Havyn instead of resizing the desktop window"
  );
  await childFrame.executeJavaScript("document.exitFullscreen()", true);
  await waitFor(() => childFrame.executeJavaScript("!document.fullscreenElement", true));

  await clickSurface();
  const events = await waitFor(async () => {
    const current = await window.webContents.executeJavaScript("window.__mediaEvents", true);
    return current.some((event) => event.eventName === "pause") ? current : null;
  });
  assert.equal(events.filter((event) => event.eventName === "play").length, 1);
  assert.equal(events.filter((event) => event.eventName === "pause").length, 1);
  assert.equal(await childFrame.executeJavaScript("window.siteSurfaceClickCount", true), 2);

  await window.webContents.executeJavaScript("window.__mediaEvents = []", true);
  await childFrame.executeJavaScript(`
    (() => {
      const control = document.querySelector('#sitePlay');
      const rect = control.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      control.dispatchEvent(new PointerEvent('pointerdown', init));
      control.dispatchEvent(new MouseEvent('click', { ...init, detail: 1 }));
      return true;
    })();
  `, true);
  const nativeControlPlay = await waitFor(async () => {
    const current = await window.webContents.executeJavaScript("window.__mediaEvents", true);
    return current.find((event) => event.eventName === "play");
  });
  assert.equal(nativeControlPlay.controlledByHavyn, false);
  assert.equal(await childFrame.executeJavaScript("window.siteControlClickCount", true), 1);
  await childFrame.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, code: 'Space', key: ' ' }))", true);
  await waitFor(() => childFrame.executeJavaScript("document.querySelector('video').paused", true));

  await window.webContents.executeJavaScript("window.__mediaEvents = []", true);
  await window.webContents.executeJavaScript("window.__mediaEvents = []", true);
  const remoteApplied = await childFrame.executeJavaScript(
    "window.__havynApplyPlayback({ action: 'play', currentTime: 0, playbackRate: 1 })",
    true
  );
  assert.equal(remoteApplied, true);
  const remotePlay = await waitFor(async () => {
    const current = await window.webContents.executeJavaScript("window.__mediaEvents", true);
    return current.find((event) => event.eventName === "play");
  });
  assert.equal(remotePlay.controlledByHavyn, true);
  assert.equal(await childFrame.executeJavaScript("document.querySelector('video').paused", true), false);

  // Reproduce the guest path: a remote command starts playback, then the guest
  // clicks the custom player surface. The local pause must be emitted once and
  // must not be mistaken for the preceding remote action.
  await window.webContents.executeJavaScript("window.__mediaEvents = []", true);
  await clickSurface();
  const guestPause = await waitFor(async () => {
    const current = await window.webContents.executeJavaScript("window.__mediaEvents", true);
    return current.find((event) => event.eventName === "pause");
  });
  assert.equal(guestPause.controlledByHavyn, false);
  assert.equal(await childFrame.executeJavaScript("document.querySelector('video').paused", true), true);
  assert.equal(await childFrame.executeJavaScript("window.siteSurfaceClickCount", true), 3);

  // A blocked play may schedule retries. A newer pause command must cancel
  // those retries so an old play cannot restart the room several seconds later.
  await childFrame.executeJavaScript(`
    (() => {
      const media = document.querySelector('video');
      window.__nativeMediaPlay = media.play.bind(media);
      media.play = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
    })();
  `, true);
  const blockedPlay = await childFrame.executeJavaScript(
    "window.__havynApplyPlayback({ action: 'play', currentTime: 0, playbackRate: 1 })",
    true
  );
  assert.equal(blockedPlay, false);
  await childFrame.executeJavaScript(
    "window.__havynApplyPlayback({ action: 'pause', currentTime: 0, playbackRate: 1 })",
    true
  );
  await childFrame.executeJavaScript(`
    (() => {
      const media = document.querySelector('video');
      media.play = window.__nativeMediaPlay;
    })();
  `, true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await childFrame.executeJavaScript("document.querySelector('video').paused", true), true);

  // Ordinary HTML5 sites must remain stable across repeated room commands and
  // must not inherit a stale retry or protected-player state.
  const repeatedPlayback = await childFrame.executeJavaScript(`
    (async () => {
      const media = document.querySelector('video');
      for (let index = 0; index < 10; index += 1) {
        if (!await window.__havynApplyPlayback({ action: 'play', currentTime: 0, playbackRate: 1 })) return false;
        if (media.paused) return false;
        if (!await window.__havynApplyPlayback({ action: 'pause', currentTime: 0, playbackRate: 1 })) return false;
        if (!media.paused) return false;
      }
      return true;
    })()
  `, true);
  assert.equal(repeatedPlayback, true);

  const originalPlayerStyle = await childFrame.executeJavaScript("document.querySelector('#player').getAttribute('style')", true);
  const originalFrameStyle = await guest.mainFrame.executeJavaScript("document.querySelector('iframe').getAttribute('style')", true);
  const originalBodyStyle = await guest.mainFrame.executeJavaScript("document.body.getAttribute('style')", true);
  const theatreResult = await enterWebviewTheatre(guest.id, normalizedMedia[0]);
  assert.equal(theatreResult.ok, true, "The selected child-frame player should enter Theatre mode");
  assert.equal(await childFrame.executeJavaScript("getComputedStyle(document.querySelector('#player')).position", true), "fixed");
  assert.notEqual(await guest.mainFrame.executeJavaScript("getComputedStyle(document.body).transform", true), "none");
  const expandedFrameRect = await guest.mainFrame.executeJavaScript(`
    (() => {
      const rect = document.querySelector('iframe').getBoundingClientRect();
      return { width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    })()
  `, true);
  assert.ok(expandedFrameRect.width >= expandedFrameRect.viewportWidth * 0.95, "Theatre frame must fill the transformed host page width");
  assert.ok(expandedFrameRect.height >= expandedFrameRect.viewportHeight * 0.95, "Theatre frame must fill the transformed host page height");
  await childFrame.executeJavaScript("document.querySelector('#player').style.setProperty('position', 'absolute', 'important')", true);
  await guest.mainFrame.executeJavaScript("document.body.style.setProperty('transform', 'none', 'important')", true);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(
    await childFrame.executeJavaScript("getComputedStyle(document.querySelector('#player')).position", true),
    "fixed",
    "Theatre mode should survive player scripts that overwrite the expanded layout"
  );
  assert.equal(
    await guest.mainFrame.executeJavaScript("getComputedStyle(document.body).transform === 'none'", true),
    false,
    "Theatre mode should keep the selected player viewport focused"
  );
  await guest.mainFrame.executeJavaScript(`
    (() => {
      const current = document.querySelector('iframe');
      const replacement = document.createElement('iframe');
      replacement.src = current.src;
      replacement.setAttribute('style', ${JSON.stringify(originalFrameStyle)});
      current.replaceWith(replacement);
      return true;
    })();
  `, true);
  const replacementChildFrame = await waitFor(() => (
    guest.mainFrame.frames.find((frame) => !frame.detached && frame.url.includes(`:${childPort}/player`))
  ));
  await waitFor(() => replacementChildFrame.executeJavaScript("Boolean(document.querySelector('video')?.srcObject)", true));
  await waitFor(async () => (
    await guest.mainFrame.executeJavaScript("getComputedStyle(document.body).transform !== 'none'", true)
    && await replacementChildFrame.executeJavaScript("getComputedStyle(document.querySelector('#player')).position", true) === "fixed"
  ));
  await exitWebviewTheatre(guest.id);
  assert.equal(await replacementChildFrame.executeJavaScript("document.querySelector('#player').getAttribute('style')", true), originalPlayerStyle);
  assert.equal(await guest.mainFrame.executeJavaScript("document.querySelector('iframe').getAttribute('style')", true), originalFrameStyle);
  assert.equal(await guest.mainFrame.executeJavaScript("document.body.getAttribute('style')", true), originalBodyStyle);

  setMainWindowForIntegrationTest(window);
  const overlayResult = await enterWebviewTheatre(guest.id, {
    ...normalizedMedia[0],
    browserBounds: { x: 12, y: 18, width: 760, height: 480 }
  });
  assert.equal(overlayResult.ok, true, "The real webview path should create a player-only Theatre overlay");
  assert.equal(overlayResult.overlay, true, "Cross-origin players must use the compositor-safe overlay path");
  const overlayContents = webContents.fromId(overlayResult.overlayWebContentsId);
  assert.ok(overlayContents && !overlayContents.isDestroyed(), "The Theatre overlay must remain attached while sharing");
  assert.equal(overlayContents.getURL(), normalizedMedia[0].frameUrl, "The overlay should load only the detected player URL");
  assert.equal(guest.isAudioMuted(), true, "The source page must be muted while the player-only overlay owns audio");
  const overlayMedia = await waitFor(async () => {
    const detected = await scanWebviewMedia(overlayContents.id);
    return detected.length ? detected : null;
  });
  assert.ok(overlayMedia.length > 0, "The player-only overlay must retain media detection");
  await exitWebviewTheatre(guest.id);
  assert.equal(Boolean(webContents.fromId(overlayResult.overlayWebContentsId)), false, "The overlay should be destroyed on Theatre exit");
  assert.equal(guest.isAudioMuted(), false, "The source page audio state must be restored on Theatre exit");
  setMainWindowForIntegrationTest(null);

  console.log("Native child-frame controls, playback commands, Theatre overlay, and restoration passed end to end.");
  app.exit(0);
})().catch((error) => {
  console.error(error);
  app.exit(1);
}).finally(() => {
  try {
    // The integration-only window hook must not retain a destroyed window.
    process.env.HAVYN_SKIP_APP_BOOTSTRAP = "1";
  } catch {}
  window?.destroy();
  captureWindow?.destroy();
  parentServer?.close();
  childServer.close();
});
