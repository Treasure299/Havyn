import { ArrowRight, Check, Clock3, Film, Globe2, HelpCircle, LogOut, Menu, Newspaper, Plus, Save, Send, Sparkles, UserPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import BackgroundVideo from "./BackgroundVideo";
import CreateRoomModal from "./CreateRoomModal";
import InteractiveGuide from "./InteractiveGuide";
import JoinRoomForm from "./JoinRoomForm";
import Logo from "./Logo";
import NotificationBell from "./NotificationBell";
import VersionNotice from "./VersionNotice";
import MovieDiscoveryPage from "./MovieDiscoveryPage";
import RecentNewsPage from "./RecentNewsPage";
import NewsBrowserPage from "./NewsBrowserPage";
import { getCachedHomeContent, refreshHomeContent } from "../lib/contentCatalog";

function relativeTime(value) {
  if (!value) return "No recent activity";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function Dashboard({ user, auth, roomState, social, onSignOut }) {
  const cachedHomeContent = getCachedHomeContent();
  const [creating, setCreating] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(() => localStorage.getItem("havyn:guide:dashboard:v1") !== "done");
  const [username, setUsername] = useState(user.username || "");
  const [usernameNote, setUsernameNote] = useState("");
  const [friendUsername, setFriendUsername] = useState("");
  const [view, setView] = useState("home");
  const [news, setNews] = useState(() => cachedHomeContent?.news || []);
  const [trending, setTrending] = useState(() => cachedHomeContent?.trending || []);
  const [activeArticle, setActiveArticle] = useState(null);
  const [profileMenuPosition, setProfileMenuPosition] = useState(null);
  const profileButtonRef = useRef(null);
  const profileMenuRef = useRef(null);

  useEffect(() => {
    setUsername(user.username || "");
  }, [user.username]);

  useEffect(() => {
    let active = true;
    refreshHomeContent({ newsLimit: 6, movieLimit: 6 }).then(({ news: newsItems, trending: movieItems }) => {
      if (!active) return;
      setNews(newsItems);
      setTrending(movieItems);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  async function saveUsername(event) {
    event.preventDefault();
    setUsernameNote("");
    try {
      await auth.updateProfile({ username });
      setUsernameNote("Username saved");
    } catch (error) {
      setUsernameNote(error.message?.includes("duplicate") ? "That username is taken" : "Could not save username");
    }
    window.setTimeout(() => setUsernameNote(""), 2200);
  }

  async function inviteFriend(friend) {
    const roomId = await roomState.createRoom("Movie Night", { visibility: "private" });
    if (roomId) await social.sendInvite(roomId, friend.userId);
  }

  async function sendFriendRequest(event) {
    event.preventDefault();
    const sent = await social.sendFriendRequest(friendUsername);
    if (sent) setFriendUsername("");
  }

  function closeTutorial() {
    localStorage.setItem("havyn:guide:dashboard:v1", "done");
    setTutorialOpen(false);
  }

  function openGuide() {
    setProfileOpen(false);
    localStorage.removeItem("havyn:guide:watch:v1");
    localStorage.setItem("havyn:guide:watch:armed", "true");
    setTutorialOpen(false);
    window.requestAnimationFrame(() => setTutorialOpen(true));
  }

  const closeProfile = useCallback(() => setProfileOpen(false), []);

  useDismissableLayer(profileOpen, [profileButtonRef, profileMenuRef], closeProfile);

  const positionProfileMenu = useCallback(() => {
    const rect = profileButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 330;
    setProfileMenuPosition({
      top: Math.round(rect.bottom + 8),
      left: Math.round(Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)))
    });
  }, []);

  useEffect(() => {
    if (!profileOpen) return undefined;
    positionProfileMenu();
    window.addEventListener("resize", positionProfileMenu);
    return () => window.removeEventListener("resize", positionProfileMenu);
  }, [profileOpen, positionProfileMenu]);

  function toggleProfile() {
    if (!profileOpen) positionProfileMenu();
    setProfileOpen((value) => !value);
  }

  function openArticle(article) {
    if (!article?.url) return;
    setActiveArticle(article);
    setView("article");
  }

  const dashboardGuideSteps = [
    {
      targetClass: "guide-profile-target",
      position: "top-right",
      title: "Your profile",
      body: "Set your username here. Friends use it to find and invite you.",
      note: "Usernames are lowercase and can use letters, numbers, and underscores."
    },
    {
      targetClass: "guide-create-target",
      position: "bottom-left",
      title: "Create a room",
      body: "Start a private or public watch room. Private rooms are invite/code based, while public rooms show in the lobby."
    },
    {
      targetClass: "guide-join-target",
      position: "top-right",
      title: "Join by code",
      body: "Paste a room code here when someone sends one to you."
    },
    {
      targetClass: "guide-friends-target",
      position: "top-right",
      title: "Friends",
      body: "Send requests by username, accept incoming requests, see who is online, and invite friends into rooms."
    },
    {
      targetClass: "guide-public-target",
      position: "bottom-right",
      title: "Public rooms",
      body: "Public rooms appear here with what people are watching so others can join."
    }
  ];

  const profileMenu = profileOpen ? createPortal(
    <div ref={profileMenuRef} className="profile-popover account-popover glass" style={profileMenuPosition ? { top: profileMenuPosition.top, left: profileMenuPosition.left, right: "auto" } : undefined} role="menu" aria-label="Account menu">
      <div className="profile-popover-head">
        <div>
          <strong>{user.displayName}</strong>
          <span>{user.username ? `@${user.username}` : "Set a username"}</span>
        </div>
        <VersionNotice compact />
      </div>
      <div className="account-menu-actions">
        <button className="account-menu-row" type="button" role="menuitem" onClick={openGuide}>
          <HelpCircle size={17} />
          <span>Guide</span>
        </button>
        <NotificationBell embedded user={user} social={social} onJoinRoom={roomState.joinRoom} />
      </div>
      <form className="account-section" onSubmit={saveUsername}>
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} pattern="[a-z0-9_]{3,24}" placeholder="choose_username" />
        </label>
        {usernameNote && <span className="action-note">{usernameNote}</span>}
        <button className="secondary-button" type="submit"><Save size={15} /> Save username</button>
      </form>
      {social.friendRequests.length > 0 && (
        <div className="account-section account-requests">
          <strong>Friend requests</strong>
          {social.friendRequests.map((request) => (
            <div className="friend-request-row" key={request.id}>
              <div>
                <strong>{request.displayName}</strong>
                <span>@{request.username}</span>
              </div>
              <button className="icon-button" type="button" title="Accept" onClick={() => social.acceptFriendRequest(request.id)}><Check size={15} /></button>
              <button className="icon-button" type="button" title="Decline" onClick={() => social.declineFriendRequest(request.id)}><X size={15} /></button>
            </div>
          ))}
        </div>
      )}
      <button className="danger-button account-signout" type="button" role="menuitem" onClick={onSignOut}><LogOut size={16} /> Sign out</button>
    </div>,
    document.body
  ) : null;

  const header = (
    <header className="app-header dashboard-header">
      <button className="dashboard-brand-button" type="button" onClick={() => setView("home")} title="Havyn home"><Logo /></button>
      <div className="header-actions">
        {view !== "home" && <button className="ghost-button dashboard-home-button" type="button" onClick={() => setView("home")}>Home</button>}
        <div className="profile-menu-wrap guide-profile-target">
          <button
            ref={profileButtonRef}
            className={`account-icon-button ${profileOpen ? "is-open" : ""}`}
            type="button"
            onClick={toggleProfile}
            aria-haspopup="menu"
            aria-expanded={profileOpen}
            title="Account menu"
          >
            <Menu size={17} />
          </button>
        </div>
      </div>
    </header>
  );

  if (view !== "home") {
    return (
      <main className="dashboard public-screen content-dashboard">
        <BackgroundVideo />
        {header}
        {view === "news" && <RecentNewsPage onBack={() => setView("home")} onOpenArticle={openArticle} />}
        {view === "discover" && <MovieDiscoveryPage roomState={roomState} userId={user.id} onBack={() => setView("home")} />}
        {view === "article" && <NewsBrowserPage article={activeArticle} onClose={() => setView("news")} />}
        {profileMenu}
      </main>
    );
  }

  return (
    <main className="dashboard public-screen">
      <BackgroundVideo />
      {header}

      <section className="dashboard-home">
        <div className="dashboard-hero">
          <span className="section-eyebrow">WATCH TOGETHER. ANYTIME. ANYWHERE.</span>
          <h1>Start a room.</h1>
          <p>Create a room, invite your friends, and enjoy movies, shows, and more together in real time.</p>
          <div className="dashboard-hero-actions">
            <button className="primary-button guide-create-target" onClick={() => setCreating(true)}><Plus size={18} /> Create room</button>
            <span>or</span>
            <div className="hero-join guide-join-target"><JoinRoomForm onJoin={roomState.joinRoom} /></div>
          </div>
          {social.socialNote && <div className="social-note">{social.socialNote}</div>}
        </div>

        <section className="dashboard-section news-home-section">
          <div className="dashboard-section-head">
            <div><span className="section-eyebrow">WHAT'S HAPPENING</span><h2>Recent News</h2></div>
            <button className="text-action" type="button" onClick={() => setView("news")}>View all <ArrowRight size={15} /></button>
          </div>
          <div className="home-news-rail">
            {news.length ? news.slice(0, 4).map((article, index) => (
              <button className={`home-news-card ${index === 0 ? "featured" : ""}`} type="button" onClick={() => openArticle(article)} key={article.id || article.url}>
                {article.imageUrl ? <img src={article.imageUrl} alt="" decoding="async" fetchPriority={index === 0 ? "high" : "auto"} /> : <span className="news-placeholder"><Newspaper size={26} /></span>}
                <span className="home-news-shade" />
                <span className="home-news-copy"><small>{article.category || "Entertainment"}</small><strong>{article.title}</strong><span>{article.source || "Havyn News"}</span></span>
              </button>
            )) : (
              <button className="home-news-empty glass" type="button" onClick={() => setView("news")}><Newspaper size={24} /><span><strong>Recent entertainment news</strong><small>Connect the Havyn Content API to bring current releases, casting, and trailers here.</small></span><ArrowRight size={17} /></button>
            )}
          </div>
        </section>

        <section className="discovery-promo glass">
          <div>
            <span className="section-eyebrow">NEED A PICK?</span>
            <h2>Don't know what to watch?</h2>
            <p>Browse by genre, mood, rating, or runtime and start a room from the title you choose.</p>
            <button className="primary-button" type="button" onClick={() => setView("discover")}><Sparkles size={17} /> Explore movies</button>
          </div>
          <div className="discovery-poster-stack" aria-hidden="true">
            {trending.slice(0, 3).map((movie) => movie.posterUrl && <img src={movie.posterUrl} alt="" loading="lazy" decoding="async" key={movie.id} />)}
            {!trending.some((movie) => movie.posterUrl) && <span><Film size={38} /></span>}
          </div>
        </section>

        <section className="dashboard-section guide-friends-target">
          <div className="dashboard-section-head">
            <div><span className="section-eyebrow">YOUR CIRCLE</span><h2>Friends online</h2></div>
          </div>
          <div className="friend-rail">
            {social.friends.length ? social.friends.map((friend) => (
              <article className="friend-rail-card glass" key={friend.userId}>
                <span className="friend-avatar">{friend.avatarUrl ? <img src={friend.avatarUrl} alt="" /> : friend.displayName.slice(0, 1).toUpperCase()}<i className={friend.online ? "presence-dot online" : "presence-dot"} /></span>
                <span><strong>{friend.displayName}</strong><small>{friend.online ? `@${friend.username} - online` : `@${friend.username} - ${relativeTime(friend.lastActiveAt)}`}</small></span>
                <button className="icon-button" type="button" title="Invite to a room" onClick={() => inviteFriend(friend)}><Send size={16} /></button>
              </article>
            )) : <div className="friend-rail-empty glass"><Users size={20} /><span><strong>Your watch circle starts here</strong><small>Add friends from your account menu, then invite them into a room.</small></span></div>}
          </div>
          <details className="friend-tools">
            <summary><UserPlus size={14} /> Add a friend</summary>
            <form className="friend-request-form glass" onSubmit={sendFriendRequest}>
              <UserPlus size={16} />
              <input value={friendUsername} onChange={(event) => setFriendUsername(event.target.value.toLowerCase())} placeholder="friend_username" />
              <button className="icon-button" type="submit" title="Send friend request"><Send size={15} /></button>
            </form>
          </details>
        </section>

        <section className="dashboard-section public-home-section guide-public-target">
          <div className="dashboard-section-head"><div><span className="section-eyebrow">OPEN WATCHES</span><h2>Public rooms</h2></div></div>
          <div className="public-room-rail">
            {social.publicRooms.length ? social.publicRooms.map((room) => (
              <article className="public-room-card glass" key={room.roomId}>
                <span className="public-room-icon"><Globe2 size={21} /></span>
                <span><strong>{room.roomName}</strong><small>{room.hostName} - {room.activeMediaTitle}</small><small><Clock3 size={12} /> {room.participantCount} watching</small></span>
                <button className="secondary-button" type="button" onClick={() => roomState.joinRoom(room.roomId)}>Join</button>
              </article>
            )) : <div className="public-room-empty glass"><Globe2 size={28} /><strong>No public rooms are live yet.</strong><span>Check back later or invite some friends!</span></div>}
          </div>
        </section>

      </section>

      <InteractiveGuide
        storageKey="havyn:guide:dashboard:v1"
        steps={dashboardGuideSteps}
        open={tutorialOpen}
        onClose={closeTutorial}
      />
      {profileMenu}

      {creating && <CreateRoomModal onClose={() => setCreating(false)} onCreate={roomState.createRoom} />}
    </main>
  );
}
