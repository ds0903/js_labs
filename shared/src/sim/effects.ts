export const PICKUP_EFFECTS = ["shield", "rapid", "homing"] as const;
export type PickupEffect = (typeof PICKUP_EFFECTS)[number];
