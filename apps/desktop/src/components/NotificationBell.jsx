import { Bell, Check, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

export default function NotificationBell({ user, social, onJoinRoom, onOpen }) {
  const [open, setOpen] = useState(false);
  const notificationItems = useMemo(() => [
    ...social.invites.map((invite) => ({ ...invite, type: "room", sortAt: invite.createdAt })),
    ...social.friendRequests.map((request) => ({ ...request, type: "friend", sortAt: request.createdAt }))
  ].sort((a, b) => new Date(b.sortAt || 0).getTime() - new Date(a.sortAt || 0).getTime()), [social.friendRequests, social.invites]);

  const notificationSignature = notificationItems.map((item) => `${item.type}:${item.id}`).join("|");
  const notificationSeenKey = `havyn:notifications:seen:${user.id}`;
  const [seenNotifications, setSeenNotifications] = useState(() => localStorage.getItem(notificationSeenKey) || "");
  const hasUnreadNotifications = notificationItems.length > 0 && notificationSignature !== seenNotifications;

  useEffect(() => {
    setSeenNotifications(localStorage.getItem(notificationSeenKey) || "");
  }, [notificationSeenKey]);

  function toggleNotifications() {
    setOpen((value) => {
      const next = !value;
      if (next) {
        localStorage.setItem(notificationSeenKey, notificationSignature);
        setSeenNotifications(notificationSignature);
        onOpen?.();
      }
      return next;
    });
  }

  async function acceptInvite(inviteId) {
    const roomId = await social.acceptInvite(inviteId);
    setOpen(false);
    if (roomId) await onJoinRoom(roomId);
  }

  const menu = open ? createPortal(
    <section className="notification-popover glass">
      <div className="notification-head">
        <strong>Notifications</strong>
        <span>{notificationItems.length}</span>
      </div>
      <div className="notification-list">
        {notificationItems.length ? notificationItems.map((item) => item.type === "room" ? (
          <div className="notification-row" key={`room-${item.id}`}>
            <div>
              <strong>{item.roomName}</strong>
              <span>{item.inviterName} invited you</span>
              {item.mediaTitle && <small>{item.mediaTitle}</small>}
            </div>
            <button className="secondary-button" type="button" onClick={() => acceptInvite(item.id)}>Join</button>
            <button className="icon-button" type="button" title="Dismiss" onClick={() => social.dismissInvite(item.id)}><X size={14} /></button>
          </div>
        ) : (
          <div className="notification-row" key={`friend-${item.id}`}>
            <div>
              <strong>{item.displayName}</strong>
              <span>@{item.username} sent a friend request</span>
            </div>
            <button className="icon-button" type="button" title="Accept" onClick={() => social.acceptFriendRequest(item.id)}><Check size={14} /></button>
            <button className="icon-button" type="button" title="Decline" onClick={() => social.declineFriendRequest(item.id)}><X size={14} /></button>
          </div>
        )) : (
          <div className="notification-empty">
            <Bell size={22} />
            <strong>No notifications</strong>
            <span>Room invites and friend requests will appear here.</span>
          </div>
        )}
      </div>
    </section>,
    document.body
  ) : null;

  return (
    <div className="notification-menu-wrap">
      <button
        className={`icon-button notification-button ${hasUnreadNotifications ? "has-unread" : ""}`}
        onClick={toggleNotifications}
        title="Notifications"
        type="button"
      >
        <Bell size={17} />
      </button>
      {menu}
    </div>
  );
}
