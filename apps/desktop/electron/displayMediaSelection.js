export function resolveEmbeddedCaptureSource(webContentsId, registeredWebviews, resolveWebContents) {
  const id = Number(webContentsId) || 0;
  if (!id || !registeredWebviews?.has(id)) return null;
  const browserWebContents = resolveWebContents?.(id);
  if (!browserWebContents || browserWebContents.isDestroyed?.()) return null;
  return {
    id: `havyn:webframe:${id}`,
    frame: browserWebContents.mainFrame
  };
}

export function streamsForCaptureSelection(selection) {
  const capturedFrame = selection?.source?.frame || null;
  return {
    video: capturedFrame || selection?.source,
    ...(selection?.withAudio ? { audio: capturedFrame || "loopback" } : {}),
    ...(capturedFrame ? { enableLocalEcho: true } : {})
  };
}
