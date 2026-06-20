import { Check, Clock3, Globe2, HelpCircle, LogOut, Menu, Plus, Save, Send, Ticket, UserCircle2, UserPlus, Users, X } from "lucide-react";
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
  const [creating, setCreating] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(() => localStorage.getItem("havyn:guide:dashboard:v1") !== "done");
  const [username, setUsername] = useState(user.username || "");
  const [usernameNote, setUsernameNote] = useState("");
  const [friendUsername, setFriendUsername] = useState("");
  const profileButtonRef = useRef(null);
  const profileMenuRef = useRef(null);

  useEffect(() => {
    setUsername(user.username || "");
  }, [user.username]);

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

  function toggleProfile() {
    setProfileOpen((value) => !value);
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
    <div ref={profileMenuRef} className="profile-popover account-popover glass" role="menu" aria-label="Account menu">
      <div className="profile-popover-head">
        <div>
          <strong>{user.displayName}</strong>
          <span>{user.username ? `@${user.username}` : "Set a username"}</span>
        </div>
        <VersionNotice compact />
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

  return (
    <main className="dashboard public-screen">
      <BackgroundVideo />
      <header className="app-header">
        <Logo />
        <div className="header-actions">
          <button className="icon-text" onClick={openGuide} title="How Havyn works"><HelpCircle size={17} /> Guide</button>
          <NotificationBell user={user} social={social} onJoinRoom={roomState.joinRoom} onOpen={() => setProfileOpen(false)} />
          <div className="profile-menu-wrap guide-profile-target">
            <button
              ref={profileButtonRef}
              className={`account-menu-button ${profileOpen ? "is-open" : ""}`}
              type="button"
              onClick={toggleProfile}
              aria-haspopup="menu"
              aria-expanded={profileOpen}
              title="Account menu"
            >
              <UserCircle2 size={18} />
              <Menu size={17} />
            </button>
          </div>
        </div>
      </header>

      <section className="dashboard-grid">
        <div className="dashboard-copy">
          <h1>Start a room.</h1>
          <p>Create a room, join a code, or drop into a public watch already in motion.</p>
          <button className="primary-button guide-create-target" onClick={() => setCreating(true)}><Plus size={18} /> Create room</button>
          {social.socialNote && <div className="social-note">{social.socialNote}</div>}
        </div>

        <div className="glass dashboard-panel guide-join-target">
          <Ticket size={24} />
          <h2>Join by code</h2>
          <JoinRoomForm onJoin={roomState.joinRoom} />
        </div>

        <div className="glass recent-panel friends-panel guide-friends-target">
          <div className="panel-title-row">
            <Users size={22} />
            <h2>Friends</h2>
          </div>
          <form className="friend-request-form" onSubmit={sendFriendRequest}>
            <UserPlus size={16} />
            <input value={friendUsername} onChange={(event) => setFriendUsername(event.target.value.toLowerCase())} placeholder="friend_username" />
            <button className="icon-button" type="submit" title="Send friend request"><Send size={15} /></button>
          </form>
          {social.friendRequests.length > 0 && (
            <div className="friend-requests">
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
          <div className="friend-list-head">
            <strong>Friends list</strong>
            <span>{social.friends.length} friend{social.friends.length === 1 ? "" : "s"}</span>
          </div>
          <div className="social-list">
            {social.friends.length ? social.friends.map((friend) => (
              <div className="social-row" key={friend.userId}>
                <i className={friend.online ? "presence-dot online" : "presence-dot"} />
                <div>
                  <strong>{friend.displayName}</strong>
                  <span>{friend.online ? `@${friend.username} - online` : `@${friend.username} - ${relativeTime(friend.lastActiveAt)}`}</span>
                </div>
                <button className="icon-button" type="button" title="Invite to a room" onClick={() => inviteFriend(friend)}><Send size={16} /></button>
              </div>
            )) : (
              <div className="empty-state compact-empty">
                <Users size={22} />
                <strong>No friends yet</strong>
                <span>Send a request by username. Once accepted, their online status and last active time will show here.</span>
              </div>
            )}
          </div>
        </div>

        <div className="glass recent-panel public-rooms-panel guide-public-target">
          <div className="panel-title-row">
            <Globe2 size={22} />
            <h2>Public rooms</h2>
          </div>
          <div className="social-list">
            {social.publicRooms.length ? social.publicRooms.map((room) => (
              <div className="public-room-row" key={room.roomId}>
                <div>
                  <strong>{room.roomName}</strong>
                  <span>{room.hostName} - {room.activeMediaTitle}</span>
                  <small><Clock3 size={13} /> {relativeTime(room.lastSeenAt)} - {room.participantCount} watching</small>
                </div>
                <button className="secondary-button" type="button" onClick={() => roomState.joinRoom(room.roomId)}>Join</button>
              </div>
            )) : <p>No public rooms are live yet.</p>}
          </div>
        </div>
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
