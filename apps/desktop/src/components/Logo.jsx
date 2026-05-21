export default function Logo({ compact = false }) {
  return (
    <div className={`logo ${compact ? "logo-compact" : ""}`} aria-label="Havyn">
      <img src="./brand/havyn-icon.png" alt="" />
      <div className="logo-word">Havyn</div>
    </div>
  );
}
