import { cos, sin } from "./dmath.js";

// Immutable 2D vector. Every method returns a new vector, the arguments are
// never touched, and Object.freeze makes an accidental `v.x += 1` throw.
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
    Object.freeze(this);
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(cos(angle) * length, sin(angle) * length);
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  normalize() {
    const len = this.length();
    return len === 0 ? new Vector2() : this.scale(1 / len);
  }

  rotate(angle) {
    const c = cos(angle);
    const s = sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
}
