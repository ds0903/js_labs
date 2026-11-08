// Collision detection as a separate system: it only looks at the world and
// yields pairs of overlapping entities, it does not decide what happens.
// Naive O(n^2), good enough for now. Anything with the same signature
// (a spatial hash, for example) can replace it.
export function* findCollisions(world) {
  const solids = [];
  for (const e of world) {
    if (e.alive && e.solid) solids.push(e);
  }

  for (let i = 0; i < solids.length; i++) {
    const a = solids[i];
    for (let j = i + 1; j < solids.length; j++) {
      const b = solids[j];
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const reach = a.radius + b.radius;
      if (dx * dx + dy * dy <= reach * reach) yield [a, b];
    }
  }
}
