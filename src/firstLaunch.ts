export const FIRST_LAUNCH_KEY = "hookdeploy.firstLaunchDone";

/** True when the first-run pass has not been persisted. Read failures degrade to first-launch. */
export function isFirstLaunch(storage: Pick<Storage, "getItem">): boolean {
  try {
    return storage.getItem(FIRST_LAUNCH_KEY) !== "1";
  } catch {
    return true;
  }
}

/** Persist that first-run has occurred. Returns false if the write failed (next launch will retry). */
export function markFirstLaunchDone(storage: Pick<Storage, "setItem">): boolean {
  try {
    storage.setItem(FIRST_LAUNCH_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export async function setAutostartEnabled(
  want: boolean,
  api: {
    enable: () => Promise<void>;
    disable: () => Promise<void>;
    isEnabled: () => Promise<boolean>;
  },
): Promise<{ enabled: boolean; error: string | null }> {
  try {
    if (want) await api.enable();
    else await api.disable();
  } catch (e) {
    const enabled = await api.isEnabled().catch(() => !want);
    return { enabled, error: e == null ? "Could not update launch at startup." : String(e) };
  }
  try {
    const enabled = await api.isEnabled();
    if (enabled !== want) {
      return { enabled, error: "Could not update launch at startup." };
    }
    return { enabled, error: null };
  } catch (e) {
    return {
      enabled: !want,
      error: e == null ? "Could not read launch-at-startup state." : String(e),
    };
  }
}
