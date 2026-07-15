export function logPlaybackDiagnostic(event, details = {}) {
  try {
    window.havyn?.diagnostics?.log?.({ scope: "renderer", event, ...details });
  } catch {
    // Diagnostics are passive and must never affect room behavior.
  }
}
