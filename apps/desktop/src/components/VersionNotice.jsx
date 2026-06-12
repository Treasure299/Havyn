const appVersion = typeof __HAVYN_VERSION__ === "string" ? __HAVYN_VERSION__ : "dev";

export default function VersionNotice({ compact = false }) {
  return (
    <span className={`version-notice ${compact ? "version-notice-compact" : ""}`} title={`Havyn version ${appVersion}`}>
      v{appVersion}
    </span>
  );
}
