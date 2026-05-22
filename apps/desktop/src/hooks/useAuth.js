import { useEffect, useMemo, useState } from "react";
import { isSupabaseConfigured, supabase } from "../lib/supabaseClient";

const authRedirectUrl = import.meta.env.VITE_AUTH_REDIRECT_URL || "https://havyn-socket-server.onrender.com/verify";

export function useAuth() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase || !session?.user) {
      setProfile(null);
      return;
    }

    const displayName =
      session.user.user_metadata?.display_name ||
      session.user.email?.split("@")[0] ||
      "Havyn User";

    supabase
      .from("profiles")
      .upsert({ id: session.user.id, display_name: displayName }, { onConflict: "id" })
      .select()
      .single()
      .then(({ data }) => setProfile(data || { id: session.user.id, display_name: displayName }));
  }, [session]);

  const user = useMemo(() => {
    if (!session?.user) return null;
    return {
      id: session.user.id,
      email: session.user.email,
      displayName: profile?.display_name || session.user.email?.split("@")[0] || "Havyn User"
    };
  }, [session, profile]);

  async function signUp({ email, password, displayName }) {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: authRedirectUrl
      }
    });
    if (error) throw error;
  }

  async function signIn({ email, password }) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async function signOut() {
    await supabase?.auth.signOut();
  }

  return {
    user,
    session,
    loading,
    isSupabaseConfigured,
    signUp,
    signIn,
    signOut
  };
}
