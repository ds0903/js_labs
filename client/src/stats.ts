export interface StatsCurrent {
  stepsPerSec: number;
  framesPerSec: number;
  frameMs: number;
  frameMaxMs: number;
}

export interface Stats {
  current: StatsCurrent;
  step(): void;
  // frameMs: time since the previous frame, now: current time in ms
  frame(frameMs: number, now: number): void;
}

// Counts simulation steps and rendered frames over a short window
// and reports steps/s, frames/s and frame time for the HUD.
export function createStats(
  onUpdate?: (current: StatsCurrent) => void,
  windowMs = 500,
): Stats {
  let windowStart: number | null = null;
  let steps = 0;
  let frames = 0;
  let frameSum = 0;
  let frameMax = 0;

  const stats: Stats = {
    current: { stepsPerSec: 0, framesPerSec: 0, frameMs: 0, frameMaxMs: 0 },

    step() {
      steps++;
    },

    frame(frameMs, now) {
      if (windowStart === null) windowStart = now;
      frames++;
      frameSum += frameMs;
      frameMax = Math.max(frameMax, frameMs);

      const elapsed = now - windowStart;
      if (elapsed < windowMs) return;

      stats.current = {
        stepsPerSec: (steps * 1000) / elapsed,
        framesPerSec: (frames * 1000) / elapsed,
        frameMs: frameSum / frames,
        frameMaxMs: frameMax,
      };
      windowStart = now;
      steps = 0;
      frames = 0;
      frameSum = 0;
      frameMax = 0;
      if (onUpdate) onUpdate(stats.current);
    },
  };

  return stats;
}
