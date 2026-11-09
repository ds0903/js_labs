import { seq, tick } from "../brand.ts";
import type { Command } from "../protocol.ts";

// What a player sends every simulation step: inputs, never positions.
//   { seq, tick, thrust, turn, fire }
// seq counts the player's inputs, tick is the newest server tick the client
// has seen, turn is -1, 0 or 1. The shape is `Command` in protocol.ts, where
// the zod schema checks it at runtime: that replaces the old hand-written
// checkCommand.
export const NEUTRAL: Command = Object.freeze({
  seq: seq(0),
  tick: tick(0),
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
} as const;

export interface CommandInput {
  cmd: Command;
  readonly seq: number;
  isDown(code: string): boolean;
}

export function commandInput(): CommandInput {
  const input: CommandInput = {
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
