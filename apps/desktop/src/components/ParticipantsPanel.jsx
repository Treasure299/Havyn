import { ChevronDown, Crown, MicOff, MonitorCheck, ShieldCheck, VideoOff } from "lucide-react";
import { useState } from "react";

export default function ParticipantsPanel({ participants = [], currentUserId, onRoleChange }) {
  const [open, setOpen] = useState(false);
  const uniqueParticipants = Array.from(new Map(participants.map((participant) => [participant.userId, participant])).values());
  const current = uniqueParticipants.find((participant) => participant.userId === currentUserId);
  const canManageRoles = current?.role === "host";

  return (
    <section className={`participants-panel glass ${open ? "is-open" : ""}`}>
      <button className="participants-toggle" type="button" onClick={() => setOpen((value) => !value)}>
        <span>People</span>
        <strong>{uniqueParticipants.length}</strong>
        <ChevronDown size={17} />
      </button>
      {open && (
        <div className="participant-list">
          {uniqueParticipants.map((participant) => (
            <div className="participant-row" key={participant.userId}>
              <div>
                <strong>{participant.displayName}</strong>
                <span>{participant.online ? "Online" : "Away"}</span>
              </div>
              <div className="status-icons">
                {participant.role === "host" && <Crown size={15} title="Host" />}
                {participant.role === "cohost" && <span className="tiny-badge">Co</span>}
                {participant.mediaReady && <MonitorCheck size={15} title="Media ready" />}
                {participant.muted && <MicOff size={15} title="Muted" />}
                {participant.cameraOff && <VideoOff size={15} title="Camera off" />}
                {canManageRoles && participant.role !== "host" && (
                  <button
                    className="tiny-action"
                    type="button"
                    title={participant.role === "cohost" ? "Remove cohost" : "Make cohost"}
                    onClick={() => onRoleChange?.(participant.userId, participant.role === "cohost" ? "viewer" : "cohost")}
                  >
                    <ShieldCheck size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
