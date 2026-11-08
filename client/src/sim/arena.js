export const ARENA = { width: 1600, height: 900 };

// JS % keeps the sign of the left operand, so negatives need the second %
export function wrap(value, size) {
  return ((value % size) + size) % size;
}

export function wrapShip(ship, arena = ARENA) {
  return {
    ...ship,
    x: wrap(ship.x, arena.width),
    y: wrap(ship.y, arena.height),
  };
}
