/** True only when this destination is bound to the live agent id. */
export function destForwardsHere(
  destAgentId: string | null | undefined,
  currentAgentId: string | null | undefined,
): boolean {
  const dest = destAgentId?.trim() || null;
  const live = currentAgentId?.trim() || null;
  return dest !== null && live !== null && dest === live;
}

export function forwardsHere(
  destinations: Array<{ agent_id?: string | null }>,
  currentAgentId: string | null | undefined,
): boolean {
  return destinations.some((d) => destForwardsHere(d.agent_id, currentAgentId));
}
