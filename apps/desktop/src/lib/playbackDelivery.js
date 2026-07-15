export function createPlaybackDelivery(applyPlayback, options = {}) {
  const schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel || ((timer) => clearTimeout(timer));
  const maxAttempts = Number(options.maxAttempts ?? 12);
  let sequence = 0;
  let timer = null;

  const clearTimer = () => {
    if (timer != null) cancel(timer);
    timer = null;
  };

  const deliver = async (state) => {
    const commandSequence = ++sequence;
    clearTimer();

    const attemptDelivery = async (attempt = 0) => {
      if (commandSequence !== sequence) return false;
      const applied = await Promise.resolve(applyPlayback(state)).catch(() => false);
      if (applied || commandSequence !== sequence) return Boolean(applied);
      if (attempt >= maxAttempts) return false;
      const delay = Math.min(1200, 180 + (attempt * 120));
      timer = schedule(() => attemptDelivery(attempt + 1), delay);
      return false;
    };

    return attemptDelivery();
  };

  return {
    deliver,
    dispose() {
      sequence += 1;
      clearTimer();
    }
  };
}
