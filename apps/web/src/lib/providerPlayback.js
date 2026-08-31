const PROVIDER_ADAPTERS = {
  cinesrc: {
    parse(data) {
      if (!data?.type || !String(data.type).startsWith("cinesrc:")) return null;
      const type = String(data.type).slice("cinesrc:".length);
      if (["play", "pause", "seeking", "seeked", "timeupdate"].includes(type)) {
        return { type, currentTime: Number(data.currentTime ?? data.time ?? data.value), isPlaying: type === "play" ? true : type === "pause" ? false : undefined };
      }
      if (type === "ready") return { type: "ready" };
      if (type === "response") return { type: "status", currentTime: Number(data.currentTime ?? data.result) };
      return null;
    },
    command(action, currentTime) {
      const command = action === "seek" ? "seek" : action === "status" ? "getCurrentTime" : action;
      return { type: "cinesrc:command", command, args: command === "seek" ? [currentTime] : [] };
    }
  },
  strigil: {
    parse(data) {
      if (data?.type !== "PLAYER_EVENT") return null;
      const event = data.data || {};
      const type = event.event || event.type;
      if (!type) return null;
      if (["play", "pause", "seeking", "seeked", "timeupdate"].includes(type)) {
        return { type, currentTime: Number(event.currentTime ?? event.time), isPlaying: type === "play" ? true : type === "pause" ? false : undefined };
      }
      return null;
    },
    command(action, currentTime) {
      return { type: "PLAYER_COMMAND", command: action === "status" ? "getCurrentTime" : action, ...(action === "seek" ? { value: currentTime } : {}) };
    }
  },
  moviesapi: {
    parse(data) {
      if (data?.source !== "moviesapi-player") return null;
      const type = data.event || data.type;
      if (!type) return null;
      const currentTime = Number(data.currentTime ?? data.time ?? data.data?.currentTime);
      if (["play", "pause", "seeked", "seeking", "timeupdate"].includes(type)) {
        return { type, currentTime, isPlaying: type === "play" ? true : type === "pause" ? false : undefined };
      }
      if (type === "playerstatus") return { type: "status", currentTime, isPlaying: data.paused === false ? true : data.paused === true ? false : undefined };
      return null;
    },
    command(action, currentTime) {
      if (action === "status") return { action: "getStatus" };
      return action === "seek" ? { action, time: currentTime } : { action };
    }
  }
};

export function providerAdapter(provider) {
  return PROVIDER_ADAPTERS[provider?.adapterId] || null;
}

export function isSyncedProvider(provider) {
  return provider?.capability === "synced" && Boolean(providerAdapter(provider));
}

export function parseProviderEvent(provider, event, frameWindow) {
  if (!provider?.origin || event.origin !== provider.origin || event.source !== frameWindow) return null;
  return providerAdapter(provider)?.parse(event.data) || null;
}

export function postProviderCommand(provider, frameWindow, action, currentTime = 0) {
  const adapter = providerAdapter(provider);
  if (!adapter || !frameWindow) return false;
  frameWindow.postMessage(adapter.command(action, currentTime), provider.origin);
  return true;
}
