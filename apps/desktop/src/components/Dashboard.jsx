import { Bell, Clock3, Globe2, LogOut, Plus, Send, Ticket, Users, X } from "lucide-react";
import { useState } from "react";
import BackgroundVideo from "./BackgroundVideo";
import CreateRoomModal from "./CreateRoomModal";
import JoinRoomForm from "./JoinRoomForm";
import Logo from "./Logo";

function relativeTime(value) {
  if (!value) return "No recent activity";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function Dashboard({ user, roomState, social, onSignOut }) {
  const [creating, setCreating] = useState(false);
  const [invitesOpen, setInvitesOpen] = useState(false);

  async function invitePartner(person) {
    const roomId = await roomState.createRoom("Movie Night", { visibility: "private" });
    if (roomId) await social.sendInvite(roomId, person.userId);
  }

  async function acceptInvite(inviteId) {
    const roomId = await social.acceptInvite(inviteId);
    if (roomId) await roomState.joinRoom(roomId);
  }

  return (
    <main className="dashboard public-screen">
      <BackgroundVideo />
      <header className="app-header">
        <Logo />
        <div className="header-actions">
          <button
            className={`icon-text invite-toggle ${social.invites.length ? "has-invites" : ""}`}
            onClick={() => setInvitesOpen(true)}
            title="Open invites"
          >
            <Bell size={17} />
            Invites
            {social.invites.length > 0 && <strong>{social.invites.length}</strong>}
          </button>
          <span className="user-chip">{user.displayName}</span>
          <button className="icon-button" onClick={onSignOut} title="Sign out"><LogOut size={18} /></button>
        </div>
      </header>

      <section className="dashboard-grid">
        <div className="dashboard-copy">
          <h1>Start a room.</h1>
          <p>Create a room, join a code, or drop into a public watch already in motion.</p>
          <button className="primary-button" onClick={() => setCreating(true)}><Plus size={18} /> Create room</button>
          {social.socialNote && <div className="social-note">{social.socialNote}</div>}
        </div>

        <div className="glass dashboard-panel">
          <Ticket size={24} />
          <h2>Join by code</h2>
          <JoinRoomForm onJoin={roomState.joinRoom} />
        </div>

        <div className="glass recent-panel social-panel">
          <div className="panel-title-row">
            <Users size={22} />
            <h2>Recent people</h2>
          </div>
          <div className="social-list">
            {social.recentPeople.length ? social.recentPeople.map((person) => (
              <div className="social-row" key={person.userId}>
                <i className={person.online ? "presence-dot online" : "presence-dot"} />
                <div>
                  <strong>{person.displayName}</strong>
                  <span>{person.online ? "Online now" : `Last active ${relativeTime(person.lastActiveAt)}`}</span>
                </div>
                <button className="icon-button" type="button" title="Invite to a room" onClick={() => invitePartner(person)}><Send size={16} /></button>
              </div>
            )) : <p>People you watch with will appear here.</p>}
          </div>
        </div>

        <div className="glass recent-panel public-rooms-panel">
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

      <aside className={`invite-drawer ${invitesOpen ? "is-open" : ""}`} aria-hidden={!invitesOpen}>
        <button className="drawer-scrim" type="button" aria-label="Close invites" onClick={() => setInvitesOpen(false)} />
        <section className="drawer-panel glass">
          <div className="drawer-head">
            <div>
              <span className="eyebrow">Inbox</span>
              <h2>Room invites</h2>
            </div>
            <button className="icon-button" type="button" title="Close invites" onClick={() => setInvitesOpen(false)}><X size={16} /></button>
          </div>
          <div className="invite-empty-or-list">
            {social.invites.length ? social.invites.map((invite) => (
              <div className="invite-card" key={invite.id}>
                <div>
                  <strong>{invite.roomName}</strong>
                  <span>{invite.inviterName} invited you</span>
                  {invite.mediaTitle && <small>{invite.mediaTitle}</small>}
                </div>
                <div className="invite-card-actions">
                  <button className="secondary-button" type="button" onClick={() => acceptInvite(invite.id)}>Join</button>
                  <button className="ghost-button" type="button" onClick={() => social.dismissInvite(invite.id)}>Dismiss</button>
                </div>
              </div>
            )) : (
              <div className="invite-empty">
                <Bell size={30} />
                <strong>No invites yet</strong>
                <span>When someone invites you to a room, it will land here.</span>
              </div>
            )}
          </div>
        </section>
      </aside>

      {creating && <CreateRoomModal onClose={() => setCreating(false)} onCreate={roomState.createRoom} />}
    </main>
  );
}
