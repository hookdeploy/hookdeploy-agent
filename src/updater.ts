/**
 * 8 hours. The agent can stay open for weeks; a few reminders per day is
 * enough. Faster would hit GitHub’s release CDN for no benefit; slower would
 * leave a dismissed update quiet for most of a workday.
 */
export const UPDATE_CHECK_INTERVAL_MS = 8 * 60 * 60 * 1000;

export const RELEASES_PAGE =
  "https://github.com/hookdeploy/hookdeploy-agent/releases";

export type BannerKind = "hidden" | "available" | "installed";

export type CheckOutcome =
  | { kind: "none" }
  | { kind: "available"; version: string }
  | { kind: "error"; message?: string };

export interface UpdaterState {
  availableVersion: string | null;
  banner: BannerKind;
  installing: boolean;
  installed: boolean;
  settingsStatus: string;
}

export interface UpdaterView {
  bannerVisible: boolean;
  bannerKind: BannerKind;
  version: string | null;
  showInstall: boolean;
  showRestart: boolean;
  trayUpdateItem: boolean;
  settingsStatus: string;
}

export function initialUpdaterState(): UpdaterState {
  return {
    availableVersion: null,
    banner: "hidden",
    installing: false,
    installed: false,
    settingsStatus: "Not checked yet.",
  };
}

export function viewFromState(state: UpdaterState): UpdaterView {
  return {
    bannerVisible: state.banner !== "hidden",
    bannerKind: state.banner,
    version: state.availableVersion,
    showInstall: !!state.availableVersion && !state.installed,
    showRestart: state.installed,
    trayUpdateItem: !!state.availableVersion && !state.installed,
    settingsStatus: state.settingsStatus,
  };
}

/**
 * Apply a check result. Dismiss is session-only: an `available` outcome always
 * re-shows the banner, including the same version the user just hid.
 */
export function applyCheckOutcome(
  state: UpdaterState,
  outcome: CheckOutcome,
  interactive: boolean,
): UpdaterState {
  if (state.installing || state.installed) return state;

  if (outcome.kind === "error") {
    return {
      ...state,
      settingsStatus: interactive
        ? outcome.message?.trim() || "Could not check for updates."
        : state.settingsStatus,
    };
  }

  if (outcome.kind === "none") {
    return {
      ...state,
      availableVersion: null,
      banner: "hidden",
      settingsStatus: "You’re up to date.",
    };
  }

  return {
    ...state,
    availableVersion: outcome.version,
    banner: "available",
    settingsStatus: `Version ${outcome.version} is available.`,
  };
}

/** Hide the banner now. Does not record “never ask about this version.” */
export function dismissBanner(state: UpdaterState): UpdaterState {
  return { ...state, banner: "hidden" };
}

/** Tray “Update available” or Settings: show the pending banner again. */
export function showPendingBanner(state: UpdaterState): UpdaterState {
  if (state.installed) return { ...state, banner: "installed" };
  if (state.availableVersion) return { ...state, banner: "available" };
  return state;
}

export function beginInstall(state: UpdaterState): UpdaterState {
  return {
    ...state,
    installing: true,
    settingsStatus: "Downloading update…",
  };
}

export function finishInstall(state: UpdaterState): UpdaterState {
  return {
    ...state,
    installing: false,
    installed: true,
    banner: "installed",
    settingsStatus: "Update installed. Restart to finish.",
  };
}

export function failInstall(state: UpdaterState, message: string): UpdaterState {
  return {
    ...state,
    installing: false,
    settingsStatus: message.trim() || "Could not install the update.",
  };
}

/** After a dismissed restart prompt, the next periodic tick resurfaces it. */
export function remindIfPending(state: UpdaterState): UpdaterState {
  if (state.installed && state.banner === "hidden") {
    return { ...state, banner: "installed" };
  }
  return state;
}

export function releaseUrl(version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `${RELEASES_PAGE}/tag/${encodeURIComponent(tag)}`;
}

export async function runUpdateCheck(
  checkFn: () => Promise<{ version: string } | null>,
): Promise<CheckOutcome> {
  try {
    const update = await checkFn();
    if (!update) return { kind: "none" };
    return { kind: "available", version: update.version };
  } catch (e) {
    return { kind: "error", message: e == null ? undefined : String(e) };
  }
}

/**
 * Fire one check immediately, then again on `intervalMs`. A thrown tick is
 * swallowed so the interval keeps running.
 */
export function startUpdateCheckLoop(
  tick: () => Promise<void>,
  intervalMs: number,
  schedule: {
    setInterval: (handler: () => void, ms: number) => unknown;
    clearInterval: (id: unknown) => void;
  },
): { stop: () => void } {
  let inFlight = false;
  const run = () => {
    if (inFlight) return;
    inFlight = true;
    void tick()
      .catch(() => {
        /* background blip — next interval still fires */
      })
      .finally(() => {
        inFlight = false;
      });
  };
  run();
  const id = schedule.setInterval(run, intervalMs);
  return { stop: () => schedule.clearInterval(id) };
}
