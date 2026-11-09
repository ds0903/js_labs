// Handles the page puts on `window` so they can be read from the browser
// console and from the Playwright measurements. Not used by the game itself.

import type { Snapshot } from "shared/protocol";
import type { World } from "shared/sim/world";
import type { Connection } from "./net/connection.ts";
import type { Interpolator } from "./net/interp.ts";
import type { NetStats } from "./net/netgraph.ts";
import type { Predictor } from "./net/predict.ts";
import type { Stats } from "./stats.ts";

declare global {
  // keeps the result of the ?burn= experiment observable
  var __burn: number | undefined;

  interface Window {
    __stats?: Stats;
    __world?: World;
    __result?: unknown;
    __loadLog?: string[];
    __loadMs?: number;
    __connection?: Connection;
    __net?: {
      stats: NetStats;
      interp: Interpolator;
      connection: Connection;
      readonly predictor: Predictor;
      readonly latest: Snapshot | null;
    };
  }
}
