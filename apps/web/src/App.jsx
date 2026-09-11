import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, CircleUserRound, Clapperboard, Compass, Copy, ExternalLink,
  Camera, ChevronDown, Film, Info, LogOut, Maximize2, MessageCircle, Mic, MicOff, Minimize2, MonitorUp, Play, Plus, Search, Send, ShieldCheck, Signal, Sparkles, Star, UserPlus, Users, Video, VideoOff, Volume2, VolumeX, X
} from "lucide-react";
import discordLogo from "./assets/discord.png";
import youtubeLogo from "./assets/youtube.png";
import joinRoomLogo from "./assets/join-room.png";
import { discover, GENRES, getHome, getProviders, getSeasonEpisodes, getSeriesDetails, searchYouTube, youtubeBrowseProvider, youtubeProvider } from "./lib/catalog.js";
import { isSupabaseConfigured, supabase } from "./lib/supabase.js";
import { RoomSocket } from "./lib/roomSocket.js";
import { ROOM_ENDPOINT } from "./lib/roomConfig.js";
import { activityLabel, publishPresence } from "./lib/presence.js";
import { useRoomCall } from "./lib/useRoomCall.js";
import { useProviderPlayback } from "./lib/useProviderPlayback.js";
import { useYouTubePlayback } from "./lib/useYouTubePlayback.js";
import { getRelayUsage, getTurnSettings, probeTurnSettings, saveTurnSettings, subscribeTurnSettings } from "./lib/turnConfig.js";
import roomStyles from "./RoomShell.module.css";

const roomCode = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
const displayName = (user) => user?.user_metadata?.display_name || user?.user_metadata?.username || user?.email?.split("@")[0] || "Havyn user";
const GUEST_KEY = "havyn-web:guest";
const guestNames = ["Silver Lantern", "Velvet Comet", "Quiet Nova", "Golden Echo", "Soft Orbit", "Cinder Bloom"];
const loadGuest = () => { try { return JSON.parse(localStorage.getItem(GUEST_KEY) || "null"); } catch { return null; } };
const newGuest = () => ({ userId: `guest_${crypto.randomUUID().replace(/-/g, "")}`, displayName: guestNames[Math.floor(Math.random() * guestNames.length)], guest: true });

function useRoomSounds() {
  const context = useRef(null);
  return useCallback((kind) => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      context.current ||= new AudioContext();
      const audio = context.current;
      if (audio.state === "suspended") audio.resume();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const now = audio.currentTime;
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(kind === "join" ? 620 : 760, now);
      oscillator.frequency.exponentialRampToValueAtTime(kind === "join" ? 880 : 980, now + .09);
      gain.gain.setValueAtTime(.0001, now);
      gain.gain.exponentialRampToValueAtTime(.055, now + .012);
      gain.gain.exponentialRampToValueAtTime(.0001, now + .14);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(now);
      oscillator.stop(now + .15);
    } catch { /* Sound is an enhancement, never a room dependency. */ }
  }, []);
}

function useDismissibleDetails() {
  const ref = useRef(null);
  const close = useCallback(() => { if (ref.current) ref.current.open = false; }, []);
  useEffect(() => {
    const dismiss = (event) => { if (ref.current && !ref.current.contains(event.target)) close(); };
    const escape = (event) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [close]);
  return { ref, close };
}

export default function App() {
  const [session, setSession] = useState(null);
  const [guest, setGuest] = useState(loadGuest);
  const [roomId, setRoomId] = useState(() => new URLSearchParams(location.hash.slice(1)).get("room") || "");
  const [page, setPage] = useState(() => new URLSearchParams(location.hash.slice(1)).get("room") ? "room" : "discover");
  const [toast, setToast] = useState(null);
  const notify = useCallback((message, tone = "info") => {
    if (!message) return;
    setToast({ id: crypto.randomUUID(), message: String(message), tone });
  }, []);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const onHash = () => {
      const nextRoom = new URLSearchParams(location.hash.slice(1)).get("room") || "";
      setRoomId(nextRoom);
      if (nextRoom) setPage("room");
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timeout);
  }, [toast]);

  const pendingInvites = useRoomInviteCount(session?.user?.id || "", notify);
  useInviteResponseNotifications(session?.user?.id || "", notify);
  if (!isSupabaseConfigured) return <SetupNotice />;
  if (!session && !guest) return <AuthScreen onGuest={() => { const next = newGuest(); localStorage.setItem(GUEST_KEY, JSON.stringify(next)); setGuest(next); }} />;
  const user = session ? { userId: session.user.id, displayName: displayName(session.user) } : guest;
  const enterRoom = (id) => {
    const normalized = String(id).trim().toUpperCase();
    if (!normalized) return;
    location.hash = `room=${encodeURIComponent(normalized)}`;
    setRoomId(normalized);
    setPage("room");
  };
  return (
    <main className={`web-app${page === "room" && roomId ? " room-app" : ""}`}>
      <TopBar user={user} page={page} pendingInvites={pendingInvites} notify={notify} onGuestAccount={() => { localStorage.removeItem(GUEST_KEY); setGuest(null); }} onNavigate={(next) => { location.hash = ""; setRoomId(""); setPage(next); }} />
      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
      {page === "room" && roomId
        ? <RoomShell key={roomId} roomId={roomId} user={user} onBack={() => { location.hash = ""; setPage("discover"); }} notify={notify} />
        : !user.guest && page === "friends" ? <FriendsPage user={user} notify={notify} onEnterRoom={enterRoom} />
          : page === "profile" ? <ProfilePage user={user} />
            : <Discover user={user} onEnterRoom={enterRoom} notify={notify} />}
    </main>
  );
}

function useRoomInviteCount(userId, notify) {
  const [count, setCount] = useState(0);
  const previous = useRef(null);
  useEffect(() => {
    if (!supabase || !userId) return undefined;
    const refresh = async () => {
      const { count: next } = await supabase.from("room_invites").select("id", { count: "exact", head: true }).eq("invitee_user_id", userId).eq("status", "pending");
      const safeCount = Number(next || 0);
      if (previous.current !== null && safeCount > previous.current) notify("You have a new room invitation.");
      previous.current = safeCount;
      setCount(safeCount);
    };
    refresh();
    const channel = supabase.channel(`havyn-web-invite-count:${userId}`).on("postgres_changes", { event: "*", schema: "public", table: "room_invites", filter: `invitee_user_id=eq.${userId}` }, refresh).subscribe();
    return () => supabase.removeChannel(channel);
  }, [notify, userId]);
  return count;
}

function useInviteResponseNotifications(userId, notify) {
  const seen = useRef(new Set());
  useEffect(() => {
    if (!supabase || !userId) return undefined;
    const channel = supabase.channel(`havyn-web-invite-responses:${userId}`).on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "room_invites", filter: `inviter_user_id=eq.${userId}` },
      async (change) => {
        const after = change.new || {};
        if (!after.responded_at || !["dismissed", "declined"].includes(after.status) || seen.current.has(after.id)) return;
        seen.current.add(after.id);
        const { data } = await supabase.from("profiles").select("display_name").eq("id", after.invitee_user_id).maybeSingle();
        notify(`${data?.display_name || "A friend"} declined your room invitation.`);
      }
    ).subscribe();
    return () => supabase.removeChannel(channel);
  }, [notify, userId]);
}

function Toast({ message }) {
  return <div className="toast" role="status" aria-live="polite"><span>{message}</span></div>;
}

function SetupNotice() {
  return <div className="auth-shell"><section className="auth-card"><Mark /><h1>Havyn Web needs configuration</h1><p>Set the public Supabase URL and anon key before deploying this build.</p></section></div>;
}

function AuthScreen({ onGuest }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    setMessage("");
    const result = mode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { display_name: name } } });
    setMessage(result.error?.message || (mode === "signin" ? "" : "Check your inbox to confirm your Havyn account."));
  };
  return <div className="auth-shell"><form className="auth-card" onSubmit={submit}>
    <Mark /><p className="eyebrow">HAVYN WEB</p><h1>{mode === "signin" ? "Welcome back." : "Create your Havyn account."}</h1>
    {mode === "signup" && <input placeholder="Display name" value={name} onChange={(event) => setName(event.target.value)} required />}
    <input type="email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} required />
    <input type="password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength="6" />
    {message && <p className="form-message">{message}</p>}
    <button className="button primary" type="submit">{mode === "signin" ? "Enter Havyn" : "Sign up"}</button>
    <button className="text-button" type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>{mode === "signin" ? "Create an account" : "I already have an account"}</button>
    <button className="text-button" type="button" onClick={onGuest}>Watch as guest</button>
  </form></div>;
}

