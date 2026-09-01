import { destForwardsHere, forwardsHere } from "./forwardsHere";

const current = "agent-live";
const leftover = "agent-from-last-enrollment";

const cases: Array<[string, boolean, () => boolean]> = [
  ["null dest never matches", false, () => destForwardsHere(null, current)],
  ["undefined dest never matches", false, () => destForwardsHere(undefined, current)],
  ["empty dest never matches", false, () => destForwardsHere("  ", current)],
  ["null current never matches a bound dest", false, () => destForwardsHere(current, null)],
  ["stale cached id does not match", false, () => destForwardsHere(leftover, current)],
  ["exact current id matches", true, () => destForwardsHere(current, current)],
  ["endpoint: any dest null → not here", false, () =>
    forwardsHere([{ agent_id: null }, { agent_id: leftover }], current)],
  ["endpoint: only exact current id → here", true, () =>
    forwardsHere([{ agent_id: null }, { agent_id: current }], current)],
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
  throw new Error(`${failed} forwardsHere case(s) failed`);
}
console.log(`ok ${cases.length} forwardsHere cases`);
