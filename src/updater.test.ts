import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCheckOutcome,
  beginInstall,
  dismissBanner,
  failInstall,
  finishInstall,
  initialUpdaterState,
  remindIfPending,
  releaseUrl,
  runUpdateCheck,
  showPendingBanner,
  sidecarIsBusy,
  startUpdateCheckLoop,
  UPDATE_CHECK_INTERVAL_MS,
  updateInterruptMessage,
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

// Install lifecycle: begin → finish (distinct from available).
{
  const available = applyCheckOutcome(initialUpdaterState(), { kind: "available", version: "0.2.0" }, false);
  let state = beginInstall(available);
  assert("beginInstall sets installing", state.installing);
  assert("beginInstall shows downloading status", state.settingsStatus === "Downloading update…");
  const mid = viewFromState(state);
  assert("beginInstall keeps install offer visible", mid.showInstall && !mid.showRestart);
  assert("beginInstall keeps available banner kind", mid.bannerKind === "available");
  assert("main disables banner action while installing", main.includes("action.disabled = next.installing"));

  state = finishInstall(state);
  const installed = viewFromState(state);
  const availView = viewFromState(available);
  assert("finishInstall clears installing and marks installed", !state.installing && state.installed);
  assert("finishInstall shows installed banner", installed.bannerKind === "installed" && installed.bannerVisible);
  assert("finishInstall offers restart not install", installed.showRestart && !installed.showInstall);
  assert("finishInstall hides tray update item", !installed.trayUpdateItem);
  assert(
    "finishInstall status prompts restart",
    state.settingsStatus === "Update installed. Restart to finish.",
  );
  assert(
    "installed state is distinct from available",
    availView.bannerKind === "available" && availView.showInstall && !availView.showRestart,
  );
}

// remindIfPending: resurfacing a dismissed restart prompt (installed case).
{
  let state = finishInstall(
    beginInstall(applyCheckOutcome(initialUpdaterState(), { kind: "available", version: "0.2.0" }, false)),
  );
  state = dismissBanner(state);
  assert("dismiss hides installed restart banner", state.banner === "hidden" && state.installed);
  state = remindIfPending(state);
  const view = viewFromState(state);
  assert("remindIfPending resurfaces installed restart prompt", state.banner === "installed");
  assert("resurfaced installed banner offers restart", view.showRestart && view.bannerVisible);
}

// failInstall: error surfaced, not stuck installing, retry still available.
{
  let state = beginInstall(
    applyCheckOutcome(initialUpdaterState(), { kind: "available", version: "0.2.0" }, false),
  );
  state = failInstall(state, "download failed");
  assert("failInstall clears installing", !state.installing);
  assert("failInstall surfaces error in settings", state.settingsStatus === "download failed");
  assert("failInstall keeps pending version for retry", state.availableVersion === "0.2.0" && !state.installed);
  const view = viewFromState(state);
  assert("failInstall leaves user able to retry install", view.showInstall && view.bannerKind === "available");
  assert(
    "failInstall default message when blank",
    failInstall(beginInstall(initialUpdaterState()), "  ").settingsStatus ===
      "Could not install the update.",
  );
}

// showPendingBanner: tray menu resurface for available and installed states.
{
  let state = applyCheckOutcome(initialUpdaterState(), { kind: "available", version: "0.2.0" }, false);
  state = dismissBanner(state);
  state = showPendingBanner(state);
  const availableView = viewFromState(state);
  assert("showPendingBanner resurfaces available update banner", state.banner === "available");
  assert("showPendingBanner restores tray update item", availableView.trayUpdateItem);
  assert(
    "tray click wires showPendingBanner",
    main.includes('listen("update-tray-clicked"') && main.includes("showPendingBanner(updaterState)"),
  );

  const installed = finishInstall(
    beginInstall(applyCheckOutcome(initialUpdaterState(), { kind: "available", version: "0.2.0" }, false)),
  );
  const dismissed = dismissBanner(installed);
  const resurfaced = showPendingBanner(dismissed);
  const installedView = viewFromState(resurfaced);
  assert("showPendingBanner resurfaces installed restart from tray", resurfaced.banner === "installed");
  assert("installed tray resurface offers restart not install", installedView.showRestart && !installedView.showInstall);
  assert(
    "showPendingBanner noop when nothing pending",
    showPendingBanner(initialUpdaterState()).banner === "hidden",
  );
}

// Checks are ignored while installing or after install completes.
{
  const installing = beginInstall(
    applyCheckOutcome(initialUpdaterState(), { kind: "available", version: "0.2.0" }, false),
  );
  assert(
    "check ignored while installing",
    applyCheckOutcome(installing, { kind: "none" }, false) === installing,
  );
  const installed = finishInstall(installing);
  assert(
    "check ignored after install completes",
    applyCheckOutcome(installed, { kind: "available", version: "0.3.0" }, false) === installed,
  );
}

{
  const first = main.indexOf("await runFirstLaunchPass()");
  const loop = main.lastIndexOf("startUpdateCheckLoop");
  assert("check-on-launch is after first-launch pass", first >= 0 && loop > first);
  assert("main window has update banner markup", html.includes('id="update-banner"'));
  assert("banner has Update now and View release", html.includes("Update now") && html.includes("View release"));
  assert("install does not auto-relaunch", !/downloadAndInstall\(\)[\s\S]{0,200}relaunch\(/.test(main));
  assert(
    "install stops sidecars before downloadAndInstall",
    main.indexOf("shutdown_for_update") < main.indexOf("downloadAndInstall"),
  );
  assert(
    "restart invokes shutdown_for_update then relaunch",
    main.includes('invoke("shutdown_for_update")') && main.includes("relaunch()"),
  );
  assert(
    "lib exposes shutdown_for_update command",
    lib.includes("shutdown_for_update") && supervisor.includes("pub async fn shutdown_for_update"),
  );
  assert(
    "active taps prompt before update install",
    main.includes("askInstallUpdateWithActiveWork") && main.includes("updateInterruptMessage"),
  );
}

{
  assert(
    "busy sidecar blocks silent update",
    sidecarIsBusy({ activeTaps: 1, connectRunning: false, enrollRunning: false }),
  );
  assert(
    "idle sidecar allows update",
    !sidecarIsBusy({ activeTaps: 0, connectRunning: false, enrollRunning: false }),
  );
  assert(
    "update interrupt message mentions taps",
    updateInterruptMessage({ activeTaps: 2, connectRunning: false, enrollRunning: false }).includes(
      "2 active taps",
    ),
  );
}

if (failed) {
  throw new Error(`${failed} updater case(s) failed`);
}
console.log("ok updater cases");