function TopBar({ user, page, pendingInvites, notify, onNavigate, onGuestAccount }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const profileRef = useRef(null);
  useEffect(() => {
    const dismiss = (event) => { if (profileRef.current && !profileRef.current.contains(event.target)) setMenuOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  return <header className="topbar">
    <button className="brand" onClick={() => onNavigate("discover")}><Mark /><span>Havyn</span><small>Web beta</small></button>
    <nav><button className={page === "discover" ? "active" : ""} onClick={() => onNavigate("discover")}><Compass size={15}/><span>Discover</span></button>{!user.guest && <button className={page === "friends" ? "active" : ""} onClick={() => onNavigate("friends")}><Users size={15}/><span>Friends</span>{pendingInvites > 0 && <i className="nav-count" aria-label={`${pendingInvites} pending room invitations`}>{pendingInvites}</i>}</button>}</nav>
    <div className="profile-wrap" ref={profileRef}>
      {!user.guest && <button className="discord-trigger" type="button" title="Havyn Discord is coming soon" aria-label="Havyn Discord is coming soon" disabled><img src={discordLogo} alt="" /></button>}<button className="profile-trigger" onClick={() => setMenuOpen((value) => !value)} aria-label="Open account menu" title={user.displayName} aria-expanded={menuOpen}><CircleUserRound size={18}/></button>
      {menuOpen && <div className="profile-menu"><strong>{user.displayName}</strong><span>{user.guest ? "Guest in this browser" : "Signed in to Havyn"}</span><button className="profile-menu-primary" onClick={() => { setMenuOpen(false); setRelayOpen(true); }}><Signal size={16}/> Call relay</button>{user.guest && <button className="profile-menu-primary" onClick={() => { setMenuOpen(false); onGuestAccount(); }}><CircleUserRound size={16}/> Sign in or create account</button>}{!user.guest && <button onClick={() => { setMenuOpen(false); onNavigate("profile"); }}><Info size={16}/> About Havyn Web</button>}{!user.guest && <button onClick={() => supabase.auth.signOut()}><LogOut size={16}/> Sign out</button>}</div>}
    </div>
    {relayOpen && createPortal(<TurnSettingsModal user={user} notify={notify} onClose={() => setRelayOpen(false)} />, document.body)}
  </header>;
}

function formatBytes(bytes) {
  if (bytes < 1000 ** 2) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1000 ** 3) return `${(bytes / 1000 ** 2).toFixed(1)} MB`;
  if (bytes >= 1000 ** 4) return `${(bytes / 1000 ** 4).toFixed(2)} TB`;
  return `${(bytes / 1000 ** 3).toFixed(2)} GB`;
}

function TurnSettingsModal({ user, notify, onClose }) {
  const initial = getTurnSettings();
  const [custom, setCustom] = useState(Boolean(initial.enabled));
  const [guideOpen, setGuideOpen] = useState(false);
  const [stunUrl, setStunUrl] = useState(initial.stunUrl || "stun:stun.expressturn.com:3478");
  const [turnUrls, setTurnUrls] = useState(initial.turnUrls || "turn:free.expressturn.com:3478?transport=udp\nturn:free.expressturn.com:3478?transport=tcp");
  const [username, setUsername] = useState(initial.username || "");
  const [credential, setCredential] = useState(initial.credential || "");
  const [testing, setTesting] = useState(false);
  const [accountUsage, setAccountUsage] = useState(null);
  const usageProvider = custom ? "custom" : "cloudflare";
  const [usage, setUsage] = useState(() => getRelayUsage(usageProvider));
  useEffect(() => { setUsage(getRelayUsage(usageProvider)); return subscribeTurnSettings(() => setUsage(getRelayUsage(usageProvider))); }, [usageProvider]);
  useEffect(() => {
    if (custom || user.guest || !supabase) { setAccountUsage(null); return undefined; }
    const controller = new AbortController();
    supabase.auth.getSession()
      .then(({ data }) => data.session?.access_token ? fetch(`${ROOM_ENDPOINT}/v2/turn-usage`, { signal: controller.signal, headers: { Authorization: `Bearer ${data.session.access_token}` } }) : null)
      .then((response) => response?.ok ? response.json() : null)
      .then((payload) => { if (payload?.configured) setAccountUsage(payload); })
      .catch(() => {});
    return () => controller.abort();
  }, [custom, user.guest]);
  const settings = { enabled: custom, stunUrl: stunUrl.trim(), turnUrls, username: username.trim(), credential };
  const test = async () => {
    setTesting(true);
    try { const protocol = await probeTurnSettings(settings); notify(`Custom relay connected over ${String(protocol).toUpperCase()}.`); }
    catch (error) { notify(error?.message || "The custom relay could not connect."); }
    finally { setTesting(false); }
  };
  const save = () => {
    if (custom && (!turnUrls.trim() || !username.trim() || !credential)) return notify("Enter the TURN server, username, and password.");
    saveTurnSettings(settings);
    notify(custom ? "Custom call relay saved for this browser session." : "Havyn managed relay selected.");
    onClose();
  };
  const measuredUsage = !custom && accountUsage ? Number(accountUsage.egressBytes || 0) : usage;
  const freeTierBytes = Number(accountUsage?.freeTierBytes || 1_000_000_000_000);
  const progress = Math.min(100, measuredUsage / freeTierBytes * 100);
  const overageBytes = Math.max(0, measuredUsage - freeTierBytes);
  const estimatedCost = overageBytes / 1_000_000_000 * Number(accountUsage?.ratePerGb || .05);
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Call relay settings"><section className="relay-modal"><button className="icon-close" onClick={onClose} aria-label="Close call relay settings"><X /></button><p className="eyebrow">CALL RELAY</p><h2>Connection route</h2><div className="relay-mode" role="group" aria-label="Relay source"><button className={!custom ? "active" : ""} onClick={() => setCustom(false)}>Havyn relay</button><button className={custom ? "active" : ""} onClick={() => setCustom(true)}>Own credentials</button></div><p className="relay-mode-note">{custom ? "Replace Havyn's managed relay with another STUN and TURN account." : "No setup required. Havyn securely supplies short-lived Cloudflare TURN credentials when a call needs a relay."}</p>{custom ? <div className="relay-fields"><label className="relay-wide">STUN URL<input value={stunUrl} onChange={(event) => setStunUrl(event.target.value)} placeholder="stun:stun.expressturn.com:3478" /></label><label className="relay-wide">TURN URLs<textarea value={turnUrls} onChange={(event) => setTurnUrls(event.target.value)} placeholder={"turn:free.expressturn.com:3478?transport=udp\nturn:free.expressturn.com:3478?transport=tcp"} /></label><label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /></label><label>Password<input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="new-password" /></label><p className="relay-apply-note relay-wide">Custom details stay in this browser session and apply the next time you join a call.</p></div> : <div className="relay-managed"><Signal size={18}/><span><strong>Cloudflare TURN managed</strong><small>Used automatically when a direct call path is unavailable</small></span><b>Ready</b></div>}<button className="relay-help-button" type="button" onClick={() => setGuideOpen((value) => !value)} aria-expanded={guideOpen}><Info size={15}/><span>Where to get the details</span><ChevronDown size={15}/></button>{guideOpen && <div className="relay-guide"><ol><li>Sign in to your TURN provider and open its credential dashboard.</li><li>Copy its STUN URL, TURN URLs, username, and password. Keep one TURN URL per line.</li><li>Include UDP plus TCP or TLS routes where the provider supports them.</li><li>Select <strong>Test relay</strong>. Havyn verifies that data travels end to end through TURN before saving.</li></ol></div>}<div className="relay-usage"><span><strong>{formatBytes(measuredUsage)}</strong><small>{custom ? "estimated custom relay data on this device" : accountUsage ? "Cloudflare TURN egress this month" : "estimated Cloudflare relay data on this device"}</small></span>{!custom && <b>{progress < .01 ? "<0.01" : progress.toFixed(2)}%</b>}{!custom && <i aria-label={`${progress.toFixed(2)} percent of Cloudflare's shared 1 TB free tier`}><em style={{ width: `${progress}%` }} /></i>}{!custom && <strong className="relay-cost">{overageBytes > 0 ? `Estimated overage $${estimatedCost.toFixed(2)}` : `${formatBytes(Math.max(0, freeTierBytes - measuredUsage))} free tier remaining`}</strong>}<p>Direct calls are excluded. {accountUsage ? "Cloudflare Analytics reports billable TURN egress; the final invoice may differ." : "This browser estimate is used until account analytics is configured."}</p></div><div className="relay-actions">{custom && <button className="button subtle" onClick={test} disabled={testing}>{testing ? "Testing..." : "Test relay"}</button>}<button className="button primary" onClick={save}>Save</button></div></section></div>;
}

function Discover({ user, onEnterRoom, notify }) {
  const [home, setHome] = useState({ trending: [], spotlight: null });
  const [results, setResults] = useState([]);
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [mediaType, setMediaType] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selected, setSelected] = useState(null);
  const [providers, setProviders] = useState(null);
  const [joining, setJoining] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [heroIndex, setHeroIndex] = useState(0);
  const [featuredTab, setFeaturedTab] = useState("trending");
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const loadMoreTarget = useRef(null);
  const genreCarouselRef = useRef(null);

  useEffect(() => { getHome().then(setHome).catch((error) => notify(error.message)).finally(() => setLoading(false)); }, [notify]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setCatalogLoading(true);
      discover({ query, genre, type: mediaType, page: 1 })
        .then((data) => {
          setResults(data.results);
          setPage(data.page);
          setTotalPages(data.totalPages);
        })
        .catch(() => {
          setResults([]);
          setPage(1);
          setTotalPages(1);
        })
        .finally(() => setCatalogLoading(false));
    }, query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [query, genre, mediaType]);

  const loadMore = useCallback(async () => {
    if (catalogLoading || page >= totalPages) return;
    setCatalogLoading(true);
    try {
      const data = await discover({ query, genre, type: mediaType, page: page + 1 });
      setResults((current) => {
        const seen = new Set(current.map((item) => `${item.mediaType}:${item.id}`));
        return [...current, ...data.results.filter((item) => !seen.has(`${item.mediaType}:${item.id}`))];
      });
      setPage(data.page);
      setTotalPages(data.totalPages);
    } finally {
      setCatalogLoading(false);
    }
  }, [catalogLoading, genre, mediaType, page, query, totalPages]);

  useEffect(() => {
    const target = loadMoreTarget.current;
    if (!target || page >= totalPages) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { rootMargin: "420px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore, page, totalPages]);

  const heroItems = useMemo(() => {
    const items = [home.spotlight, ...(home.trending || [])].filter((item) => item?.backdropUrl);
    return [...new Map(items.map((item) => [`${item.mediaType}:${item.id}`, item])).values()].slice(0, 6);
  }, [home]);
  const trendingItems = useMemo(() => {
    const seen = new Set();
    return [...(home.trending || []), ...results].filter((item) => {
      const key = `${item.mediaType}:${item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 18);
  }, [home.trending, results]);
  const featuredItems = featuredTab === "trending" ? trendingItems : results;
  const hero = heroItems[heroIndex % Math.max(heroItems.length, 1)] || home.spotlight || home.trending?.[0] || null;

  useEffect(() => {
    setHeroIndex((index) => Math.min(index, Math.max(heroItems.length - 1, 0)));
  }, [heroItems.length]);
  useEffect(() => {
    if (heroItems.length < 2) return undefined;
    const interval = window.setInterval(() => setHeroIndex((index) => (index + 1) % heroItems.length), 5600);
    return () => window.clearInterval(interval);
  }, [heroItems.length]);

  const choose = async (content) => {
    setSelected(content);
    setProviders(null);
    try { setProviders(await getProviders(content)); } catch { setProviders([]); }
  };
  const createRoom = (content, provider = null, inviteAfterCreate = true) => {
    const id = roomCode();
    sessionStorage.setItem(`havyn-web:create:${id}`, JSON.stringify({ roomName: content?.title || "Movie Night", content, provider, inviteAfterCreate }));
    onEnterRoom(id);
  };
  const joinRoom = (event) => { event.preventDefault(); const code = joinCode.trim().replace(/[^a-z0-9]/gi, "").toUpperCase(); if (code.length !== 8) return notify("Enter the eight-character room code."); setJoining(code); onEnterRoom(code); };

  return <section className="discover-page">
    <section className="discover-hero cinematic-hero">
      {hero?.backdropUrl && <img key={hero.backdropUrl} src={hero.backdropUrl} alt="" />}
      <div className="cinematic-hero-scrim" />
      <div className="cinematic-hero-content">
        <p className="eyebrow">NOW PLAYING ON HAVYN</p><h1>{hero?.title || "Find your next watch."}</h1>
        {hero && <p className="hero-meta">{hero.year || "Now"} <span>•</span> {hero.mediaType === "tv" ? "Series" : "Movie"} {hero.rating && <><span>•</span> <b className="rating-label"><Star size={12} fill="currentColor"/> TMDB rating {hero.rating}/10</b></>}</p>}
        <p>{hero?.overview || "Choose a title, create a private Havyn room, then continue on a provider everyone can access."}</p>
        <div className="hero-actions"><button className="button primary" onClick={() => hero ? choose(hero) : createRoom(null)}><Plus size={18}/>{hero ? "Watch together" : "Start an empty room"}</button><button className="button youtube-hero-action" onClick={() => setYoutubeOpen(true)} aria-label="YouTube together" title="YouTube together"><YouTubeLogo className="youtube-inline-logo"/><span>YouTube together</span></button></div>
        <form className="room-code-form hero-room-join" onSubmit={joinRoom}><span>Already invited?</span><input value={joinCode} onChange={(event) => setJoinCode(event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase())} placeholder="Room code" aria-label="Room code" maxLength="8" /><button className="room-code-join-icon" type="submit" aria-label={joining ? "Joining room" : "Join room"} title="Join room"><img src={joinRoomLogo} alt="" /></button></form>
      </div>
      {heroItems.length > 1 && <div className="hero-pagination" aria-label="Trending titles">{heroItems.map((item, index) => <button key={`${item.mediaType}-${item.id}`} className={index === heroIndex ? "active" : ""} onClick={() => setHeroIndex(index)} aria-label={`Show ${item.title}`} aria-current={index === heroIndex} />)}</div>}
    </section>
    <section className="home-browse-bar"><div className="home-content-tabs" role="tablist" aria-label="Featured titles"><button className={featuredTab === "trending" ? "active" : ""} type="button" onClick={() => { setFeaturedTab("trending"); setMediaType("all"); setGenre(""); setQuery(""); }}>Trending now</button><button className={featuredTab === "popular" ? "active" : ""} type="button" onClick={() => { setFeaturedTab("popular"); setMediaType("movie"); setGenre(""); setQuery(""); }}>Popular movies</button></div></section>
    {!query && !genre && <Rail featured title={featuredTab === "trending" ? "Trending now" : "Popular movies"} items={featuredItems} onChoose={choose} loading={featuredTab === "trending" ? loading : catalogLoading} />}
    <section className="discover-library">
      <div className="library-heading"><div className="library-type-tabs" aria-label="Content type"><button className={mediaType === "all" || mediaType === "movie" ? "selected" : ""} onClick={() => setMediaType("movie")}>Movies</button><button className={mediaType === "tv" ? "selected" : ""} onClick={() => setMediaType("tv")}>Series</button></div><button className="library-search-button" type="button" onClick={() => document.querySelector(".catalog-search")?.focus()} aria-label="Search titles"><Search size={17}/></button></div>
      <section className="catalog-toolbar">
        <div className="search-wrap"><Search size={18}/><input className="catalog-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search movies and series" /></div>
        <div className="genre-carousel"><button className="genre-carousel-arrow previous" type="button" aria-label="Show previous genres" onClick={() => genreCarouselRef.current?.scrollBy({ left: -300, behavior: "smooth" })}><ChevronLeft size={16}/></button><div className="genre-list" ref={genreCarouselRef}><button className={!genre ? "selected" : ""} onClick={() => setGenre("")}>All genres</button>{GENRES.map(([id, label]) => <button key={id} className={genre === id ? "selected" : ""} onClick={() => setGenre(id)}>{label}</button>)}</div><button className="genre-carousel-arrow next" type="button" aria-label="Show more genres" onClick={() => genreCarouselRef.current?.scrollBy({ left: 300, behavior: "smooth" })}><ChevronRight size={16}/></button></div>
      </section>
    </section>
    <Rail title={query ? "Search results" : genre ? "Browse by genre" : mediaType === "tv" ? "Popular series" : mediaType === "movie" ? "Popular movies" : "Explore movies and series"} items={results} onChoose={choose} loading={catalogLoading && !results.length} />
    <div ref={loadMoreTarget} className="catalog-load-state" aria-live="polite">{catalogLoading ? "Loading titles..." : page < totalPages ? "Keep scrolling for more" : results.length ? "You are all caught up." : "No titles matched your search."}</div>
    <BackToTop />
    {selected && <ProviderModal content={selected} providers={providers} onClose={() => setSelected(null)} onCreate={createRoom} />}
    {youtubeOpen && <YouTubeModal onClose={() => setYoutubeOpen(false)} onCreate={(content) => createRoom(content, youtubeProvider(content.id), true)} onBrowse={() => createRoom({ id: "youtube-browse", mediaType: "movie", title: "YouTube", overview: "Browse YouTube together, then choose a video to sync.", posterUrl: "", backdropUrl: "" }, youtubeBrowseProvider(), true)} />}
  </section>;
}

