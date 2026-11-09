export interface Arena {
  readonly width: number;
  readonly height: number;
}

export const ARENA: Arena = { width: 1600, height: 900 };

// JS % keeps the sign of the left operand, so negatives need the second %
export function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

// a point that can be drawn or moved, e.g. the interpolated position of a ship
export function wrapShip<T extends { x: number; y: number }>(
  ship: T,
  arena: Arena = ARENA,
): T {
  return {
    ...ship,
    x: wrap(ship.x, arena.width),
    y: wrap(ship.y, arena.height),
  };
}
