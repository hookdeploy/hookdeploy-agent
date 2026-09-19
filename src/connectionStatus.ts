/** Window connection widget — display only. Native tray labels live in tray.rs. */

export type ConnectPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "revoked"
  | "clock_skew";

export function relayInstanceId(relay: string): string {
  const host = relay.split("/")[0].split(":")[0];
  const name = host.split(".")[0] ?? host;
  return name.replace(/^relay-/i, "") || relay;
}

/**
 * Relay hostname allowed to paint for this phase.
 *
 * Connecting / disconnected-adjacent drop leftovers so a prior session's
 * hostname cannot show during spawn→dial or after stop/terminate.
 * Reconnecting keeps the last-known relay (intentional); the subtitle
 * must still not say "Connected to".
 */
export function displayableRelay(
  phase: ConnectPhase,
  incoming: string | null | undefined,
): string | null {
  const relay = incoming?.trim() || null;
  if (!relay) return null;
  if (phase === "connected" || phase === "reconnecting") return relay;
  return null;
}

export function relaySubtitle(
  phase: ConnectPhase,
  incoming: string | null | undefined,
): { text: string; title: string | null } | null {
  const relay = displayableRelay(phase, incoming);
  if (phase === "connected" && relay) {
    return { text: `Connected to ${relayInstanceId(relay)}`, title: relay };
  }
  if (phase === "connecting") {
    return null;
  }
  if (phase === "reconnecting") {
    if (relay) {
      return { text: `Reconnecting · ${relayInstanceId(relay)}`, title: relay };
    }
    return { text: "Reconnecting...", title: null };
  }
  return null;
}

export function connMenuChecks(phase: ConnectPhase): {
  connected: boolean;
  disconnected: boolean;
} {
  return {
    connected: phase === "connected",
    disconnected:
      phase === "disconnected" || phase === "clock_skew" || phase === "revoked",
  };
}
