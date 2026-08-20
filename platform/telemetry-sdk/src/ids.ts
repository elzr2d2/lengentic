/**
 * §12's `eventId` (the idempotency key) and `entityId`. Random v4 today.
 *
 * §17 makes the generator injectable (RealClock + a UUIDv7 generator at runtime, a
 * SeededIdGenerator in a mock scenario). That injection point is `p2.sdk-injection`'s
 * deliverable; this packet deliberately keeps the generator internal rather than
 * publishing a surface that packet would then have to change.
 */
export function newId(): string {
  return crypto.randomUUID();
}
