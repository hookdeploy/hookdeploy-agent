import {
  FIRST_LAUNCH_KEY,
  isFirstLaunch,
  markFirstLaunchDone,
  setAutostartEnabled,
} from "./firstLaunch";

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

class ThrowingStorage {
  getItem(_key: string): string | null {
    throw new Error("denied");
  }
  setItem(_key: string, _value: string): void {
    throw new Error("denied");
  }
}

const cases: Array<[string, boolean, () => boolean]> = [
  ["fresh storage is first launch", true, () => isFirstLaunch(new MemoryStorage())],
  ["flag set is not first launch", false, () => {
    const s = new MemoryStorage();
    s.setItem(FIRST_LAUNCH_KEY, "1");
    return isFirstLaunch(s);
  }],
  ["empty flag still first launch", true, () => {
    const s = new MemoryStorage();
    s.setItem(FIRST_LAUNCH_KEY, "");
    return isFirstLaunch(s);
  }],
  ["read throw degrades to first launch", true, () => isFirstLaunch(new ThrowingStorage())],
  ["write success persists", true, () => {
    const s = new MemoryStorage();
    return markFirstLaunchDone(s) && s.getItem(FIRST_LAUNCH_KEY) === "1" && !isFirstLaunch(s);
  }],
  ["write throw returns false and stays first launch", true, () => {
    const s = new ThrowingStorage();
    return !markFirstLaunchDone(s) && isFirstLaunch(s);
  }],
];

let failed = 0;
for (const [name, want, run] of cases) {
  const got = run();
  if (got !== want) {
    failed += 1;
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
  }
}

async function autostartCases() {
  const state = { enabled: false };
  const okApi = {
    enable: async () => {
      state.enabled = true;
    },
    disable: async () => {
      state.enabled = false;
    },
    isEnabled: async () => state.enabled,
  };
  const on = await setAutostartEnabled(true, okApi);
  if (!on.enabled || on.error) {
    failed += 1;
    console.error("FAIL enable success", on);
  }
  const off = await setAutostartEnabled(false, okApi);
  if (off.enabled || off.error) {
    failed += 1;
    console.error("FAIL disable success", off);
  }

  const failEnable = {
    enable: async () => {
      throw new Error("os denied");
    },
    disable: async () => {
      state.enabled = false;
    },
    isEnabled: async () => false,
  };
  const denied = await setAutostartEnabled(true, failEnable);
  if (denied.enabled || denied.error !== "Error: os denied") {
    failed += 1;
    console.error("FAIL enable denied reflects OS state", denied);
  }

  const lie = {
    enable: async () => {},
    disable: async () => {},
    isEnabled: async () => false,
  };
  const drifted = await setAutostartEnabled(true, lie);
  if (drifted.enabled || !drifted.error) {
    failed += 1;
    console.error("FAIL enable no-op still reports OS false", drifted);
  }
}

await autostartCases();

if (failed) {
  throw new Error(`${failed} firstLaunch case(s) failed`);
}
console.log(`ok ${cases.length} firstLaunch cases plus autostart`);
