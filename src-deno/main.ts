/**
 * Deno desktop shell entrypoint — parity with src-tauri/src/lib.rs:
 * start server -> wait for port -> window + tray, hide-on-close.
 *
 * Uses getActualBaseUrl() rather than the fixed BASE_URL/PORT constants:
 * under compiled `deno desktop`, the runtime unconditionally redirects the
 * server's listen() to its own auto-assigned port (via DENO_SERVE_ADDRESS),
 * ignoring our requested PORT. See server.ts's module doc comment for the
 * full finding. getActualBaseUrl() returns the real address in both modes.
 */

import { getActualBaseUrl, startServer, waitForServer } from "./server.ts";
import { setupTray } from "./tray.ts";

await startServer();

const baseUrl = getActualBaseUrl();

const ready = await waitForServer(baseUrl, 15_000);
if (!ready) {
  console.error(`[Stow/Deno] server did not come up on ${baseUrl} within 15s`);
  Deno.exit(1);
}

const win = new Deno.BrowserWindow({
  title: "Stow Dashboard (Deno)",
  width: 1400,
  height: 900,
});
win.navigate(baseUrl);
win.show();
win.focus();

// Hide instead of closing when X is clicked (same as Tauri prevent_close).
win.addEventListener("close", (e) => {
  e.preventDefault();
  win.hide();
});

const tray = await setupTray(win, baseUrl);
void tray; // keep alive for the app's lifetime
