import { supabase } from "./supabase.js";

export async function publishPresence(user, activity = {}) {
  if (!supabase || !user?.userId || user.guest) return;
  const now = new Date().toISOString();
  await supabase.from("user_presence").upsert({
    user_id: user.userId,
    online: activity.state !== "idle",
    last_active_at: now,
    updated_at: now,
    activity_state: activity.state || "online",
    active_room_id: activity.roomId || null,
    active_title: activity.title || null,
    activity_updated_at: now
  }, { onConflict: "user_id" });
}

export function activityLabel(friend) {
  if (friend.activityState === "watching" && friend.activeTitle) {
    return friend.watchingWith ? `Watching ${friend.activeTitle} with ${friend.watchingWith}` : `Watching ${friend.activeTitle}`;
  }
  if (friend.activityState === "idle") return "Idle";
  if (friend.online) return "Online";
  return "Offline";
}
