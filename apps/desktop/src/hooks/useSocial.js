import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const ONLINE_WINDOW_MS = 2 * 60 * 1000;

function isRecentlyActive(value) {
  if (!value) return false;
  return Date.now() - new Date(value).getTime() < ONLINE_WINDOW_MS;
}

function compactRoom(room, memberCounts = new Map()) {
  const host = room.host || room.profiles || {};
  return {
    roomId: room.id,
    roomName: room.name,
    hostUserId: room.host_user_id,
    hostName: host.display_name || "Host",
    activeMediaTitle: room.active_media_title || "Choosing something to watch",
    activeMediaUrl: room.active_media_url || "",
    participantCount: memberCounts.get(room.id) || 1,
    lastSeenAt: room.last_seen_at || room.updated_at || room.created_at
  };
}

function isRoomFresh(value) {
  if (!value) return false;
  return Date.now() - new Date(value).getTime() < 5 * 60 * 1000;
}

export function useSocial(user, room) {
  const [recentPeople, setRecentPeople] = useState([]);
  const [invites, setInvites] = useState([]);
  const [publicRooms, setPublicRooms] = useState([]);
  const [socialNote, setSocialNote] = useState("");

  const userId = user?.id;
  const roomId = room?.roomId;
  const isHost = room?.hostUserId === userId;

  const visiblePartners = useMemo(() => recentPeople.slice(0, 8), [recentPeople]);

  const loadRecentPeople = useCallback(async () => {
    if (!supabase || !userId) return;
    const { data } = await supabase
      .from("watch_partners")
      .select("partner_user_id,last_room_id,last_watched_at,partner:profiles!watch_partners_partner_user_id_fkey(id,display_name,last_active_at)")
      .eq("user_id", userId)
      .order("last_watched_at", { ascending: false })
      .limit(12);

    const partnerIds = (data || []).map((item) => item.partner_user_id);
    const { data: presenceRows } = partnerIds.length
      ? await supabase.from("user_presence").select("user_id,online,last_active_at").in("user_id", partnerIds)
      : { data: [] };
    const presenceByUser = new Map((presenceRows || []).map((item) => [item.user_id, item]));

    setRecentPeople((data || []).map((item) => {
      const presence = presenceByUser.get(item.partner_user_id);
      const activeAt = presence?.last_active_at || item.partner?.last_active_at;
      return {
        userId: item.partner_user_id,
        displayName: item.partner?.display_name || "Havyn user",
        lastWatchedAt: item.last_watched_at,
        lastRoomId: item.last_room_id,
        online: Boolean(presence?.online && isRecentlyActive(activeAt)),
        lastActiveAt: activeAt
      };
    }));
  }, [userId]);

  const loadInvites = useCallback(async () => {
    if (!supabase || !userId) return;
    const { data } = await supabase
      .from("room_invites")
      .select("id,room_id,status,created_at,room:rooms(id,name,active_media_title,visibility),inviter:profiles!room_invites_inviter_user_id_fkey(id,display_name,last_active_at)")
      .eq("invitee_user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(10);

    setInvites((data || []).map((item) => ({
      id: item.id,
      roomId: item.room_id,
      roomName: item.room?.name || "Watch room",
      mediaTitle: item.room?.active_media_title || "",
      inviterName: item.inviter?.display_name || "Someone",
      createdAt: item.created_at
    })));
  }, [userId]);

  const loadPublicRooms = useCallback(async () => {
    if (!supabase || !userId) return;
    const { data: rooms } = await supabase
      .from("rooms")
      .select("id,name,host_user_id,active_media_title,active_media_url,last_seen_at,updated_at,created_at,host:profiles!rooms_host_user_id_fkey(id,display_name,last_active_at)")
      .eq("visibility", "public")
      .order("last_seen_at", { ascending: false })
      .limit(20);

    const roomIds = (rooms || []).map((item) => item.id);
    let counts = new Map();
    if (roomIds.length) {
      const { data: members } = await supabase
        .from("room_members")
        .select("room_id,user_id")
        .in("room_id", roomIds);
      counts = (members || []).reduce((map, member) => {
        map.set(member.room_id, (map.get(member.room_id) || 0) + 1);
        return map;
      }, new Map());
    }

    setPublicRooms((rooms || []).filter((item) => isRoomFresh(item.last_seen_at || item.updated_at)).map((item) => compactRoom(item, counts)));
  }, [userId]);

  const refreshSocial = useCallback(() => {
    loadRecentPeople();
    loadInvites();
    loadPublicRooms();
  }, [loadInvites, loadPublicRooms, loadRecentPeople]);

  useEffect(() => {
    if (!supabase || !userId) return undefined;

    const updatePresence = async (online = true) => {
      const now = new Date().toISOString();
      await Promise.all([
        supabase.from("profiles").update({ last_active_at: now }).eq("id", userId),
        supabase.from("user_presence").upsert(
          { user_id: userId, online, last_active_at: now, updated_at: now },
          { onConflict: "user_id" }
        )
      ]);
    };

    updatePresence(true);
    const timer = window.setInterval(() => updatePresence(true), 45_000);
    const markOffline = () => updatePresence(false);
    window.addEventListener("beforeunload", markOffline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", markOffline);
      markOffline();
    };
  }, [userId]);

  useEffect(() => {
    refreshSocial();
    const timer = window.setInterval(refreshSocial, 30_000);
    return () => window.clearInterval(timer);
  }, [refreshSocial]);

  useEffect(() => {
    if (!supabase || !roomId || !userId) return;
    const others = (room.participants || []).filter((participant) => participant.userId !== userId);
    if (!others.length) return;
    const now = new Date().toISOString();
    const rows = others.map((participant) => ({
      user_id: userId,
      partner_user_id: participant.userId,
      last_room_id: roomId,
      last_watched_at: now
    }));
    supabase.from("watch_partners").upsert(rows, { onConflict: "user_id,partner_user_id" }).then(loadRecentPeople);
  }, [loadRecentPeople, room?.participants, roomId, userId]);

  useEffect(() => {
    if (!supabase || !roomId || !isHost) return;
    const updateRoomPresence = () => {
      const now = new Date().toISOString();
      supabase
        .from("rooms")
        .update({
          active_media_url: room.playbackState?.activeMediaUrl || null,
          active_media_title: room.playbackState?.activeMediaTitle || null,
          last_seen_at: now,
          updated_at: now
        })
        .eq("id", roomId)
        .then(loadPublicRooms);
    };

    updateRoomPresence();
    const timer = window.setInterval(updateRoomPresence, 30_000);
    return () => window.clearInterval(timer);
  }, [isHost, loadPublicRooms, room?.playbackState?.activeMediaTitle, room?.playbackState?.activeMediaUrl, roomId]);

  async function sendInvite(roomIdToInvite, inviteeUserId) {
    if (!supabase || !userId || !roomIdToInvite || !inviteeUserId) return false;
    const { error } = await supabase.from("room_invites").upsert(
      {
        room_id: roomIdToInvite,
        inviter_user_id: userId,
        invitee_user_id: inviteeUserId,
        status: "pending",
        created_at: new Date().toISOString(),
        responded_at: null
      },
      { onConflict: "room_id,inviter_user_id,invitee_user_id" }
    );
    setSocialNote(error ? "Invite could not be sent" : "Invite sent in Havyn");
    window.setTimeout(() => setSocialNote(""), 1800);
    return !error;
  }

  async function acceptInvite(inviteId) {
    const invite = invites.find((item) => item.id === inviteId);
    if (!supabase || !invite) return null;
    await supabase
      .from("room_invites")
      .update({ status: "accepted", responded_at: new Date().toISOString() })
      .eq("id", inviteId);
    await loadInvites();
    return invite.roomId;
  }

  async function dismissInvite(inviteId) {
    if (!supabase) return;
    await supabase
      .from("room_invites")
      .update({ status: "dismissed", responded_at: new Date().toISOString() })
      .eq("id", inviteId);
    await loadInvites();
  }

  return {
    recentPeople: visiblePartners,
    invites,
    publicRooms,
    socialNote,
    refreshSocial,
    sendInvite,
    acceptInvite,
    dismissInvite
  };
}
