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

(async () => {
  process.env.HAVYN_SKIP_APP_BOOTSTRAP = "1";
  const { FRAME_DETECTOR_SCRIPT, scanWebviewMedia } = await import("./main.js");
  const childPort = await listen(childServer);
  parentServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body><iframe src="http://127.0.0.1:${childPort}/player" style="width:700px;height:420px"></iframe></body></html>`);
  });
  const parentPort = await listen(parentServer);

  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, webviewTag: true }
  });
  await window.loadURL("data:text/html,<html><body></body></html>");

  ipcMain.on("browser:media-event-from-page", (event, payload) => {
    window.webContents.executeJavaScript(
      `window.__mediaEvents.push(${JSON.stringify({ ...payload, sourceFrameUrl: payload.media?.frameUrl || event.senderFrame?.url || "" })})`,
      true
    ).catch(() => {});
  });

  const preloadUrl = pathToFileURL(path.join(__dirname, "browserPreload.js")).href;
  const parentUrl = `http://127.0.0.1:${parentPort}/host`;
  await window.webContents.executeJavaScript(`
    window.__mediaEvents = [];
    const view = document.createElement('webview');
    view.id = 'guest';
    view.src = ${JSON.stringify(parentUrl)};
    view.preload = ${JSON.stringify(preloadUrl)};
    view.style.width = '760px';
    view.style.height = '480px';
    view.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,nodeIntegrationInSubFrames=yes,sandbox=no');
    document.body.appendChild(view);
    true;
  `);

  const guest = await waitFor(() => webContents.getAllWebContents().find((item) => item.getURL() === parentUrl));
  const childFrame = await waitFor(() => guest.mainFrame.frames.find((frame) => frame.url.includes(`:${childPort}/player`)));
  await waitFor(() => childFrame.executeJavaScript("Boolean(document.querySelector('video')?.srcObject)", true));

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
  console.log("Native child-frame controls, guest-local clicks, and remote playback commands passed end to end.");
  app.exit(0);
})().catch((error) => {
  console.error(error);
  app.exit(1);
}).finally(() => {
  window?.destroy();
  parentServer?.close();
  childServer.close();
});
