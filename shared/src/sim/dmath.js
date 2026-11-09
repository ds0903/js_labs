// sin, cos and atan2 that give the same bits in every JavaScript engine.
//
// Math.sin, Math.cos and Math.atan2 are only required to be "approximately"
// right, and engines differ in the last bit: Chrome 156 and Node 24 disagree
// on about half of the inputs (measured, see README). A prediction on the
// client that differs by one bit from the server drifts away over time, so
// the simulation does not call them. + - * / and Math.sqrt are exactly
// specified by IEEE 754, so everything below is built from those.
//
// Accuracy is about 1e-15, which is more than the game needs.

const PIO2_HI = 1.5707963267341256; // pi/2 split in two parts: k * PIO2_HI is exact
const PIO2_LO = 6.077100506506192e-11; // for the k we meet (Cody-Waite reduction)
const PIO2_LO2 = 2.0222662487959506e-21;
const PI = Math.PI;
const HALF_PI = 1.5707963267948966;

// reduce x to r in [-pi/4, pi/4] and the quadrant n (0..3), x = n*pi/2 + r
function reduce(x) {
  const k = Math.round(x / HALF_PI);
  const r = x - k * PIO2_HI - k * PIO2_LO - k * PIO2_LO2;
  return [r, ((k % 4) + 4) % 4];
}

// Taylor series, 9 terms are far below 1e-16 on [-pi/4, pi/4]
function sinPoly(r) {
  const r2 = r * r;
  return (
    r *
    (1 +
      r2 *
        (-1 / 6 +
          r2 *
            (1 / 120 +
              r2 *
                (-1 / 5040 +
                  r2 *
                    (1 / 362880 +
                      r2 *
                        (-1 / 39916800 +
                          r2 * (1 / 6227020800 + r2 * (-1 / 1307674368000))))))))
  );
}

function cosPoly(r) {
  const r2 = r * r;
  return (
    1 +
    r2 *
      (-1 / 2 +
        r2 *
          (1 / 24 +
            r2 *
              (-1 / 720 +
                r2 *
                  (1 / 40320 +
                    r2 *
                      (-1 / 3628800 + r2 * (1 / 479001600 + r2 * (-1 / 87178291200)))))))
  );
}

export function sin(x) {
  const [r, n] = reduce(x);
  if (n === 0) return sinPoly(r);
  if (n === 1) return cosPoly(r);
  if (n === 2) return -sinPoly(r);
  return -cosPoly(r);
}

export function cos(x) {
  const [r, n] = reduce(x);
  if (n === 0) return cosPoly(r);
  if (n === 1) return -sinPoly(r);
  if (n === 2) return -cosPoly(r);
  return sinPoly(r);
}

// atan for any t: halve the angle twice with t / (1 + sqrt(1 + t^2)) until
// |t| is small, then a Taylor series
function atan(t) {
  const negative = t < 0;
  let a = negative ? -t : t;
  let inverted = false;
  if (a > 1) {
    a = 1 / a;
    inverted = true;
  }
  a = a / (1 + Math.sqrt(1 + a * a));
  a = a / (1 + Math.sqrt(1 + a * a));
  const a2 = a * a;
  let result =
    a *
    (1 +
      a2 *
        (-1 / 3 +
          a2 *
            (1 / 5 +
              a2 *
                (-1 / 7 +
                  a2 *
                    (1 / 9 +
                      a2 *
                        (-1 / 11 + a2 * (1 / 13 + a2 * (-1 / 15 + a2 * (1 / 17)))))))));
  result *= 4; // two halvings
  if (inverted) result = HALF_PI - result;
  return negative ? -result : result;
}

export function atan2(y, x) {
  if (x === 0 && y === 0) return 0;
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  return y > 0 ? HALF_PI : -HALF_PI;
}

// any angle into (-pi, pi]
export const normalizeAngle = (angle) => atan2(sin(angle), cos(angle));
