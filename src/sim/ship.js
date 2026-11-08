export const SHIP = {
  turnSpeed: 3.5, // rad/s
  thrust: 320, // px/s^2
  drag: 0.5, // 1/s
  maxSpeed: 480, // px/s
};

export function createShip(x, y) {
  return { x, y, vx: 0, vy: 0, angle: -Math.PI / 2, thrusting: false };
}

// Pure physics: takes the old ship, returns a new one. No DOM, no clock,
// no globals, so the same inputs always give the same result.
// `input` only needs an isDown(code) method.
export function integrate(ship, input, dt) {
  const left = input.isDown("ArrowLeft") || input.isDown("KeyA");
  const right = input.isDown("ArrowRight") || input.isDown("KeyD");
  const thrusting = input.isDown("ArrowUp") || input.isDown("KeyW");

  const angle = ship.angle + ((right ? 1 : 0) - (left ? 1 : 0)) * SHIP.turnSpeed * dt;

  let vx = ship.vx;
  let vy = ship.vy;
  if (thrusting) {
    vx += Math.cos(angle) * SHIP.thrust * dt;
    vy += Math.sin(angle) * SHIP.thrust * dt;
  }

  const damping = 1 - SHIP.drag * dt;
  vx *= damping;
  vy *= damping;

  const speed = Math.hypot(vx, vy);
  if (speed > SHIP.maxSpeed) {
    const k = SHIP.maxSpeed / speed;
    vx *= k;
    vy *= k;
  }

  return {
    x: ship.x + vx * dt,
    y: ship.y + vy * dt,
    vx,
    vy,
    angle,
    thrusting,
  };
}
