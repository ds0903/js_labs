import { cos, sin } from "./dmath.ts";

// Immutable 2D vector. Every method returns a new vector, the arguments are
// never touched, and Object.freeze makes an accidental `v.x += 1` throw (the
// compiler also refuses it, the fields are readonly).
export class Vector2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
    Object.freeze(this);
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(cos(angle) * length, sin(angle) * length);
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? new Vector2() : this.scale(1 / len);
  }

  rotate(angle: number): Vector2 {
    const c = cos(angle);
    const s = sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
}
