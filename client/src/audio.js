// Owns the AudioContext. Browsers keep it suspended until the user clicks or
// presses a key, so the first gesture resumes it. Decoding happens during
// loading (loadAudio), playing here only starts an already decoded buffer.
export function createAudio() {
  const ctx = new AudioContext();
  let buffers = {};

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

// The simulation never imports this module. It only dispatches events,
// and the sound code listens to them from outside.
export function connectAudio(audio, world) {
  world.addEventListener("fired", () =>
    audio.play("shoot", { rate: 0.95 + Math.random() * 0.1 }),
  );
  world.addEventListener("hit", () => audio.play("hit"));
  world.addEventListener("exploded", () => audio.play("explosion", { volume: 0.6 }));
}
