export const ROOM_ENDPOINT = (
  import.meta.env.VITE_CLOUDFLARE_ROOM_URL
  || import.meta.env.VITE_ROOM_ENDPOINT
  || "https://havyn-room-coordinator-staging.chijiokekosisochukwu.workers.dev"
).replace(/\/$/, "");

export const syncDebugEnabled = import.meta.env.VITE_SYNC_DEBUG === "true"
  || (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("syncDebug") === "1");

export function syncDebug(event, detail) {
  if (!syncDebugEnabled) return;
  const entry = { at: new Date().toISOString(), event, detail };
  const history = window.__HAVYN_SYNC_LOG__ || [];
  history.push(entry);
  window.__HAVYN_SYNC_LOG__ = history.slice(-160);
  const payload = detail === undefined ? "" : ` ${JSON.stringify(detail)}`;
  console.info(`[Havyn sync] ${event}${payload}`);
}
