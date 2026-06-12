import { useState } from "react";
import { ArrowLeft, LogIn } from "lucide-react";
import BackgroundVideo from "./BackgroundVideo";
import Logo from "./Logo";
import VersionNotice from "./VersionNotice";

export default function AuthPage({ auth, onBack }) {
  const [mode, setMode] = useState("signin");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      if (mode === "signup") {
        await auth.signUp({ email, password, displayName, username });
        setNotice("Check your email to confirm your account, then return to Havyn and log in.");
      } else {
        await auth.signIn({ email, password });
      }
    } catch (err) {
      const message = err.message || "Something went wrong.";
      setError(message.includes("security purposes")
        ? `${message} Supabase limits repeated signup emails for a short time.`
        : message
      );
    }
  }

  return (
    <main className="auth-screen public-screen">
      <BackgroundVideo />
      <button className="icon-text" onClick={onBack}><ArrowLeft size={18} /> Back</button>
      <form className="auth-card glass" onSubmit={submit}>
        <Logo />
        <VersionNotice />
        <h2>{mode === "signup" ? "Create your Havyn account" : "Welcome back"}</h2>
        {mode === "signup" && (
          <>
            <label>
              Display name
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="David" required />
            </label>
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} pattern="[a-z0-9_]{3,24}" placeholder="david" required />
            </label>
          </>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required />
        </label>
        {notice && <div className="notice-line">{notice}</div>}
        {error && <div className="error-line">{error}</div>}
        <button className="primary-button" type="submit"><LogIn size={18} /> {mode === "signup" ? "Sign up" : "Log in"}</button>
        <button className="ghost-button" type="button" onClick={() => setMode(mode === "signup" ? "signin" : "signup")}>
          {mode === "signup" ? "Already have an account" : "Create account"}
        </button>
      </form>
    </main>
  );
}