async function loadHavynFriends(userId) {
  if (!supabase || !userId) return [];
  const [{ data: friendshipRows }, { data: acceptedRows }] = await Promise.all([
    supabase.from("friendships").select("friend_user_id,created_at,friend:profiles!friendships_friend_user_id_fkey(id,display_name,username,last_active_at)").eq("user_id", userId).order("created_at", { ascending: false }).limit(40),
    supabase.from("friend_requests").select("requester_user_id,addressee_user_id,responded_at,requester:profiles!friend_requests_requester_user_id_fkey(id,display_name,username,last_active_at),addressee:profiles!friend_requests_addressee_user_id_fkey(id,display_name,username,last_active_at)").eq("status", "accepted").or(`requester_user_id.eq.${userId},addressee_user_id.eq.${userId}`).limit(80)
  ]);
  const byId = new Map();
  (friendshipRows || []).forEach((row) => {
    if (!row.friend_user_id) return;
    byId.set(row.friend_user_id, { userId: row.friend_user_id, displayName: row.friend?.display_name || "Havyn user", username: row.friend?.username || "", lastActiveAt: row.friend?.last_active_at || "", friendsSince: row.created_at });
  });
  (acceptedRows || []).forEach((row) => {
    const requester = row.requester_user_id === userId;
    const friendId = requester ? row.addressee_user_id : row.requester_user_id;
    const friend = requester ? row.addressee : row.requester;
    if (!friendId || byId.has(friendId)) return;
    byId.set(friendId, { userId: friendId, displayName: friend?.display_name || "Havyn user", username: friend?.username || "", lastActiveAt: friend?.last_active_at || "", friendsSince: row.responded_at });
  });
  const friends = [...byId.values()];
  let presenceRows = [];
  if (friends.length) {
    const expanded = await supabase.from("user_presence").select("user_id,online,last_active_at,activity_state,active_room_id,active_title").in("user_id", friends.map((friend) => friend.userId));
    const fallback = expanded.error ? await supabase.from("user_presence").select("user_id,online,last_active_at").in("user_id", friends.map((friend) => friend.userId)) : expanded;
    presenceRows = fallback.data || [];
  }
  const presence = new Map((presenceRows || []).map((row) => [row.user_id, row]));
  return friends.map((friend) => {
    const current = presence.get(friend.userId) || {};
    const companion = current.active_room_id && friends.find((other) => other.userId !== friend.userId && presence.get(other.userId)?.active_room_id === current.active_room_id);
    return { ...friend, online: Boolean(current.online), activityState: current.activity_state, activeTitle: current.active_title, watchingWith: companion?.displayName || "" };
  }).sort((a, b) => Number(b.online) - Number(a.online));
}

