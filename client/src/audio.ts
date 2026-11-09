import type { World } from "shared/sim/world";

export interface PlayOptions {
  volume?: number;
  rate?: number;
}

export interface Audio {
  readonly ctx: AudioContext;
  setBuffers(next: Record<string, AudioBuffer>): void;
  play(name: string, options?: PlayOptions): void;
}

// Owns the AudioContext. Browsers keep it suspended until the user clicks or
// presses a key, so the first gesture resumes it. Decoding happens during
// loading (loadAudio), playing here only starts an already decoded buffer.
export function createAudio(): Audio {
  const ctx = new AudioContext();
  let buffers: Record<string, AudioBuffer> = {};

  function unlock() {
    if (ctx.state !== "running") ctx.resume();
  }
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);

  return {
    ctx,
    setBuffers(next) {
      buffers = next;
    },
    play(name, { volume = 0.4, rate = 1 } = {}) {
      const buffer = buffers[name];
      if (!buffer || ctx.state !== "running") return;
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      gain.gain.value = volume;
      source.connect(gain).connect(ctx.destination);
      source.start();
    },
  };
}

// The simulation never imports this module. It only emits events,
// and the sound code listens to them from outside.
export function connectAudio(audio: Audio, world: World): void {
  world.on("fired", () => audio.play("shoot", { rate: 0.95 + Math.random() * 0.1 }));
  world.on("hit", () => audio.play("hit"));
  world.on("exploded", () => audio.play("explosion", { volume: 0.6 }));
}
