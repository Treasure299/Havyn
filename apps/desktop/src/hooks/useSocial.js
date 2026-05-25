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
  const [friends, setFriends] = useState([]);
  const [friendRequests, setFriendRequests] = useState([]);
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

  const loadFriends = useCallback(async () => {
    if (!supabase || !userId) return;
    const { data } = await supabase
      .from("friendships")
      .select("friend_user_id,created_at,friend:profiles!friendships_friend_user_id_fkey(id,display_name,username,last_active_at)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(40);

    const { data: acceptedRequests } = await supabase
      .from("friend_requests")
      .select("requester_user_id,addressee_user_id,responded_at,requester:profiles!friend_requests_requester_user_id_fkey(id,display_name,username,last_active_at),addressee:profiles!friend_requests_addressee_user_id_fkey(id,display_name,username,last_active_at)")
      .eq("status", "accepted")
      .or(`requester_user_id.eq.${userId},addressee_user_id.eq.${userId}`)
      .limit(80);

    const friendsById = new Map();
    (data || []).forEach((item) => {
      if (!item.friend_user_id) return;
      friendsById.set(item.friend_user_id, {
        userId: item.friend_user_id,
        displayName: item.friend?.display_name || "Havyn user",
        username: item.friend?.username || "",
        lastActiveAt: item.friend?.last_active_at,
        friendsSince: item.created_at
      });
    });

    (acceptedRequests || []).forEach((item) => {
      const isRequester = item.requester_user_id === userId;
      const friendId = isRequester ? item.addressee_user_id : item.requester_user_id;
      const profile = isRequester ? item.addressee : item.requester;
      if (!friendId || friendsById.has(friendId)) return;
      friendsById.set(friendId, {
        userId: friendId,
        displayName: profile?.display_name || "Havyn user",
        username: profile?.username || "",
        lastActiveAt: profile?.last_active_at,
        friendsSince: item.responded_at
      });
    });

    const friendRows = Array.from(friendsById.values());
    const friendIds = friendRows.map((item) => item.userId);
    const { data: presenceRows } = friendIds.length
      ? await supabase.from("user_presence").select("user_id,online,last_active_at").in("user_id", friendIds)
      : { data: [] };
    const presenceByUser = new Map((presenceRows || []).map((item) => [item.user_id, item]));

    setFriends(friendRows.map((item) => {
      const presence = presenceByUser.get(item.userId);
      const activeAt = presence?.last_active_at || item.lastActiveAt;
      return {
        ...item,
        online: Boolean(presence?.online && isRecentlyActive(activeAt)),
        lastActiveAt: activeAt
      };
    }).sort((a, b) => Number(b.online) - Number(a.online) || new Date(b.friendsSince || 0).getTime() - new Date(a.friendsSince || 0).getTime()));
  }, [userId]);

  const loadFriendRequests = useCallback(async () => {
    if (!supabase || !userId) return;
    const { data } = await supabase
      .from("friend_requests")
      .select("id,requester_user_id,created_at,requester:profiles!friend_requests_requester_user_id_fkey(id,display_name,username,last_active_at)")
      .eq("addressee_user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(20);

    setFriendRequests((data || []).map((item) => ({
      id: item.id,
      userId: item.requester_user_id,
      displayName: item.requester?.display_name || "Havyn user",
      username: item.requester?.username || "",
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
    loadFriends();
    loadFriendRequests();
    loadInvites();
    loadPublicRooms();
  }, [loadFriendRequests, loadFriends, loadInvites, loadPublicRooms, loadRecentPeople]);

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
    if (!supabase || !userId) return undefined;

    const showIncomingNotice = (message) => {
      setSocialNote(message);
      window.setTimeout(() => setSocialNote(""), 2200);
    };

    const channel = supabase
      .channel(`havyn-social-notifications:${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "room_invites", filter: `invitee_user_id=eq.${userId}` },
        (payload) => {
          loadInvites();
          if (payload.eventType === "INSERT" && payload.new?.status === "pending") {
            showIncomingNotice("New room invite");
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "friend_requests", filter: `addressee_user_id=eq.${userId}` },
        (payload) => {
          loadFriendRequests();
          if (payload.eventType === "INSERT" && payload.new?.status === "pending") {
            showIncomingNotice("New friend request");
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "friendships", filter: `user_id=eq.${userId}` },
        loadFriends
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_presence" },
        loadFriends
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadFriendRequests, loadFriends, loadInvites, userId]);

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
    await supabase.from("room_members").upsert(
      { room_id: roomIdToInvite, user_id: userId, role: room?.hostUserId === userId ? "host" : "viewer" },
      { onConflict: "room_id,user_id" }
    );
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
    if (error) console.warn("Havyn invite failed", error);
    setSocialNote(error ? `Invite could not be sent: ${error.message}` : "Invite sent in Havyn");
    window.setTimeout(() => setSocialNote(""), 1800);
    return !error;
  }

  async function sendFriendRequest(username) {
    if (!supabase || !userId) return false;
    const normalized = username.trim().toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9_]{3,24}$/.test(normalized)) {
      setSocialNote("Use a valid username");
      window.setTimeout(() => setSocialNote(""), 1800);
      return false;
    }
    const { data: target, error: targetError } = await supabase
      .from("profiles")
      .select("id,display_name,username")
      .eq("username", normalized)
      .maybeSingle();
    if (targetError || !target) {
      setSocialNote("No user found with that username");
      window.setTimeout(() => setSocialNote(""), 1800);
      return false;
    }
    if (target.id === userId) {
      setSocialNote("That is your username");
      window.setTimeout(() => setSocialNote(""), 1800);
      return false;
    }
    const { data: existingFriend } = await supabase
      .from("friendships")
      .select("id")
      .eq("user_id", userId)
      .eq("friend_user_id", target.id)
      .maybeSingle();
    if (existingFriend) {
      setSocialNote(`${target.display_name} is already your friend`);
      window.setTimeout(() => setSocialNote(""), 1800);
      return false;
    }
    const { error } = await supabase.from("friend_requests").upsert(
      {
        requester_user_id: userId,
        addressee_user_id: target.id,
        status: "pending",
        created_at: new Date().toISOString(),
        responded_at: null
      },
      { onConflict: "requester_user_id,addressee_user_id" }
    );
    setSocialNote(error ? "Friend request could not be sent" : `Friend request sent to @${normalized}`);
    window.setTimeout(() => setSocialNote(""), 2200);
    return !error;
  }

  async function acceptFriendRequest(requestId) {
    if (!supabase || !userId) return;
    const request = friendRequests.find((item) => item.id === requestId);
    if (!request) return;
    const now = new Date().toISOString();
    await supabase
      .from("friend_requests")
      .update({ status: "accepted", responded_at: now })
      .eq("id", requestId);
    await supabase.from("friendships").upsert([
      { user_id: userId, friend_user_id: request.userId, created_at: now },
      { user_id: request.userId, friend_user_id: userId, created_at: now }
    ], { onConflict: "user_id,friend_user_id" });
    await Promise.all([loadFriendRequests(), loadFriends()]);
    setSocialNote(`${request.displayName} added to friends`);
    window.setTimeout(() => setSocialNote(""), 1800);
  }

  async function declineFriendRequest(requestId) {
    if (!supabase) return;
    await supabase
      .from("friend_requests")
      .update({ status: "declined", responded_at: new Date().toISOString() })
      .eq("id", requestId);
    await loadFriendRequests();
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
    friends,
    friendRequests,
    invites,
    publicRooms,
    socialNote,
    refreshSocial,
    sendInvite,
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    acceptInvite,
    dismissInvite
  };
}
