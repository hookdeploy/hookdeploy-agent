import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCheckOutcome,
  dismissBanner,
  initialUpdaterState,
  remindIfPending,
  releaseUrl,
  runUpdateCheck,
  startUpdateCheckLoop,
  UPDATE_CHECK_INTERVAL_MS,
  viewFromState,
} from "./updater";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const main = readFileSync(join(root, "src/main.ts"), "utf8");
const supervisor = readFileSync(join(root, "src-tauri/src/supervisor.rs"), "utf8");
const lib = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");

let failed = 0;

function assert(name: string, got: boolean) {
  if (!got) {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

// 9. An available-update state shows the banner/notification.
{
  const next = applyCheckOutcome(initialUpdaterState(), { kind: "available", version: "0.2.0" }, false);
  const view = viewFromState(next);
  assert("available update shows banner", view.bannerVisible && view.bannerKind === "available");
  assert("available update includes version", view.version === "0.2.0");
  assert("available update offers install", view.showInstall && view.trayUpdateItem);
  assert("available update does not offer restart yet", !view.showRestart);
}

// 10. Dismissing hides immediately; a subsequent check shows it again.
{
  let state = applyCheckOutcome(initialUpdaterState(), { kind: "available", version: "0.2.0" }, false);
  state = dismissBanner(state);
  assert("dismiss hides banner immediately", viewFromState(state).bannerVisible === false);
  assert("dismiss keeps the pending version", state.availableVersion === "0.2.0");
  assert("dismiss is not a never-ask flag", state.banner === "hidden" && !state.installed);
  state = applyCheckOutcome(state, { kind: "available", version: "0.2.0" }, false);
  assert("next check resurfaces the same version", viewFromState(state).bannerVisible && state.banner === "available");
}

// 11. No update available shows nothing.
{
  const next = applyCheckOutcome(initialUpdaterState(), { kind: "none" }, false);
  const view = viewFromState(next);
  assert("no update hides banner", !view.bannerVisible && view.bannerKind === "hidden");
  assert("no update hides tray item", !view.trayUpdateItem && !view.showInstall);
}

// 12. Failed check doesn't surface an error and doesn't crash the periodic timer.
{
  const before = initialUpdaterState();
  const next = applyCheckOutcome(before, { kind: "error", message: "network down" }, false);
  assert("background check error keeps status quiet", next.settingsStatus === before.settingsStatus);
  assert("background check error does not open a banner", next.banner === "hidden");

  const interactive = applyCheckOutcome(before, { kind: "error", message: "network down" }, true);
  assert("interactive check may show settings hint only", interactive.settingsStatus === "network down");
  assert("interactive check error is still not a banner", interactive.banner === "hidden");
}

{
  const ticks: string[] = [];
  let shouldThrow = true;
  const pending: Array<() => void> = [];
  const schedule = {
    setInterval: (handler: () => void, _ms: number) => {
      pending.push(handler);
      return 1;
    },
    clearInterval: (_id: unknown) => {},
  };
  startUpdateCheckLoop(async () => {
    if (shouldThrow) {
      shouldThrow = false;
      ticks.push("throw");
      throw new Error("GitHub unreachable");
    }
    ticks.push("ok");
  }, 1, schedule);

  await new Promise((r) => setTimeout(r, 0));
  assert("first interval tick ran despite throw setup", ticks[0] === "throw");
  pending[0]?.();
  await new Promise((r) => setTimeout(r, 0));
  assert("failed check does not stop the periodic timer", ticks.join(",") === "throw,ok");
}

{
  const outcome = await runUpdateCheck(async () => {
    throw new Error("offline");
  });
  assert("runUpdateCheck maps throw to error outcome", outcome.kind === "error");
}

{
  const eightHours = 8 * 60 * 60 * 1000;
  assert("interval is 8 hours", UPDATE_CHECK_INTERVAL_MS === eightHours);
  assert("release url tags the version", releaseUrl("0.2.0").endsWith("/tag/v0.2.0"));
}

{
  let state = applyCheckOutcome(initialUpdaterState(), { kind: "available", version: "0.2.0" }, false);
  state = dismissBanner(state);
  state = remindIfPending(state);
  assert("remindIfPending does not resurrect a dismissed available banner", state.banner === "hidden");
}

{
  const first = main.indexOf("await runFirstLaunchPass()");
  const loop = main.lastIndexOf("startUpdateCheckLoop");
  assert("check-on-launch is after first-launch pass", first >= 0 && loop > first);
  assert("main window has update banner markup", html.includes('id="update-banner"'));
  assert("banner has Update now and View release", html.includes("Update now") && html.includes("View release"));
  assert("install does not auto-relaunch", !/downloadAndInstall\(\)[\s\S]{0,200}relaunch\(/.test(main));
  assert("restart invokes shutdown_all then relaunch", main.includes('invoke("shutdown_all")') && main.includes("relaunch()"));
  assert("lib exposes shutdown_all command", lib.includes("shutdown_all") && supervisor.includes("pub async fn shutdown_all"));
}

if (failed) {
  throw new Error(`${failed} updater case(s) failed`);
}
console.log("ok updater cases");