function presenceLabel(friend) {
  if (friend.activityState) return activityLabel(friend);
  if (friend.online) return "Online";
  if (!friend.lastActiveAt) return friend.username ? `@${friend.username}` : "Offline";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(friend.lastActiveAt).getTime()) / 1000));
  if (seconds < 90) return "Last active just now";
  if (seconds < 3600) return `Last active ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `Last active ${Math.floor(seconds / 3600)}h ago`;
  return "Offline";
}

function FriendsPage({ user, notify, onEnterRoom }) {
  return <section className="friends-page"><header className="friends-hero"><p className="eyebrow">YOUR HAVYN</p><h1>Friends and invitations</h1><p>Keep your people, pending invitations, and shared watch rooms in one place.</p></header><SocialRail user={user} notify={notify} onEnterRoom={onEnterRoom} fullPage /></section>;
}

function ProfilePage({ user }) {
  return <section className="profile-page"><header><p className="eyebrow">ACCOUNT</p><h1>{user.displayName}</h1><p>Havyn Web {import.meta.env.VITE_APP_VERSION || "0.1.0"}</p></header><section className="profile-copy"><h2>About Havyn Web</h2><p>Havyn is the social layer for private watch rooms. Create a room, invite friends, choose a supported provider, then share playback, chat, and optional calls while each person uses their own authorised session.</p><h2>Media responsibility</h2><p>Havyn does not host, copy, stream, or redistribute media. Providers supply playback and availability. You are responsible for ensuring that the media you access and watch is authorised for you and for complying with the applicable provider terms.</p></section></section>;
}

function BackToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const update = () => setVisible(window.scrollY > 720);
    update();
    addEventListener("scroll", update, { passive: true });
    return () => removeEventListener("scroll", update);
  }, []);
  return visible ? <button className="back-to-top" type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Back to top"><ArrowUp size={18}/></button> : null;
}

function SocialRail({ user, notify, onEnterRoom, fullPage = false }) {
  const [friends, setFriends] = useState([]); const [username, setUsername] = useState(""); const [invites, setInvites] = useState([]); const [requests, setRequests] = useState([]);
  const refresh = useCallback(async () => {
    if (!supabase) return;
    const [friendRows, { data: inviteData }, { data: requestData }] = await Promise.all([
      loadHavynFriends(user.userId),
      supabase.from("room_invites").select("id,room_id,room:rooms(id,name),inviter:profiles!room_invites_inviter_user_id_fkey(display_name)").eq("invitee_user_id", user.userId).eq("status", "pending").order("created_at", { ascending: false }).limit(6),
      supabase.from("friend_requests").select("id,requester_user_id,requester:profiles!friend_requests_requester_user_id_fkey(display_name,username)").eq("addressee_user_id", user.userId).eq("status", "pending").order("created_at", { ascending: false }).limit(6)
    ]);
    setFriends(friendRows);
    setInvites((inviteData || []).map((item) => ({ id: item.id, roomId: item.room_id, roomName: item.room?.name || "Watch room", inviter: item.inviter?.display_name || "Someone" })));
    setRequests((requestData || []).map((item) => ({ id: item.id, userId: item.requester_user_id, name: item.requester?.display_name || "Havyn user", username: item.requester?.username || "" })));
  }, [user.userId]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!supabase) return undefined;
    const channel = supabase.channel(`havyn-web-social:${user.userId}`).on("postgres_changes", { event: "*", schema: "public", table: "friendships", filter: `user_id=eq.${user.userId}` }, refresh).on("postgres_changes", { event: "*", schema: "public", table: "friend_requests", filter: `addressee_user_id=eq.${user.userId}` }, refresh).on("postgres_changes", { event: "*", schema: "public", table: "room_invites", filter: `invitee_user_id=eq.${user.userId}` }, refresh).on("postgres_changes", { event: "*", schema: "public", table: "user_presence" }, refresh).subscribe();
    return () => supabase.removeChannel(channel);
  }, [refresh, user.userId]);
  const addFriend = async (event) => { event.preventDefault(); const normalized = username.trim().replace(/^@/, "").toLowerCase(); if (!normalized) return; const { data: target } = await supabase.from("profiles").select("id,display_name").eq("username", normalized).maybeSingle(); if (!target || target.id === user.userId) return notify("No other Havyn user found with that username."); const { error } = await supabase.from("friend_requests").upsert({ requester_user_id: user.userId, addressee_user_id: target.id, status: "pending", created_at: new Date().toISOString(), responded_at: null }, { onConflict: "requester_user_id,addressee_user_id" }); setUsername(""); notify(error ? "Friend request could not be sent." : `Friend request sent to ${target.display_name}.`); };
  const joinInvite = async (invite) => { const { error } = await supabase.from("room_invites").update({ status: "accepted", responded_at: new Date().toISOString() }).eq("id", invite.id).eq("status", "pending"); if (error) return notify("The invitation could not be opened."); onEnterRoom(invite.roomId); };
  const declineInvite = async (invite) => {
    const { data, error } = await supabase.from("room_invites").update({ status: "dismissed", responded_at: new Date().toISOString() }).eq("id", invite.id).eq("status", "pending").select("id");
    if (error || !data?.length) return notify("The invitation could not be declined.");
    notify("Invitation declined.");
    refresh();
  };
  const answerRequest = async (request, accepted) => { const now = new Date().toISOString(); await supabase.from("friend_requests").update({ status: accepted ? "accepted" : "declined", responded_at: now }).eq("id", request.id); if (accepted) await supabase.from("friendships").upsert([{ user_id: user.userId, friend_user_id: request.userId, created_at: now }, { user_id: request.userId, friend_user_id: user.userId, created_at: now }], { onConflict: "user_id,friend_user_id" }); refresh(); };
  return <section className={`social-rail${fullPage ? " social-rail-page" : ""}`}><div className="section-heading"><div><p className="eyebrow">YOUR CIRCLE</p><h2>Friends</h2></div><span>{friends.length} friends</span></div><div className="social-rail-grid"><div className="friend-list">{friends.length ? friends.map((friend) => <div className="friend-chip" key={friend.userId}><span className={`avatar presence-avatar${friend.online ? " online" : ""}`}>{friend.displayName.slice(0,1)}</span><span><strong>{friend.displayName}</strong><small>{presenceLabel(friend)}</small></span></div>) : <p className="empty-copy">Friends you add will appear here.</p>}</div><form className="add-friend-form" onSubmit={addFriend}><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="Add a friend by username" /><button aria-label="Add friend"><UserPlus size={17}/></button></form></div>{requests.length > 0 && <div className="invite-notice-list">{requests.map((request) => <div key={request.id}><span><strong>{request.name} wants to connect</strong><small>{request.username ? `@${request.username}` : "Havyn friend request"}</small></span><button className="button subtle" onClick={() => answerRequest(request, true)}>Accept</button></div>)}</div>}{invites.length > 0 && <div className="invite-notice-list room-invite-list">{invites.map((invite) => <div key={invite.id}><span><strong>{invite.inviter} invited you to a room</strong><small>{invite.roomName}</small></span><div><button className="button subtle" onClick={() => declineInvite(invite)}>Decline</button><button className="button primary" onClick={() => joinInvite(invite)}>Join room</button></div></div>)}</div>}</section>;
}

function Rail({ title, items, onChoose, loading, featured = false }) {
  const railRef = useRef(null);
  return <section className={`content-rail${featured ? " homepage-featured-rail" : ""}`}><div className="section-heading"><h2>{title}</h2><span>{loading ? "Loading" : `${items.length} titles`}</span></div>
    <div className="poster-rail-wrap">{featured && <button className="genre-carousel-arrow featured-rail-arrow previous" type="button" aria-label="Show previous featured titles" onClick={() => railRef.current?.scrollBy({ left: -420, behavior: "smooth" })}><ChevronLeft size={16}/></button>}<div className="poster-rail" ref={railRef}>{items.map((item) => <button className="poster-card" key={`${item.mediaType}-${item.id}`} onClick={() => onChoose(item)}>
      {item.posterUrl ? <img src={item.posterUrl} alt="" /> : <div className="poster-fallback"><Film /></div>}
      <span><strong>{item.title}</strong><small>{item.year || item.mediaType}{item.rating ? `  ·  TMDB ${item.rating}/10` : ""}</small></span>
    </button>)}</div>{featured && <button className="genre-carousel-arrow featured-rail-arrow next" type="button" aria-label="Show more featured titles" onClick={() => railRef.current?.scrollBy({ left: 420, behavior: "smooth" })}><ChevronRight size={16}/></button>}</div>{!loading && !items.length && <p className="catalog-empty">No titles match those filters yet.</p>}
  </section>;
}

function YouTubeModal({ onClose, onCreate, onBrowse }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const directId = youtubeVideoId(query);
  useEffect(() => {
    const value = query.trim();
    if (!value || directId) { setResults([]); setError(""); return undefined; }
    const timer = setTimeout(() => {
      setLoading(true);
      searchYouTube(value).then((items) => { setResults(items); setError(""); }).catch((reason) => { setResults([]); setError(reason.message || "YouTube search is unavailable."); }).finally(() => setLoading(false));
    }, 320);
    return () => clearTimeout(timer);
  }, [directId, query]);
  const create = (item) => onCreate({ ...item, mediaType: "movie" });
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Create a YouTube room"><section className="youtube-modal"><button className="icon-close" onClick={onClose} aria-label="Close YouTube room picker"><X /></button><div className="youtube-modal-heading"><span className="youtube-mark"><YouTubeLogo/></span><div><p className="eyebrow">YOUTUBE WATCH TOGETHER</p><h2>Choose a video</h2><p>Each person watches through their own YouTube session.</p></div></div><div className="youtube-search"><Search size={18}/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search YouTube or paste a video link" /></div><button className="youtube-browse-home" type="button" onClick={onBrowse}><YouTubeLogo className="youtube-inline-logo"/><span><strong>Browse YouTube in this room</strong><small>Open Havyn's in-room YouTube browse surface</small></span><ChevronRight size={16}/></button>{directId && <button className="youtube-direct-result" type="button" onClick={() => create({ id: directId, title: "YouTube video", overview: "", posterUrl: "", backdropUrl: "" })}><YouTubeLogo className="youtube-inline-logo"/><span><strong>Watch this YouTube video</strong><small>Use the pasted link</small></span><ChevronRight size={17}/></button>}{loading && <p className="youtube-status">Searching YouTube...</p>}{error && <p className="youtube-status error">{error}</p>}{results.length > 0 && <div className="youtube-results">{results.map((item) => <button key={item.id} type="button" onClick={() => create(item)}>{item.posterUrl ? <img src={item.posterUrl} alt="" /> : <span className="youtube-result-fallback"><YouTubeLogo/></span>}<span><strong>{item.title}</strong><small>{item.channelTitle || "YouTube"}{item.year ? ` · ${item.year}` : ""}</small><em>{item.overview || "YouTube video"}</em></span><ChevronRight size={17}/></button>)}</div>}<p className="youtube-account-note">YouTube's signed-in homepage cannot be framed on the web, so Havyn keeps browsing in-room and only uses the official player once a video is chosen.</p></section></div>;
}

function youtubeVideoId(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    if (url.hostname.endsWith("youtu.be")) return url.pathname.slice(1).split("/")[0] || "";
    if (url.hostname.includes("youtube.com")) return url.searchParams.get("v") || url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/)?.[1] || "";
  } catch { /* A normal text query is handled by the search path. */ }
  return /^[\w-]{11}$/.test(input) ? input : "";
}

function ProviderModal({ content, providers, onClose, onCreate }) {
  const [season, setSeason] = useState(content.season || 1);
  const [episode, setEpisode] = useState(content.episode || 1);
  const [series, setSeries] = useState({ seasons: [] });
  const [episodes, setEpisodes] = useState([]);
  const [episodeLoading, setEpisodeLoading] = useState(content.mediaType === "tv");
  const [episodeError, setEpisodeError] = useState("");
  const [resolvedProviders, setResolvedProviders] = useState(providers);
  const [inviteAfterCreate, setInviteAfterCreate] = useState(true);
  const episodeCarouselRef = useRef(null);
  const selectedContent = content.mediaType === "tv" ? { ...content, season: Number(season), episode: Number(episode) } : content;

  useEffect(() => { setResolvedProviders(providers); }, [providers]);
  useEffect(() => {
    if (content.mediaType !== "tv") return undefined;
    let cancelled = false;
    getSeriesDetails(content.id).then((value) => { if (!cancelled) setSeries(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [content.id, content.mediaType]);
  useEffect(() => {
    if (content.mediaType !== "tv") return undefined;
    let cancelled = false;
    setEpisodeLoading(true); setEpisodeError("");
    getSeasonEpisodes(content.id, season).then((value) => {
      if (!cancelled) {
        setEpisodes(value);
        if (!value.some((item) => item.number === Number(episode))) setEpisode(value[0]?.number || 1);
      }
    }).catch(() => { if (!cancelled) setEpisodeError("Episode details are unavailable right now."); }).finally(() => { if (!cancelled) setEpisodeLoading(false); });
    return () => { cancelled = true; };
  }, [content.id, content.mediaType, season]);
  useEffect(() => {
    if (content.mediaType !== "tv") return undefined;
    let cancelled = false;
    getProviders(content, season, episode).then((value) => { if (!cancelled) setResolvedProviders(value); }).catch(() => { if (!cancelled) setResolvedProviders([]); });
    return () => { cancelled = true; };
  }, [content, episode, season]);
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="provider-modal">
    <button className="icon-close" onClick={onClose}><X /></button>
    <div className="provider-title">{content.posterUrl && <img src={content.posterUrl} alt="" />}<div><p className="eyebrow">CHOOSE A PROVIDER</p><h2>{content.title}</h2><p>{content.overview || "Choose how your room will open this title."}</p></div></div>
    {content.mediaType === "tv" && <section className="episode-picker premium-episodes"><div className="episode-picker-heading"><div><p className="eyebrow">PICK AN EPISODE</p><h3>Continue with the right chapter</h3></div><span>Season {season}</span></div><div className="season-tabs">{(series.seasons.length ? series.seasons : [{ number: 1, name: "Season 1" }]).map((item) => <button key={item.number} className={Number(season) === item.number ? "active" : ""} onClick={() => { setSeason(item.number); requestAnimationFrame(() => episodeCarouselRef.current?.scrollTo({ left: 0, behavior: "smooth" })); }}>{item.name}</button>)}</div>{episodeLoading ? <p className="episode-state">Loading episode guide...</p> : episodeError ? <p className="episode-state">{episodeError}</p> : <div className="episode-carousel-shell"><button className="episode-carousel-nav previous" type="button" aria-label="Previous episodes" onClick={() => episodeCarouselRef.current?.scrollBy({ left: -360, behavior: "smooth" })}><ChevronLeft size={18}/></button><div ref={episodeCarouselRef} className="episode-carousel">{episodes.map((item) => <button key={item.number} className={Number(episode) === item.number ? "selected" : ""} onClick={() => setEpisode(item.number)}>{item.stillUrl ? <img src={item.stillUrl} alt="" /> : <span className="episode-still"><Film size={18}/></span>}<span><b>E{item.number} · {item.name}</b><small>{[item.airDate?.slice(0, 4), item.runtime ? `${item.runtime} min` : ""].filter(Boolean).join(" · ")}</small><em>{item.overview || "Synopsis unavailable."}</em></span></button>)}</div><button className="episode-carousel-nav next" type="button" aria-label="Next episodes" onClick={() => episodeCarouselRef.current?.scrollBy({ left: 360, behavior: "smooth" })}><ChevronRight size={18}/></button></div>}</section>}
    <label className="create-invite-choice"><input type="checkbox" checked={inviteAfterCreate} onChange={(event) => setInviteAfterCreate(event.target.checked)} /> Invite friends after creating this room</label>
    {resolvedProviders === null ? <p>Checking availability...</p> : resolvedProviders.length ? <div className="provider-list">{resolvedProviders.map((provider) => <button key={String(provider.id)} onClick={() => onCreate(selectedContent, provider, inviteAfterCreate)}>{provider.logo ? <img src={provider.logo} alt="" /> : <Clapperboard />}<span><strong>{provider.name}{provider.source ? <em>{provider.source}</em> : null}</strong><small>{provider.capability === "synced" ? "Synced playback · play, pause and seek" : provider.kind === "embed" ? "Third-party embed · manual sync" : "Opens in your own authorised session · manual sync"}</small></span><ChevronRight /></button>)}</div> : <p className="empty-copy">No confirmed provider is available in your region. You can still create a room and choose a provider later.</p>}
    <button className="button subtle full" onClick={() => onCreate(selectedContent, null, inviteAfterCreate)}>Create room without a provider</button>
  </section></div>;
}

function RoomShell({ roomId, user, onBack, notify }) {
  const socketRef = useRef(null);
  const pendingCreateRef = useRef(readCreatePayload(roomId));
  const contentCommandSent = useRef(false);
  const [room, setRoom] = useState(null);
  const [connection, setConnection] = useState("connecting");
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [chooseOpen, setChooseOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [openInviteAfterCreate, setOpenInviteAfterCreate] = useState(() => Boolean(pendingCreateRef.current?.inviteAfterCreate));
  const [friends, setFriends] = useState([]);
  const [theater, setTheater] = useState(false);
  const [theaterChatOpen, setTheaterChatOpen] = useState(false);
  const [theaterChatUnread, setTheaterChatUnread] = useState(false);
  const [freshChatId, setFreshChatId] = useState("");
  const [theaterIdle, setTheaterIdle] = useState(false);
  const [theaterCallHeight, setTheaterCallHeight] = useState(() => {
    const saved = Number(localStorage.getItem("havyn-web:theater-call-height")) || 210;
    return Math.min(Math.floor(window.innerHeight * .32), Math.max(132, saved));
  });
  const [theaterChatWidth, setTheaterChatWidth] = useState(() => {
    const saved = Number(localStorage.getItem("havyn-web:theater-chat-width")) || 340;
    return Math.min(520, Math.max(250, saved));
  });
  const [fullscreen, setFullscreen] = useState(false);
  const [railWidth, setRailWidth] = useState(() => Number(localStorage.getItem("havyn-web:room-rail-width")) || 360);
  const [normalCallHeight, setNormalCallHeight] = useState(() => Number(localStorage.getItem("havyn-web:normal-call-height")) || 208);
  const [callDockActive, setCallDockActive] = useState(false);
  const [compactControl, setCompactControl] = useState("");
  const [compactToolbar, setCompactToolbar] = useState(() => window.innerWidth <= 820);
  const [connectionQuality, setConnectionQuality] = useState({});
  const [syncReady, setSyncReady] = useState(false);
  const [startSyncedPlayback, setStartSyncedPlayback] = useState(null);
  const [syncNeedsGesture, setSyncNeedsGesture] = useState(false);
  const [startLocalPlayback, setStartLocalPlayback] = useState(null);
  const roomPageRef = useRef(null);
  const previousParticipants = useRef(new Set());
  const theaterChatOpenRef = useRef(false);
  const theaterRef = useRef(false);
  const freshChatTimer = useRef(null);
  const theaterChatResizeActiveRef = useRef(false);
  const compactTimerRef = useRef(null);
  const playSound = useRoomSounds();
  const createPayload = pendingCreateRef.current;

  useEffect(() => { theaterChatOpenRef.current = theaterChatOpen; }, [theaterChatOpen]);
  useEffect(() => { theaterRef.current = theater; }, [theater]);
  useEffect(() => {
    const update = () => { setCompactToolbar(window.innerWidth <= 820); if (window.innerWidth > 820) setCompactControl(""); };
    addEventListener("resize", update);
    return () => { removeEventListener("resize", update); clearTimeout(compactTimerRef.current); };
  }, []);

  useEffect(() => {
    const socket = new RoomSocket();
    socketRef.current = socket;
    const sendInitialContent = () => {
      const pending = pendingCreateRef.current;
      if (!pending?.content || contentCommandSent.current) return;
      contentCommandSent.current = socket.command("room-content-select", { content: { ...pending.content, provider: pending.provider } });
    };
    const offState = socket.on("room-state", (nextRoom) => {
      const nextIds = new Set((nextRoom?.participants || []).map((participant) => participant.userId));
      if (previousParticipants.current.size && [...nextIds].some((id) => id !== user.userId && !previousParticipants.current.has(id))) playSound("join");
      previousParticipants.current = nextIds;
      setRoom(nextRoom);
    });
    const offChat = socket.on("chat-message", (message) => {
      if (message?.userId && message.userId !== user.userId) {
        playSound("chat");
        setFreshChatId(message.id || `${message.userId}:${message.createdAt || Date.now()}`);
        clearTimeout(freshChatTimer.current);
        freshChatTimer.current = setTimeout(() => setFreshChatId(""), 2800);
        if (theaterRef.current && !theaterChatOpenRef.current) setTheaterChatUnread(true);
      }
      setMessages((old) => [...old.slice(-49), message]);
    });
    const offAction = socket.on("room-action", (action) => notify(action?.message || "Room updated."));
    const offGuestRevoked = socket.on("guest-revoked", (payload) => { notify(payload?.reason || "You were removed from this room."); socket.close(); onBack(); });
    const offError = socket.on("error", notify);
    const offDenied = socket.on("permission-denied", (payload) => notify(payload?.reason || "That room action was not accepted."));
    const offConnection = socket.on("connection", (status) => { setConnection(status); if (status === "connected") sendInitialContent(); });
    socket.connect({
      roomId, user, creating: Boolean(createPayload), roomName: createPayload?.roomName,
      visibility: "private", room: createPayload ? {
        roomId,
        roomName: createPayload.roomName,
        visibility: "private",
        selectedContent: createPayload.content ? { ...createPayload.content, provider: createPayload.provider } : null
      } : null
    }).catch((error) => notify(error.message));
    return () => { clearTimeout(freshChatTimer.current); offState(); offChat(); offAction(); offGuestRevoked(); offError(); offDenied(); offConnection(); socket.close(); };
  }, [playSound, roomId, user.userId]);

  useEffect(() => {
    const pending = pendingCreateRef.current;
    if (!room || !pending?.content) return;
    const mine = room.participants?.find((participant) => participant.userId === user.userId);
    const selected = room.selectedContent;
    const providerMatches = !pending.provider || selected?.provider?.id === pending.provider.id || selected?.provider?.destination === pending.provider.destination;
    if (selected?.id === String(pending.content.id) && providerMatches) {
      sessionStorage.removeItem(`havyn-web:create:${roomId}`);
      pendingCreateRef.current = null;
      if (openInviteAfterCreate) { setInviteOpen(true); setOpenInviteAfterCreate(false); }
      return;
    }
    if (!selected && mine?.role === "host" && !contentCommandSent.current) {
      contentCommandSent.current = true;
      socketRef.current?.command("room-content-select", { content: { ...pending.content, provider: pending.provider } });
    }
  }, [openInviteAfterCreate, room, roomId, user.userId]);

  useEffect(() => {
    if (!inviteOpen || !supabase || user.guest) return;
    loadHavynFriends(user.userId).then(setFriends);
  }, [inviteOpen, user.userId]);

  useEffect(() => {
    if (!room || room.hostUserId !== user.userId || !supabase || user.guest) return;
    ensureRoomProjection(room, user).catch((error) => console.warn("Could not project Havyn room for invitations", error));
  }, [room?.hostUserId, room?.playbackMode, room?.roomId, room?.roomName, room?.selectedContent?.id, user.userId]);

  useEffect(() => {
    if (user.guest || !room) return undefined;
    let idleTimer;
    const currentState = () => room.selectedContent?.title ? "watching" : "online";
    const publish = (state) => publishPresence(user, { state, roomId, title: state === "watching" ? room.selectedContent?.title : "" });
    const active = () => { clearTimeout(idleTimer); publish(currentState()); idleTimer = setTimeout(() => publish("idle"), 5 * 60_000); };
    const visibility = () => document.hidden ? publish("idle") : active();
    active(); document.addEventListener("visibilitychange", visibility); window.addEventListener("pointerdown", active); window.addEventListener("keydown", active);
    const heartbeat = setInterval(() => publish(document.hidden ? "idle" : currentState()), 45_000);
    return () => { clearTimeout(idleTimer); clearInterval(heartbeat); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pointerdown", active); window.removeEventListener("keydown", active); publishPresence(user, { state: "online" }); };
  }, [room?.selectedContent?.title, roomId, user.guest, user.userId]);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === roomPageRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  useEffect(() => {
    if (!theater) { setTheaterIdle(false); return undefined; }
    let timer;
    const resetIdle = () => {
      setTheaterIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setTheaterIdle(true), 3000);
    };
    window.addEventListener("pointermove", resetIdle);
    window.addEventListener("pointerdown", resetIdle);
    resetIdle();
    return () => { clearTimeout(timer); window.removeEventListener("pointermove", resetIdle); window.removeEventListener("pointerdown", resetIdle); };
  }, [theater]);

  const content = room?.selectedContent;
  const role = room?.participants?.find((participant) => participant.userId === user.userId)?.role;
  const localParticipant = room?.participants?.find((participant) => participant.userId === user.userId);
  const mediaSessionId = room?.playbackState?.mediaSessionId || "";
  const waitingForRoomStart = room?.playbackState?.sessionStartedAt === null;
  const showSyncReadyOverlay = Boolean(mediaSessionId && syncReady && localParticipant?.syncStatus === "synced" && (waitingForRoomStart || syncNeedsGesture));
  const canChoose = role === "host" || role === "cohost";
  const canControl = role === "host" || (role === "cohost" && room?.playbackMode === "host-and-cohosts") || room?.playbackMode === "everyone";
  const copy = async () => { await navigator.clipboard.writeText(`${location.origin}${location.pathname}#room=${roomId}`); notify("Room link copied."); };
  const copyCode = async () => { await navigator.clipboard.writeText(roomId); notify("Room code copied."); };
  const send = (event) => { event.preventDefault(); if (text.trim()) { socketRef.current.command("chat-message", { message: text.trim() }); setText(""); } };
  const selectContent = (item, provider) => { socketRef.current.command("room-content-select", { content: { ...item, provider } }); setChooseOpen(false); };
  const inviteFriend = async (friendId) => {
    if (user.guest) return notify("Guest rooms can be shared by room link or code.");
    if (!room || room.hostUserId !== user.userId) return notify("Only the host can send invitations.");
    const projectionError = await ensureRoomProjection(room, user);
    if (projectionError) return notify(`Invite setup failed: ${projectionError.message || "room record unavailable"}`);
    const { error } = await supabase.from("room_invites").upsert({ room_id: roomId, inviter_user_id: user.userId, invitee_user_id: friendId, status: "pending", created_at: new Date().toISOString(), responded_at: null }, { onConflict: "room_id,inviter_user_id,invitee_user_id" });
    notify(error ? `Invite could not be sent: ${error.message || "unknown error"}` : "Invite sent.");
  };
  const beginResize = (event) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX; const startWidth = railWidth;
    document.body.classList.add("room-resizing", "is-resizing");
    const move = (moveEvent) => setRailWidth(Math.min(520, Math.max(280, startWidth - (moveEvent.clientX - startX))));
    const end = () => { handle.releasePointerCapture?.(event.pointerId); document.body.classList.remove("room-resizing", "is-resizing"); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", end); document.removeEventListener("pointercancel", end); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", end); document.addEventListener("pointercancel", end);
  };
  const beginTheaterResize = (event) => {
    if (!theater) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const startY = event.clientY; const startHeight = theaterCallHeight;
    document.body.classList.add("room-resizing", "is-resizing");
    const move = (moveEvent) => setTheaterCallHeight(Math.max(132, Math.min(Math.floor(window.innerHeight * .58), startHeight - (moveEvent.clientY - startY))));
    const end = () => { handle.releasePointerCapture?.(event.pointerId); document.body.classList.remove("room-resizing", "is-resizing"); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", end); document.removeEventListener("pointercancel", end); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", end); document.addEventListener("pointercancel", end);
  };
  const beginNormalCallResize = (event) => {
    if (theater) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const startY = event.clientY; const startHeight = normalCallHeight;
    document.body.classList.add("room-resizing", "is-resizing");
    const move = (moveEvent) => setNormalCallHeight(Math.max(168, Math.min(Math.floor(window.innerHeight * .48), startHeight + (moveEvent.clientY - startY))));
    const end = () => { handle.releasePointerCapture?.(event.pointerId); document.body.classList.remove("room-resizing", "is-resizing"); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", end); document.removeEventListener("pointercancel", end); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", end); document.addEventListener("pointercancel", end);
  };
  const beginTheaterChatResize = (event) => {
    if (!theater || !theaterChatOpen || theaterChatResizeActiveRef.current) return;
    event.preventDefault();
    theaterChatResizeActiveRef.current = true;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX; const startWidth = theaterChatWidth;
    document.body.classList.add("room-resizing", "is-resizing");
    const move = (moveEvent) => setTheaterChatWidth(Math.max(250, Math.min(520, startWidth - (moveEvent.clientX - startX))));
    const end = () => { theaterChatResizeActiveRef.current = false; handle.releasePointerCapture?.(event.pointerId); document.body.classList.remove("room-resizing", "is-resizing"); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", end); document.removeEventListener("pointercancel", end); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", end); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", end); document.addEventListener("pointercancel", end);
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", end);
  };
  useEffect(() => { localStorage.setItem("havyn-web:room-rail-width", String(railWidth)); }, [railWidth]);
  useEffect(() => { localStorage.setItem("havyn-web:normal-call-height", String(normalCallHeight)); }, [normalCallHeight]);
  useEffect(() => { localStorage.setItem("havyn-web:theater-call-height", String(theaterCallHeight)); }, [theaterCallHeight]);
  useEffect(() => { localStorage.setItem("havyn-web:theater-chat-width", String(theaterChatWidth)); }, [theaterChatWidth]);
  useEffect(() => { if (theaterChatOpen) setTheaterChatUnread(false); }, [theaterChatOpen]);
  const toggleFullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else { setTheater(true); await roomPageRef.current?.requestFullscreen(); } }
    catch { notify("Fullscreen is not available in this browser."); }
  };
  const revealCompactControl = (name, action) => {
    if (!compactToolbar || compactControl === name) { setCompactControl(""); action(); return; }
    setCompactControl(name);
    clearTimeout(compactTimerRef.current);
    compactTimerRef.current = setTimeout(() => setCompactControl(""), 2600);
  };
  const handleSyncAvailability = useCallback(({ ready, startPlayback, needsGesture, startLocally }) => {
    setSyncReady(ready);
    setStartSyncedPlayback(() => startPlayback || null);
    setSyncNeedsGesture(Boolean(needsGesture));
    setStartLocalPlayback(() => startLocally || null);
  }, []);

  return <section ref={roomPageRef} className={`room-page ${roomStyles.roomPage}${user.guest ? " guest-room" : ""}${theater ? ` theater-mode ${roomStyles.theater}` : ""}${fullscreen ? " is-fullscreen" : ""}`}>
    <header className="room-header"><button className="back-button" onClick={onBack} aria-label="Back to Discover" title="Discover"><ArrowLeft /></button><div><h1>{content?.title || room?.roomName || createPayload?.roomName || "Loading room..."}</h1></div><div className="room-command-bar"><span className={`connection ${connection}`}>{connection}</span>{canChoose && <button className={`button subtle room-change-button compact-command${compactControl === "title" ? " control-expanded" : ""}`} onClick={() => revealCompactControl("title", () => setChooseOpen(true))}><Sparkles size={16}/><span className="control-label">Change title</span></button>}<button className={`icon-command${theater ? " active" : ""}`} onClick={() => setTheater((value) => !value)} title="Toggle theater mode"><MonitorUp size={17}/></button><button className="icon-command" onClick={toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button><PlaybackModeMenu mode={room?.playbackMode || "host-only"} disabled={role !== "host"} onChange={(playbackMode) => socketRef.current?.command("room-playback-mode", { playbackMode })}/><button className={`room-code-button compact-command${compactControl === "code" ? " control-expanded" : ""}`} onClick={() => revealCompactControl("code", copyCode)} title="Copy room code"><span>Code</span><strong>{roomId}</strong><Copy size={14}/></button><button className={`button subtle compact-command${compactControl === "invite" ? " control-expanded" : ""}`} onClick={() => revealCompactControl("invite", () => setInviteOpen(true))}><UserPlus size={16}/><span className="control-label">Invite</span></button><PeopleMenu participants={room?.participants || []} quality={connectionQuality} role={role} onRoleChange={(targetUserId, nextRole) => socketRef.current?.command("room-role-update", { targetUserId, role: nextRole })} onRemoveGuest={(targetUserId) => socketRef.current?.command("room-guest-revoke", { targetUserId })}/></div></header>
    <main className={`room-layout ${roomStyles.roomLayout}${theater ? ` ${roomStyles.isTheater}` : ""}${theaterChatOpen ? ` theater-chat-open ${roomStyles.chatOpen}` : ""}${theaterChatUnread ? ` ${roomStyles.chatUnread}` : ""}${theaterIdle ? ` ${roomStyles.idle}` : ""}${room?.playbackState?.isPlaying !== true ? ` ${roomStyles.paused}` : ""}`} style={{ "--room-rail-width": `${railWidth}px`, "--normal-call-height": `${normalCallHeight}px`, "--theater-call-height": `${theaterCallHeight}px`, "--theater-chat-width-open": `${theaterChatWidth}px`, "--theater-chat-width": theaterChatOpen ? `min(${theaterChatWidth}px, ${window.innerWidth <= 960 ? 72 : 42}vw)` : "42px" }}>
      <section className={`provider-stage ${roomStyles.providerStage}`}>
        {content ? <ProviderStage key={`${content.id}:${content.provider?.id || "none"}:${content.provider?.destination || ""}`} content={content} room={room} userId={user.userId} socket={socketRef.current} canControl={canControl} canChoose={canChoose} onChoose={() => setChooseOpen(true)} onSyncAvailability={handleSyncAvailability} notify={notify} /> : <EmptyProvider canChoose={canChoose} onChoose={() => setChooseOpen(true)} />}
        {showSyncReadyOverlay && <div className="sync-ready-overlay" role="status"><div className="sync-ready-dialog"><Signal size={42}/><h2>{syncNeedsGesture ? "Start playback" : "Room synced"}</h2><p>{syncNeedsGesture ? "Your browser needs one click to begin playback." : canControl ? "Ready to start together." : "Waiting for the host to start playback."}</p>{syncNeedsGesture ? <button className="button primary sync-ready-play" type="button" onClick={() => startLocalPlayback?.()}><Play size={16} fill="currentColor"/> Start on this device</button> : canControl && <button className="button primary sync-ready-play" type="button" onClick={() => startSyncedPlayback?.()}><Play size={16} fill="currentColor"/> Play together</button>}<small>{syncNeedsGesture ? "This does not change the room timeline." : "This closes for everyone when playback begins."}</small></div></div>}
      </section>
      <button className={`room-resize-handle ${roomStyles.resizeRail}${theater ? ` ${roomStyles.theaterResizeRail}` : ""}`} onPointerDown={theater ? beginTheaterResize : beginResize} aria-label={theater ? "Resize call strip" : "Resize room panels"} />
      <aside className={`room-sidebar ${roomStyles.roomSidebar}${callDockActive ? ` ${roomStyles.callDockActive}` : ""}`}>
        <CallPanel room={room} user={user} socket={socketRef.current} notify={notify} theater={theater} idle={theaterIdle} paused={room?.playbackState?.isPlaying !== true} onConnectionQuality={setConnectionQuality} onCallStateChange={setCallDockActive} onDockResize={beginNormalCallResize} />
        <section className={`chat-panel ${roomStyles.chatPanel}${freshChatId ? ` ${roomStyles.chatAttention}` : ""}${theater ? ` theater-chat-panel ${roomStyles.theaterChat}` : ""}`}><button className={`${roomStyles.chatResize}${theaterChatOpen ? ` ${roomStyles.visible}` : ""}`} type="button" onPointerDown={beginTheaterChatResize} onMouseDown={beginTheaterChatResize} aria-label="Resize chat panel" /><button className={`theater-chat-toggle ${roomStyles.chatToggle}`} type="button" aria-expanded={theaterChatOpen} onClick={() => { setTheaterChatOpen((value) => !value); setTheaterChatUnread(false); }} title={theaterChatOpen ? "Collapse chat" : "Open chat"} aria-label={theaterChatOpen ? "Collapse chat" : "Open chat"}>{theaterChatOpen ? <ChevronRight size={18}/> : <ChevronLeft size={18}/>}</button><div className={`chat-panel-body ${roomStyles.chatBody}`}><div className="section-heading"><h2>Chat</h2><MessageCircle size={18}/></div><div className="messages">{messages.map((message, index) => <p className={message.id === freshChatId ? roomStyles.freshMessage : ""} key={message.id || index}><strong>{message.displayName || "Havyn"}</strong>{message.message || message.text}</p>)}</div><form onSubmit={send}><input value={text} onChange={(event) => setText(event.target.value)} placeholder="Message the room" /><button aria-label="Send"><Send size={17}/></button></form></div></section>
      </aside>
    </main>
    {chooseOpen && <RoomTitlePicker onClose={() => setChooseOpen(false)} onSelect={selectContent} />}
    {inviteOpen && <InviteModal friends={user.guest ? [] : friends} guest={user.guest} roomId={roomId} onCopy={copy} onInvite={inviteFriend} onClose={() => setInviteOpen(false)} />}
  </section>;
}

