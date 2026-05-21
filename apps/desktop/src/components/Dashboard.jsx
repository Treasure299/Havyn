import { LogOut, Plus, Ticket } from "lucide-react";
import { useState } from "react";
import CreateRoomModal from "./CreateRoomModal";
import JoinRoomForm from "./JoinRoomForm";
import BackgroundVideo from "./BackgroundVideo";
import Logo from "./Logo";

export default function Dashboard({ user, roomState, onSignOut }) {
  const [creating, setCreating] = useState(false);

  return (
    <main className="dashboard public-screen">
      <BackgroundVideo />
      <header className="app-header">
        <Logo />
        <div className="header-actions">
          <span className="user-chip">{user.displayName}</span>
          <button className="icon-button" onClick={onSignOut} title="Sign out"><LogOut size={18} /></button>
        </div>
      </header>

      <section className="dashboard-grid">
        <div className="dashboard-copy">
          <h1>Start a room.</h1>
          <p>Create or join a private watch room.</p>
          <button className="primary-button" onClick={() => setCreating(true)}><Plus size={18} /> Create room</button>
        </div>
        <div className="glass dashboard-panel">
          <Ticket size={24} />
          <h2>Join by code</h2>
          <JoinRoomForm onJoin={roomState.joinRoom} />
        </div>
        <div className="glass recent-panel">
          <h2>Recent rooms</h2>
          <div className="recent-room">
            <div>
              <strong>Friday Room</strong>
              <span>Ready</span>
            </div>
          </div>
          <div className="recent-room">
            <div>
              <strong>Private sessions</strong>
              <span>Small rooms</span>
            </div>
          </div>
        </div>
      </section>

      {creating && <CreateRoomModal onClose={() => setCreating(false)} onCreate={roomState.createRoom} />}
    </main>
  );
}
