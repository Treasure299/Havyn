export function splitCallDevices(items = []) {
  return {
    audioInputs: items.filter((device) => device.kind === "audioinput"),
    videoInputs: items.filter((device) => device.kind === "videoinput")
  };
}

export async function discoverNamedCallDevices(mediaDevices, setPermissionActive) {
  const mediaAllowed = await setPermissionActive(true);
  if (!mediaAllowed) throw new Error("Camera and microphone permission could not be enabled.");

  let probeStream = null;
  try {
    probeStream = await mediaDevices.getUserMedia({ audio: true, video: true });
    return splitCallDevices(await mediaDevices.enumerateDevices());
  } finally {
    probeStream?.getTracks().forEach((track) => track.stop());
    await setPermissionActive(false).catch(() => {});
  }
}