async function ensureRoomProjection(room, user) {
  if (!supabase || !room?.roomId || !user?.userId || room.hostUserId !== user.userId) return { message: "Host room projection is unavailable." };
  const content = room.selectedContent;
  const { error } = await supabase.from("rooms").upsert({
    id: room.roomId,
    name: room.roomName || "Movie Night",
    host_user_id: user.userId,
    playback_mode: room.playbackMode || "host-only",
    visibility: room.visibility === "public" ? "public" : "private",
    active_media_url: content?.provider?.destination || null,
    active_media_title: content?.title || null,
    active_media_state: room.playbackState || null,
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }, { onConflict: "id" });
  return error;
}

function readCreatePayload(roomId) { try { return JSON.parse(sessionStorage.getItem(`havyn-web:create:${roomId}`) || "null"); } catch { sessionStorage.removeItem(`havyn-web:create:${roomId}`); return null; } }

function InviteModal({ friends, guest, onClose, onCopy, onInvite }) { return <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="invite-modal"><button className="icon-close" onClick={onClose}><X /></button><p className="eyebrow">INVITE TO ROOM</p><h2>Watch together</h2><p>{guest ? "Share this private link or room code. Guest rooms do not use friend invitations." : "Send a Havyn invite, or share the private room link."}</p><button className="button subtle full" onClick={onCopy}><Copy size={16}/> Copy room link</button><div className="invite-friends">{friends.length ? friends.map((friend) => <button key={friend.userId} onClick={() => onInvite(friend.userId)}><span className="avatar">{friend.displayName.slice(0, 1)}</span><span><strong>{friend.displayName}</strong><small>{friend.username ? `@${friend.username}` : "Havyn friend"}</small></span><UserPlus size={16}/></button>) : <p className="empty-copy">{guest ? "Anyone with the room link or code can join as a guest." : "No friends yet. Share the room link or add friends from the desktop app."}</p>}</div></section></div>; }

