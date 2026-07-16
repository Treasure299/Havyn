function validCandidate(candidate) {
  const bounds = candidate?.displayBounds;
  const rect = candidate?.cropRect;
  return Number(bounds?.width) > 0
    && Number(bounds?.height) > 0
    && Number(rect?.width) > 0
    && Number(rect?.height) > 0;
}

export function selectCaptureGeometry(videoWidth, videoHeight, candidates = [], fallback = null) {
  const sourceAspect = Number(videoWidth) / Math.max(1, Number(videoHeight));
  const choices = candidates.filter(validCandidate);
  if (!choices.length) return fallback;
  return choices.reduce((best, candidate) => {
    const boundsAspect = Number(candidate.displayBounds.width) / Number(candidate.displayBounds.height);
    const aspectError = Math.abs(Math.log(Math.max(0.001, sourceAspect) / Math.max(0.001, boundsAspect)));
    const rect = candidate.cropRect;
    const bounds = candidate.displayBounds;
    const overflow = Math.max(0, -Number(rect.x || 0))
      + Math.max(0, -Number(rect.y || 0))
      + Math.max(0, Number(rect.x || 0) + Number(rect.width || 0) - Number(bounds.width || 0))
      + Math.max(0, Number(rect.y || 0) + Number(rect.height || 0) - Number(bounds.height || 0));
    const score = aspectError + overflow / Math.max(1, Number(bounds.width) + Number(bounds.height));
    return !best || score < best.score ? { candidate, score } : best;
  }, null)?.candidate || fallback;
}
