import { ArrowRight } from "lucide-react";
import BackgroundVideo from "./BackgroundVideo";
import Logo from "./Logo";

export default function LandingPage({ onStart }) {
  return (
    <main className="landing public-screen">
      <BackgroundVideo />
      <header className="public-header">
        <Logo />
        <button className="ghost-button" onClick={onStart}>Sign in</button>
      </header>

      <section className="minimal-hero">
        <div>
          <h1>Watch together.</h1>
          <p>Private desktop rooms with synced playback, chat, and optional calls.</p>
          <button className="primary-button" onClick={onStart}>
            Enter Havyn <ArrowRight size={18} />
          </button>
        </div>
      </section>
    </main>
  );
}
