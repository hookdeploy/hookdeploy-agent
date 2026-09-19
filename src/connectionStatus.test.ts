import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connMenuChecks,
  displayableRelay,
  relayInstanceId,
  relaySubtitle,
} from "./connectionStatus";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(root, "src/main.ts"), "utf8");

const leftover = "relay-us-west-01.hookdeploy.dev";
const leftoverId = relayInstanceId(leftover);

const cases: Array<[string, boolean, () => boolean]> = [
  [
    "connecting + leftover relay does not render Connected to X",
    true,
    () => {
      const sub = relaySubtitle("connecting", leftover);
      return sub === null && !JSON.stringify(sub).includes("Connected to");
    },
  ],
  [
    "connecting + leftover relay is not displayable",
    true,
    () => displayableRelay("connecting", leftover) === null,
  ],
  [
    "stop_connect (disconnected) clears displayable relay; subsequent connecting shows no stale relay",
    true,
    () => {
      const afterStop = displayableRelay("disconnected", leftover);
      const afterStart = displayableRelay("connecting", leftover);
      const startSub = relaySubtitle("connecting", leftover);
      return afterStop === null && afterStart === null && startSub === null;
    },
  ],
  [
    "start_connect first emitted Connecting status does not carry previous relay",
    true,
    () => {
      const firstEmit = relaySubtitle("connecting", leftover);
      return firstEmit === null && displayableRelay("connecting", leftover) === null;
    },
  ],
  [
    "reconnecting never renders Connected to",
    true,
    () => {
      const withRelay = relaySubtitle("reconnecting", leftover);
      const without = relaySubtitle("reconnecting", null);
      const text = `${withRelay?.text ?? ""}${without?.text ?? ""}`;
      return (
        !text.includes("Connected to") &&
        (withRelay?.text ?? "").startsWith("Reconnecting") &&
        (without?.text ?? "") === "Reconnecting..."
      );
    },
  ],
  [
    "reconnecting may keep last-known relay as Reconnecting · id",
    true,
    () => {
      const sub = relaySubtitle("reconnecting", leftover);
      return sub?.text === `Reconnecting · ${leftoverId}` && sub.title === leftover;
    },
  ],
  [
    "connected + relay renders Connected to short name",
    true,
    () => {
      const sub = relaySubtitle("connected", leftover);
      return sub?.text === `Connected to ${leftoverId}` && sub.title === leftover;
    },
  ],
  [
    "disconnected / revoked / clock_skew hide the relay line",
    true,
    () =>
      relaySubtitle("disconnected", leftover) === null &&
      relaySubtitle("revoked", leftover) === null &&
      relaySubtitle("clock_skew", leftover) === null,
  ],
  [
    "checkmark: Connected only when connected; Disconnected on disconnected-adjacent; both off while connecting/reconnecting",
    true,
    () => {
      const connected = connMenuChecks("connected");
      const disconnected = connMenuChecks("disconnected");
      const skew = connMenuChecks("clock_skew");
      const revoked = connMenuChecks("revoked");
      const connecting = connMenuChecks("connecting");
      const reconnecting = connMenuChecks("reconnecting");
      return (
        connected.connected &&
        !connected.disconnected &&
        !disconnected.connected &&
        disconnected.disconnected &&
        !skew.connected &&
        skew.disconnected &&
        !revoked.connected &&
        revoked.disconnected &&
        !connecting.connected &&
        !connecting.disconnected &&
        !reconnecting.connected &&
        !reconnecting.disconnected
      );
    },
  ],
  [
    "applyStatus uses relaySubtitle / connMenuChecks, not connectionLive, for display",
    true,
    () => {
      const apply = main.split("function applyStatus").at(1)?.split("function formatPhaseLabel").at(0) ?? "";
      return (
        apply.includes("relaySubtitle(s.phase, s.relay)") &&
        apply.includes("connMenuChecks(s.phase)") &&
        !apply.includes("connectionLive") &&
        !apply.includes("`Connected to ${")
      );
    },
  ],
  [
    "connectionLive still gates Connect/Disconnect actions only",
    true,
    () => {
      const setConn = main.split("async function setConnection").at(1)?.split("function activeOrgId").at(0) ?? "";
      return (
        setConn.includes("connectionLive(connectPhase)") &&
        main.includes("function connectionLive(phase: Phase)")
      );
    },
  ],
];

let failed = 0;
for (const [name, want, run] of cases) {
  const got = run();
  if (got !== want) {
    failed += 1;
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
  }
}
if (failed) {
  throw new Error(`${failed} connectionStatus case(s) failed`);
}
console.log(`ok ${cases.length} connectionStatus cases`);
