import type { Snapshot, SnapshotEntity } from "shared/protocol";
import { ARENA } from "shared/sim/arena";
import { lerpAngle, lerpWrapped } from "../render/interpolate.ts";

const KEEP_TICKS = 45; // 1.5 s of snapshots is plenty for any delay we allow

export interface InterpolatorOptions {
  intervalMs?: number;
  delayMs?: number;
  extrapolateMs?: number;
}

export interface Interpolator {
  delayMs: number;
  push(snap: Snapshot, at: number): void;
  // the tick (fractional) that is drawn at time `now`
  renderTick(now: number): number | null;
  readonly latestTick: number;
  readonly size: number;
  reset(): void;
  // Entities at time `now`, positions interpolated. Empty until a snapshot has arrived.
  sample(now: number): SnapshotEntity[];
}

// Entity interpolation for everything the player does not control.
// Snapshots are buffered and the world is drawn `delayMs` in the past, between
// the two snapshots that bracket that moment.
//
// Which moment is "now" on the server? The snapshot's tick number says when
// it was made. For each snapshot the offset arrival - tick * interval is
// computed; the smallest values are the ones with the least network delay, so
// the estimate follows them down quickly and drifts up slowly. The delay then
// only has to cover the jitter.
export function createInterpolator({
  intervalMs = 1000 / 30,
  delayMs = 100,
  extrapolateMs = 120,
}: InterpolatorOptions = {}): Interpolator {
  let snaps: Snapshot[] = [];
  let offset: number | null = null;

  const api: Interpolator = {
    delayMs,

    push(snap, at) {
      const last = snaps.at(-1);
      if (last && snap.tick <= last.tick) return; // old or duplicate
      const sample = at - snap.tick * intervalMs;
      if (offset === null) offset = sample;
      else offset += (sample - offset) * (sample < offset ? 0.5 : 0.02);
      snaps.push(snap);
      if (snaps.length > KEEP_TICKS) snaps = snaps.slice(-KEEP_TICKS);
    },

    renderTick(now) {
      if (offset === null) return null;
      return (now - offset - api.delayMs) / intervalMs;
    },

    get latestTick() {
      return snaps.at(-1)?.tick ?? 0;
    },

    get size() {
      return snaps.length;
    },

    reset() {
      snaps = [];
      offset = null;
    },

    sample(now) {
      const rt = api.renderTick(now);
      const first = snaps[0];
      const last = snaps.at(-1);
      if (rt === null || !first || !last) return [];

      if (rt <= first.tick) return first.entities.map((e) => ({ ...e }));

      if (rt >= last.tick) {
        // nothing newer yet (a late or lost snapshot): keep moving for a
        // moment on the last known velocity, then stand still
        const seconds = Math.min((rt - last.tick) * intervalMs, extrapolateMs) / 1000;
        return last.entities.map((e) => ({
          ...e,
          x: wrap(e.x + e.vx * seconds, ARENA.width),
          y: wrap(e.y + e.vy * seconds, ARENA.height),
        }));
      }

      let i = snaps.length - 2;
      while (i > 0 && (snaps[i]?.tick ?? 0) > rt) i--;
      const a = snaps[i];
      const b = snaps[i + 1];
      // rt is strictly between the first and the last snapshot, so both exist;
      // the compiler cannot see that
      if (!a || !b) return [];
      const t = (rt - a.tick) / (b.tick - a.tick);

      const before = new Map(a.entities.map((e) => [e.id, e]));
      const out: SnapshotEntity[] = [];
      for (const e of b.entities) {
        const old = before.get(e.id);
        before.delete(e.id);
        // new in b: it appeared between the two snapshots, show it where it is
        if (!old) out.push({ ...e });
        else out.push(blend(old, e, t));
      }
      // only in a: it is gone in b, but at this moment it still existed
      for (const old of before.values()) out.push({ ...old });
      return out;
    },
  };
  return api;
}

const wrap = (v: number, size: number) => ((v % size) + size) % size;

function blend(a: SnapshotEntity, b: SnapshotEntity, t: number): SnapshotEntity {
  return {
    ...b,
    x: lerpWrapped(a.x, b.x, t, ARENA.width),
    y: lerpWrapped(a.y, b.y, t, ARENA.height),
    angle: lerpAngle(a.angle, b.angle, t),
  };
}
