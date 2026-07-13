import { io } from "socket.io-client";
import { AblyRealtimeSocket } from "./ablyRealtimeSocket";
import { CloudflareRealtimeSocket } from "./cloudflareRealtimeSocket";
import { SupabaseRealtimeSocket } from "./supabaseRealtimeSocket";

const socketUrl = import.meta.env.VITE_SOCKET_SERVER_URL || "http://localhost:4000";
const signalingProvider = import.meta.env.VITE_SIGNALING_PROVIDER || "socket";

let socket;

export function getSocket() {
  if (!socket) {
    if (signalingProvider === "cloudflare") {
      socket = new CloudflareRealtimeSocket();
    } else if (signalingProvider === "ably") {
      socket = new AblyRealtimeSocket();
    } else if (signalingProvider === "supabase") {
      socket = new SupabaseRealtimeSocket();
    } else {
      socket = io(socketUrl, {
        autoConnect: true,
        transports: ["websocket", "polling"]
      });
    }
  }
  return socket;
}
