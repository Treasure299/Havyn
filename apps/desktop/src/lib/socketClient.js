import { io } from "socket.io-client";
import { SupabaseRealtimeSocket } from "./supabaseRealtimeSocket";

const socketUrl = import.meta.env.VITE_SOCKET_SERVER_URL || "http://localhost:4000";
const signalingProvider = import.meta.env.VITE_SIGNALING_PROVIDER || "socket";

let socket;

export function getSocket() {
  if (!socket) {
    socket = signalingProvider === "supabase"
      ? new SupabaseRealtimeSocket()
      : io(socketUrl, {
        autoConnect: true,
        transports: ["websocket", "polling"]
      });
  }
  return socket;
}
