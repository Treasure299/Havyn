import { useState } from "react";
import { useAuth } from "./hooks/useAuth";
import { useRoom } from "./hooks/useRoom";
import { useSocial } from "./hooks/useSocial";
import LandingPage from "./components/LandingPage";
import AuthPage from "./components/AuthPage";
import Dashboard from "./components/Dashboard";
import WatchRoom from "./components/WatchRoom";

export default function App() {
  const auth = useAuth();
  const [screen, setScreen] = useState("landing");
  const roomState = useRoom(auth.user);
  const social = useSocial(auth.user, roomState.room);

  if (auth.loading) {
    return <div className="boot-screen">Opening Havyn</div>;
  }

  if (!auth.isSupabaseConfigured) {
    return (
      <div className="boot-screen">
        <strong>Supabase setup needed</strong>
        <span>Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to apps/desktop/.env.</span>
      </div>
    );
  }

  if (!auth.user) {
    return screen === "auth" ? (
      <AuthPage auth={auth} onBack={() => setScreen("landing")} />
    ) : (
      <LandingPage onStart={() => setScreen("auth")} />
    );
  }

  if (roomState.room) {
    return <WatchRoom user={auth.user} roomState={roomState} social={social} onSignOut={auth.signOut} />;
  }

  return <Dashboard user={auth.user} roomState={roomState} social={social} onSignOut={auth.signOut} />;
}
