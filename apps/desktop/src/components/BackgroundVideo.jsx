export default function BackgroundVideo() {
  return (
    <div className="ambient-video" aria-hidden="true">
      <video src="./videos/havyn-bg-loop.mp4" autoPlay muted loop playsInline />
      <div className="ambient-gradient" />
    </div>
  );
}