const modeLabels = { "host-only": "Host only", "host-and-cohosts": "Host & cohosts", everyone: "Everyone" };
function PlaybackModeMenu({ mode, disabled, onChange }) { const { ref, close } = useDismissibleDetails(); return <details ref={ref} className={`mode-menu${disabled ? " disabled" : ""}`}><summary><ShieldCheck size={15}/><span>{modeLabels[mode]}</span><ChevronDown size={14}/></summary><div className="room-menu-popover">{Object.entries(modeLabels).map(([value, label]) => <button key={value} className={mode === value ? "active" : ""} disabled={disabled} onClick={() => { onChange(value); close(); }}><strong>{label}</strong><small>{value === "host-only" ? "Only the host controls playback" : value === "host-and-cohosts" ? "Host and cohosts control playback" : "Anyone in the room can control playback"}</small></button>)}</div></details>; }
function ConnectionIndicator({ quality = "checking" }) { const labels = { good: "Stable connection", fair: "Usable connection", poor: "Unstable connection", checking: "Connection is being measured" }; return <span className={`connection-indicator ${quality}`} title={labels[quality]}><Signal size={14}/></span>; }
function PeopleMenu({ participants, quality, role, onRoleChange, onRemoveGuest }) { const { ref, close } = useDismissibleDetails(); return <details ref={ref} className="people-menu"><summary aria-label="Open people list"><Users size={16}/><span className="people-label">People</span><b>{participants.length}</b><ChevronDown size={14}/></summary><div className="room-menu-popover people-popover"><div className="people-popover-heading"><strong>In this room</strong><span>{participants.length}</span></div>{participants.map((participant) => <div className="participant" key={participant.userId}><span className="avatar">{participant.displayName.slice(0, 1)}</span><div><strong>{participant.displayName}</strong><small>{participant.guest ? `${participant.role} · guest` : participant.role}</small></div><ConnectionIndicator quality={quality[participant.userId] || "checking"}/>{role === "host" && participant.role !== "host" ? <span className="participant-actions"><button className="role-button" onClick={() => { onRoleChange(participant.userId, participant.role === "cohost" ? "viewer" : "cohost"); close(); }}>{participant.role === "cohost" ? "Remove cohost" : "Make cohost"}</button>{participant.guest && <button className="role-button danger" onClick={() => { onRemoveGuest(participant.userId); close(); }}>Remove</button>}</span> : <i className={participant.online ? "online" : ""}/>}</div>)}</div></details>; }

