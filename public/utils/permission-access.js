/**
 * A capability is a summary deviation only when its effective value differs
 * from that capability's shipped default. Capabilities are not uniformly
 * opt-in: fasting ships allowed while household note-category management does
 * not, so comparing every capability with one global default inverts one of
 * the two states.
 */
export function isPermissionDeviation(item, effectiveAccess) {
  return effectiveAccess !== (item?.default ?? 'none');
}
