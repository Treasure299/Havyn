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
    const username = session.user.user_metadata?.username?.trim().toLowerCase();

    supabase
      .from("profiles")
      .upsert({ id: session.user.id, display_name: displayName, ...(username ? { username } : {}) }, { onConflict: "id" })
      .select()
      .single()
      .then(({ data }) => setProfile(data || { id: session.user.id, display_name: displayName }));
  }, [session]);

  const user = useMemo(() => {
    if (!session?.user) return null;
    return {
      id: session.user.id,
      email: session.user.email,
      displayName: profile?.display_name || session.user.email?.split("@")[0] || "Havyn User",
      username: profile?.username || ""
    };
  }, [session, profile]);

  async function signUp({ email, password, displayName, username }) {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName, username: username?.trim().toLowerCase() },
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

  async function updateProfile(patch) {
    if (!supabase || !session?.user) return null;
    const nextPatch = {
      ...patch,
      ...(patch.username ? { username: patch.username.trim().toLowerCase() } : {})
    };
    const { data, error } = await supabase
      .from("profiles")
      .update(nextPatch)
      .eq("id", session.user.id)
      .select()
      .single();
    if (error) throw error;
    setProfile(data);
    return data;
  }

  return {
    user,
    session,
    loading,
    isSupabaseConfigured,
    signUp,
    signIn,
    signOut,
    updateProfile
  };
}