// Provider playback owns the room's primary sound. Keep every incoming call
// stream noticeably beneath it, even when multiple people are connected.
const CALL_MIX_DEFAULT = 0.2;
const CALL_MIX_MAX = 0.7;

function MediaTile({ stream, label, quality, muted = false, spotlighted, onSpotlight }) {
  const ref = useRef(null); const [volume, setVolume] = useState(CALL_MIX_DEFAULT); const [volumeOpen, setVolumeOpen] = useState(false); const [playBlocked, setPlayBlocked] = useState(false);
  const startPlayback = useCallback(() => { const video = ref.current; if (!video) return; void video.play().then(() => setPlayBlocked(false)).catch(() => setPlayBlocked(!muted)); }, [muted]);
  useEffect(() => { if (ref.current) { ref.current.srcObject = stream; ref.current.volume = volume; startPlayback(); } }, [startPlayback, stream, volume]);
  return <div className={`call-tile ${roomStyles.callTile}${spotlighted ? ` spotlighted ${roomStyles.spotlighted}` : ""}`}><video ref={ref} autoPlay muted={muted} playsInline onCanPlay={startPlayback}/>{playBlocked && <button className="call-playback-recovery" type="button" onClick={startPlayback}><Play size={15} fill="currentColor"/> Start call audio</button>}<div className={roomStyles.tileIdentity}><span>{label}</span><ConnectionIndicator quality={quality}/></div><button className={`tile-spotlight ${roomStyles.spotlightButton}`} type="button" onClick={onSpotlight} title={spotlighted ? `Stop spotlighting ${label}` : `Spotlight ${label}`} aria-label={spotlighted ? `Stop spotlighting ${label}` : `Spotlight ${label}`}><Maximize2 size={14}/></button>{!muted && <div className={`tile-volume${volumeOpen ? " open" : ""}`}><button type="button" aria-label={`Adjust ${label} call volume`} onClick={() => setVolumeOpen((value) => !value)}>{volume === 0 ? <VolumeX size={14}/> : <Volume2 size={14}/>}</button><input aria-label={`${label} call volume`} type="range" min="0" max={CALL_MIX_MAX} step=".05" value={volume} onChange={(event) => setVolume(Number(event.target.value))}/></div>}</div>;
}

function CallPanel({ room, user, socket, notify, theater, idle, paused, onConnectionQuality, onCallStateChange, onDockResize }) {
  const { joined, muted, cameraOff, localStream, remoteStreams, connectionQuality, join, leave, toggleMute, toggleCamera } = useRoomCall({ room, user, socket, notify });
  useEffect(() => onConnectionQuality(connectionQuality), [connectionQuality, onConnectionQuality]);
  useEffect(() => onCallStateChange?.(joined), [joined, onCallStateChange]);
  const inCall = room?.participants?.filter((participant) => participant.callStatus === "connected") || [];
  const names = new Map((room?.participants || []).map((participant) => [participant.userId, participant.displayName]));
  const [spotlight, setSpotlight] = useState("");
  const [spotlightOffset, setSpotlightOffset] = useState({ x: 0, y: 0 });
  const [trackOffset, setTrackOffset] = useState(() => Number(localStorage.getItem("havyn-web:theater-call-offset")) || 0);
  const draggingRef = useRef(false);
  const tiles = [{ id: user.userId, stream: localStream, quality: connectionQuality[user.userId], label: "You", muted: true }, ...remoteStreams.map((item) => ({ id: item.userId, stream: item.stream, quality: connectionQuality[item.userId], label: names.get(item.userId) || "Havyn user" }))].slice(0, 4);
  const activeSpotlight = tiles.some((tile) => tile.id === spotlight) ? spotlight : "";
  useEffect(() => { localStorage.setItem("havyn-web:theater-call-offset", String(trackOffset)); }, [trackOffset]);
  const beginTrackDrag = (event) => {
    if (!theater || draggingRef.current || event.target.closest("button, input")) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX; const startY = event.clientY; const startOffset = trackOffset; const startSpotlight = spotlightOffset;
    draggingRef.current = true;
    const isSpotlightTile = activeSpotlight && event.target.closest(".spotlighted");
    const move = (moveEvent) => {
      if (isSpotlightTile) setSpotlightOffset({ x: Math.max(-220, Math.min(220, startSpotlight.x + moveEvent.clientX - startX)), y: Math.max(-70, Math.min(70, startSpotlight.y + moveEvent.clientY - startY)) });
      else setTrackOffset(startOffset + moveEvent.clientX - startX);
    };
    const end = () => { draggingRef.current = false; handle.releasePointerCapture?.(event.pointerId); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", end); document.removeEventListener("pointercancel", end); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", end); document.addEventListener("pointercancel", end);
  };
  return <section className={`call-panel ${roomStyles.callPanel}${joined ? ` call-active ${roomStyles.callActive}` : ""}${theater ? ` theater-call ${roomStyles.theaterFilmstrip}${idle && !paused ? ` ${roomStyles.idle}` : ""}` : ""}`}><div className="section-heading"><h2>Call</h2><span>{inCall.length ? `${inCall.length}/4` : "Optional"}</span></div>{joined ? <><div className={roomStyles.callMediaSurface} onPointerDown={beginTrackDrag} onMouseDown={beginTrackDrag}><div className={`call-grid ${roomStyles.callGrid} ${roomStyles[`callCount${tiles.length}`] || ""}${activeSpotlight ? ` spotlight-active ${roomStyles.hasSpotlight}` : ""}`} style={theater ? { "--theater-track-offset": `${trackOffset}px`, "--spotlight-offset-x": `${spotlightOffset.x}px`, "--spotlight-offset-y": `${spotlightOffset.y}px` } : undefined}>{tiles.map((tile) => <MediaTile key={tile.id} {...tile} spotlighted={activeSpotlight === tile.id} onSpotlight={() => { setSpotlight((value) => value === tile.id ? "" : tile.id); setSpotlightOffset({ x: 0, y: 0 }); }} />)}</div><div className={`call-actions ${roomStyles.callActionsOverlay}`}><button onClick={toggleMute} aria-label="Toggle microphone">{muted ? <MicOff size={16}/> : <Mic size={16}/>}</button><button onClick={toggleCamera} aria-label="Toggle camera">{cameraOff ? <VideoOff size={16}/> : <Video size={16}/>}</button><button onClick={leave}>Leave</button></div></div>{!theater && <button className={roomStyles.callDockResize} type="button" aria-label="Resize call dock" onPointerDown={onDockResize} />}</> : <button className="join-call" onClick={join}><Camera size={16}/> Join call</button>}</section>;
}

