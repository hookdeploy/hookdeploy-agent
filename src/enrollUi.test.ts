import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const main = readFileSync(join(root, "src/main.ts"), "utf8");
const supervisor = readFileSync(join(root, "src-tauri/src/supervisor.rs"), "utf8");

const cases: Array<[string, boolean, () => boolean]> = [
  ["gate has no plain code input", true, () => !html.includes("enroll-code-input")],
  ["OTP mount points exist", true, () => (html.match(/data-enroll-otp/g) ?? []).length === 2],
  ["waiting copy is in both enroll surfaces", true, () =>
    (html.match(/Waiting for you to finish in your browser/g) ?? []).length === 2],
  ["Login hidden once URL is showing", true, () =>
    main.includes("setEnrollLoginVisible(false)") &&
    main.includes('phase.kind === "browser_opened"')],
  ["waiting status replaces Login", true, () =>
    main.includes('el.classList.toggle("hidden", visible)') &&
    main.includes(".enroll-waiting")],
  ["paste handler reads clipboard text", true, () =>
    main.includes('ev.clipboardData?.getData("text")') &&
    main.includes("applyOtpInput")],
  ["tray enroll spawn always sends agent-gui", true, () =>
    supervisor.includes('sidecar(app, ["enroll", "-no-tty", "-client=agent-gui"])') &&
    !supervisor.includes('sidecar(app, ["enroll", "-no-tty"])')],
];

let failed = 0;
for (const [name, want, run] of cases) {
  const got = run();
  if (got !== want) {
    failed += 1;
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
  }
}
if (failed) throw new Error(`${failed} enrollUi case(s) failed`);
console.log(`ok ${cases.length} enrollUi cases`);
