// What a player sends every simulation step: inputs, never positions.
//   { seq, tick, thrust, turn, fire }
// seq counts the player's inputs, tick is the newest server tick the client
// has seen, turn is -1, 0 or 1.
export const NEUTRAL = Object.freeze({
  seq: 0,
  tick: 0,
  thrust: false,
  turn: 0,
  fire: false,
});

// Ship.update only needs isDown(code). This adapter answers it from a command,
// so the same Ship class runs on the server, in the client's prediction and
// in the replay after a snapshot.
export const NET_CONTROLS = {
  left: "left",
  right: "right",
  thrust: "thrust",
  fire: "fire",
};

export function commandInput() {
  const input = {
    cmd: NEUTRAL,
    get seq() {
      return input.cmd.seq;
    },
    isDown(code) {
      const { cmd } = input;
      if (code === "left") return cmd.turn < 0;
      if (code === "right") return cmd.turn > 0;
      if (code === "thrust") return cmd.thrust;
      if (code === "fire") return cmd.fire;
      return false;
    },
  };
  return input;
}

// Never trust the client: a turn of 1000 would be a cheat. Returns an error
// string or null. Works for anything that came out of a codec.
export function checkCommand(cmd) {
  if (cmd === null || typeof cmd !== "object") return "not an object";
  const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
  if (!uint(cmd.seq)) return "bad seq";
  if (!uint(cmd.tick)) return "bad tick";
  if (typeof cmd.thrust !== "boolean") return "bad thrust";
  if (typeof cmd.fire !== "boolean") return "bad fire";
  if (cmd.turn !== -1 && cmd.turn !== 0 && cmd.turn !== 1) return "bad turn";
  return null;
}