function ProviderStage({ content, room, userId, socket, canControl, canChoose, onChoose, onSyncAvailability, notify }) {
  const [embedded, setEmbedded] = useState(content.provider?.kind === "embed");
  const [guardEnabled, setGuardEnabled] = useState(false);
  const iframeRef = useRef(null);
  const [youtubeContainer, setYoutubeContainer] = useState(null);
  const providerPlayback = useProviderPlayback({ provider: content.provider, iframeRef, socket, room, userId, canControl, notify });
  const { status, onFrameLoad } = providerPlayback;
  const isYouTube = content.provider?.adapterId === "youtube"
    || content.provider?.id === "youtube"
    || /^https:\/\/(www\.)?youtube(?:-nocookie)?\.com\//.test(content.provider?.destination || "");
  const isYouTubeBrowse = content.provider?.id === "youtube-browse";
  const youtube = useYouTubePlayback({ enabled: isYouTube, container: youtubeContainer, videoId: content.id, socket, room, userId, canControl, notify });
  useEffect(() => {
    setEmbedded(content.provider?.kind === "embed");
  }, [content.provider?.id, content.provider?.destination, content.provider?.kind]);
  useEffect(() => {
    const syncStatus = isYouTube ? youtube.status : status;
    const ready = (content.provider?.capability === "synced" || isYouTube) && syncStatus === "ready";
    const startPlayback = isYouTube ? youtube.startPlayback : providerPlayback.startPlayback;
    const startLocally = isYouTube ? youtube.startLocally : providerPlayback.startLocally;
    const needsGesture = isYouTube ? youtube.needsGesture : providerPlayback.needsGesture;
    onSyncAvailability?.({ ready, startPlayback: ready ? startPlayback : null, startLocally: ready ? startLocally : null, needsGesture });
    return () => onSyncAvailability?.({ ready: false, startPlayback: null, startLocally: null, needsGesture: false });
  }, [content.provider?.capability, isYouTube, onSyncAvailability, providerPlayback.needsGesture, providerPlayback.startLocally, providerPlayback.startPlayback, status, youtube.needsGesture, youtube.startLocally, youtube.startPlayback, youtube.status]);
  const hasEmbeddedProvider = embedded && Boolean(content.provider?.destination);
  const syncStatus = isYouTube ? youtube.status : status;
  const externalDestination = isYouTube ? `https://www.youtube.com/watch?v=${encodeURIComponent(content.id)}` : content.provider?.destination;
  return <div className={`provider-stage-content${hasEmbeddedProvider ? " is-embedded" : ""}`}>
    {content.backdropUrl && <img className="stage-backdrop" src={content.backdropUrl} alt="" />}
    <div className="stage-overlay"><p className="eyebrow">NOW PLAYING</p><h2>{content.title}</h2><p>{content.overview || "Your room is ready."}</p>
      {content.provider ? <><span className={`provider-chip ${content.provider.capability === "synced" ? "synced" : ""}`}>{content.provider.name} · {content.provider.capability === "synced" ? syncStatus === "ready" ? "Synced playback" : "Connecting sync" : "Manual sync"}</span><div className="stage-actions"><a className="button primary" href={externalDestination} target="_blank" rel="noreferrer"><ExternalLink size={17}/> Open {content.provider.name}</a><button className="button subtle" onClick={() => setEmbedded((value) => !value)}>{embedded ? "Hide embedded view" : "Try embedded view"}</button></div>{embedded && content.provider.kind === "embed" && !isYouTube && <label className="guard-toggle"><ShieldCheck size={16}/><span>Ad & pop-up guard</span><input type="checkbox" checked={guardEnabled} onChange={(event) => setGuardEnabled(event.target.checked)} /><i /></label>}<small className="provider-note">{isYouTube ? "Open YouTube once to sign in. Your browser, not Havyn, remembers that session." : content.provider.capability === "synced" ? "Havyn observes and applies playback changes through this provider's dedicated adapter." : "Every participant uses their own authorised provider session where required."}</small></> : <p className="empty-copy">No provider chosen yet. The room, chat, and invitations stay available while you choose one.</p>}
      {canChoose && <button className="link-action" onClick={onChoose}><Sparkles size={16}/> Choose a different title or provider</button>}
    </div>
    {embedded && isYouTubeBrowse && <YouTubeBrowseSurface canChoose={canChoose} socket={socket} notify={notify} />}
    {embedded && isYouTube && <div ref={setYoutubeContainer} className="youtube-player" aria-label={`${content.title} YouTube player`} />}
    {embedded && !isYouTube && !isYouTubeBrowse && content.provider?.destination && <iframe ref={iframeRef} title={content.title} src={content.provider.destination} onLoad={onFrameLoad} {...(guardEnabled ? { sandbox: "allow-scripts allow-forms allow-same-origin" } : {})} allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowFullScreen />}
  </div>;
}

function YouTubeBrowseSurface({ canChoose, socket, notify }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const directId = youtubeVideoId(query);
  useEffect(() => {
    const value = query.trim();
    if (!value || directId) { setResults([]); setError(""); return undefined; }
    const timer = setTimeout(() => {
      setLoading(true);
      searchYouTube(value).then((items) => { setResults(items); setError(""); }).catch((reason) => { setResults([]); setError(reason.message || "YouTube search is unavailable."); }).finally(() => setLoading(false));
    }, 280);
    return () => clearTimeout(timer);
  }, [directId, query]);
  const selectVideo = (item) => {
    if (!canChoose) { notify("Only the host or a cohost can choose the shared video."); return; }
    socket?.command("room-content-select", { content: { ...item, mediaType: "movie", provider: youtubeProvider(item.id) } });
  };
  return <section className="youtube-browse-surface" aria-label="Browse YouTube">
    <header><span className="youtube-mark"><YouTubeLogo/></span><div><p className="eyebrow">YOUTUBE IN HAVYN</p><h2>Choose what to watch together</h2><p>Search YouTube here, then Havyn opens the official shared player in this room.</p></div></header>
    <label className="youtube-browse-search"><Search size={19}/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search YouTube or paste a video link" /></label>
    {directId && <button className="youtube-browse-direct" type="button" onClick={() => selectVideo({ id: directId, title: "YouTube video", overview: "", posterUrl: "" })}><YouTubeLogo className="youtube-inline-logo"/><span><strong>Watch this video</strong><small>Use the pasted YouTube link</small></span><ChevronRight size={17}/></button>}
    {loading && <p className="youtube-browse-status">Searching YouTube...</p>}
    {error && <p className="youtube-browse-status error">{error}</p>}
    {!query && <p className="youtube-browse-empty">Search for a creator, a video, or paste a YouTube link to choose the room's next watch.</p>}
    {results.length > 0 && <div className="youtube-browse-results">{results.map((item) => <button key={item.id} type="button" onClick={() => selectVideo(item)}>{item.posterUrl ? <img src={item.posterUrl} alt="" /> : <span className="youtube-result-fallback"><YouTubeLogo/></span>}<span><strong>{item.title}</strong><small>{item.channelTitle || "YouTube"}</small><em>{item.overview || "YouTube video"}</em></span><ChevronRight size={17}/></button>)}</div>}
  </section>;
}

function EmptyProvider({ canChoose, onChoose }) {
  return <div className="empty-provider"><Film size={46}/><h2>This room is ready.</h2><p>Choose a movie or series and a provider. The room stays here even if the provider changes.</p>{canChoose && <button className="button primary" onClick={onChoose}><Search size={17}/> Choose a title</button>}</div>;
}

function RoomTitlePicker({ onClose, onSelect }) {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [providers, setProviders] = useState(null);
  const [query, setQuery] = useState("");
  const [mediaType, setMediaType] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [youtubeOpen, setYoutubeOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const data = await discover({ query, type: mediaType, page: 1 });
        if (!cancelled) setItems(data.results);
      } catch (requestError) {
        if (!cancelled) {
          setItems([]);
          setError(requestError instanceof Error ? requestError.message : "Could not load titles right now.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 220 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, mediaType, retryKey]);

  const choose = async (item) => {
    setSelected(item);
    setProviders(null);
    try {
      setProviders(await getProviders(item));
    } catch {
      setProviders([]);
    }
  };
  if (youtubeOpen) return <YouTubeModal onClose={() => setYoutubeOpen(false)} onCreate={(content) => onSelect({ ...content, mediaType: "movie" }, youtubeProvider(content.id))} onBrowse={() => onSelect({ id: "youtube-browse", mediaType: "movie", title: "YouTube", overview: "Browse YouTube together, then choose a video to sync.", posterUrl: "", backdropUrl: "" }, youtubeBrowseProvider())} />;
  if (selected) return <ProviderModal content={selected} providers={providers} onClose={onClose} onCreate={onSelect} />;
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="room-title-picker-heading"><section className="picker-modal">
    <button className="icon-close" onClick={onClose} aria-label="Close title picker"><X/></button>
    <p className="eyebrow">ROOM CONTENT</p><h2 id="room-title-picker-heading">Choose a new title</h2>
    <div className="picker-toolbar">
      <label className="picker-search"><Search size={16}/><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search movies and series" /></label>
      <div className="picker-type-list" role="group" aria-label="Title type">
        {[['all', 'All'], ['movie', 'Movies'], ['tv', 'Series']].map(([value, label]) => <button key={value} className={mediaType === value ? 'active' : ''} onClick={() => setMediaType(value)}>{label}</button>)}<button className="youtube-picker-action" type="button" onClick={() => setYoutubeOpen(true)}><YouTubeLogo className="youtube-inline-logo"/><span>YouTube</span></button>
      </div>
    </div>
    {loading ? <div className="picker-status"><Film size={25}/><p>Finding titles...</p></div>
      : error ? <div className="picker-status picker-error"><p>{error}</p><button className="button subtle" onClick={() => setRetryKey((value) => value + 1)}>Try again</button></div>
      : items.length ? <div className="picker-grid">{items.map((item) => <button key={`${item.mediaType}-${item.id}`} onClick={() => choose(item)}>{item.posterUrl ? <img src={item.posterUrl} alt="" /> : <div className="picker-poster-fallback"><Film /></div>}<span>{item.title}<small>{item.year || (item.mediaType === 'tv' ? 'Series' : 'Movie')}</small></span></button>)}</div>
      : <div className="picker-status"><Film size={25}/><p>No titles found. Try another search or title type.</p></div>}
  </section></div>;
}

function YouTubeLogo({ className = "" }) { return <img className={`youtube-logo ${className}`.trim()} src={youtubeLogo} alt="" aria-hidden="true" />; }
function Mark() { return <span className="mark" aria-hidden="true" />; }
