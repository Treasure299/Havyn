const CONFIG_KEY = "havyn-web:turn-override";
const USAGE_KEY = "havyn-web:turn-usage";
const CHANGE_EVENT = "havyn-turn-settings-changed";

const monthKey = () => new Date().toISOString().slice(0, 7);
const splitUrls = (value) => String(value || "").split(/[\n,]+/).map((url) => url.trim()).filter(Boolean);

export function getManualIceConfig() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CONFIG_KEY) || "null");
    if (!saved?.enabled) return null;
    const turnUrls = splitUrls(saved.turnUrls);
    if (!turnUrls.length || !saved.username || !saved.credential) return null;
    return {
      iceServers: [
        ...(saved.stunUrl ? [{ urls: saved.stunUrl }] : []),
        { urls: turnUrls, username: saved.username, credential: saved.credential }
      ],
      relayConfigured: true,
      relayProvider: "custom"
    };
  } catch {
    return null;
  }
}

export function getTurnSettings() {
  try {
    return JSON.parse(sessionStorage.getItem(CONFIG_KEY) || "null") || { enabled: false };
  } catch {
    return { enabled: false };
  }
}

export function saveTurnSettings(settings) {
  if (settings.enabled) sessionStorage.setItem(CONFIG_KEY, JSON.stringify(settings));
  else sessionStorage.removeItem(CONFIG_KEY);
  dispatchEvent(new Event(CHANGE_EVENT));
}

export function getRelayUsage() {
  try {
    const saved = JSON.parse(localStorage.getItem(USAGE_KEY) || "null");
    return saved?.month === monthKey() ? Number(saved.bytes || 0) : 0;
  } catch {
    return 0;
  }
}

export function recordRelayUsage(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const next = getRelayUsage() + bytes;
  localStorage.setItem(USAGE_KEY, JSON.stringify({ month: monthKey(), bytes: next }));
  dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeTurnSettings(listener) {
  addEventListener(CHANGE_EVENT, listener);
  return () => removeEventListener(CHANGE_EVENT, listener);
}

export async function probeTurnSettings(settings) {
  const turnUrls = splitUrls(settings.turnUrls);
  if (!turnUrls.length || !settings.username || !settings.credential) throw new Error("Enter a TURN server, username, and password.");
  const configuration = {
    iceTransportPolicy: "relay",
    iceServers: [
      ...(settings.stunUrl ? [{ urls: settings.stunUrl }] : []),
      { urls: turnUrls, username: settings.username, credential: settings.credential }
    ]
  };
  const sender = new RTCPeerConnection(configuration);
  const receiver = new RTCPeerConnection(configuration);
  const senderQueue = [];
  const receiverQueue = [];
  let relayProtocol = "TURN";
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The relay accepted credentials but could not carry data end to end.")), 15_000);
      sender.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        if (candidate.type === "relay") relayProtocol = candidate.protocol || relayProtocol;
        if (receiver.remoteDescription) void receiver.addIceCandidate(candidate).catch(() => {});
        else receiverQueue.push(candidate);
      };
      receiver.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        if (candidate.type === "relay") relayProtocol = candidate.protocol || relayProtocol;
        if (sender.remoteDescription) void sender.addIceCandidate(candidate).catch(() => {});
        else senderQueue.push(candidate);
      };
      receiver.ondatachannel = ({ channel }) => {
        channel.onmessage = ({ data }) => {
          if (data !== "havyn-relay-ready") return;
          clearTimeout(timeout);
          resolve(relayProtocol);
        };
      };
      const channel = sender.createDataChannel("havyn-relay-test");
      channel.onopen = () => channel.send("havyn-relay-ready");
      sender.createOffer().then(async (offer) => {
        await sender.setLocalDescription(offer);
        await receiver.setRemoteDescription(sender.localDescription);
        await Promise.all(receiverQueue.splice(0).map((candidate) => receiver.addIceCandidate(candidate)));
        await receiver.setLocalDescription(await receiver.createAnswer());
        await sender.setRemoteDescription(receiver.localDescription);
        await Promise.all(senderQueue.splice(0).map((candidate) => sender.addIceCandidate(candidate)));
      }).catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    sender.close();
    receiver.close();
  }
}
