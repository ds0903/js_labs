// Branded numbers: at runtime plain numbers, for the compiler three different
// things. `Seq` cannot be passed where a `Tick` is expected, and none of them
// is a bare `number` that anybody computed. The only way to get one is a
// checking function, so a value of the type has been range-checked once.
declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type EntityId = Brand<number, "EntityId">; // 16 bit protocol id
export type Tick = Brand<number, "Tick">; // server tick, u32
export type Seq = Brand<number, "Seq">; // number of a player's input, u32

const isUint = (n: number, max: number) => Number.isInteger(n) && n >= 0 && n <= max;

// type predicates: no `as` needed, the check is the proof
export const isEntityId = (n: number): n is EntityId => isUint(n, 0xffff);
export const isTick = (n: number): n is Tick => isUint(n, 0xffffffff);
export const isSeq = (n: number): n is Seq => isUint(n, 0xffffffff);

export function entityId(n: number): EntityId {
  if (!isEntityId(n)) throw new RangeError(`not an entity id: ${n}`);
  return n;
}

export function tick(n: number): Tick {
  if (!isTick(n)) throw new RangeError(`not a tick: ${n}`);
  return n;
}

export function seq(n: number): Seq {
  if (!isSeq(n)) throw new RangeError(`not a seq: ${n}`);
  return n;
}

// only the low 16 bits of an id fit into the protocol
export const id16 = (id: number): EntityId => entityId(id & 0xffff);
