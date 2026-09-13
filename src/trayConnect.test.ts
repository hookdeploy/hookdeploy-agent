import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = readFileSync(join(root, "src/main.ts"), "utf8");
const tray = readFileSync(join(root, "src-tauri/src/tray.rs"), "utf8");

const cases: Array<[string, boolean, () => boolean]> = [
  [
    "main listens for tray-connect-error and calls showError",
    true,
    () =>
      main.includes('listen<string>("tray-connect-error"') &&
      main.includes("showError(e.payload)"),
  ],
  [
    "tray surfaces connect failures via surface_connect_error",
    true,
    () =>
      tray.includes("pub fn surface_connect_error") &&
      tray.includes('app.emit("tray-connect-error", message)'),
  ],
  [
    "tray connect handler does not swallow start_connect errors",
    true,
    () => {
      const handler = tray.split("fn on_connection_click").at(1) ?? "";
      return (
        handler.includes("if let Err(message) = start_connect") &&
        handler.includes("surface_connect_error(&app, message)") &&
        !handler.includes("let _ = start_connect")
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
  throw new Error(`${failed} trayConnect case(s) failed`);
}
console.log(`ok ${cases.length} trayConnect cases`);
