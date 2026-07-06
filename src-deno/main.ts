/**
 * Deno desktop shell entrypoint — parity with src-tauri/src/lib.rs:
 * start server -> wait for port -> window + tray, hide-on-close.
 *
 * Uses getActualBaseUrl() rather than the fixed BASE_URL/PORT constants:
 * under compiled `deno desktop`, the runtime unconditionally redirects the
 * server's listen() to its own auto-assigned port (via DENO_SERVE_ADDRESS),
 * ignoring our requested PORT. See server.ts's module doc comment for the
 * full finding. getActualBaseUrl() returns the real address in both modes.
 *
 * Hide-on-close (Deno 2.9.1 finding, see docs/deno-vs-tauri.md Task 4):
 * The obvious implementation — preventDefault() on "close" then win.hide() —
 * terminates the process. Hiding the app's ONLY window makes the Deno desktop
 * runtime consider the app to have no open windows, so it exits (verified: a
 * pending never-resolving promise and a live tray do NOT keep it alive across
 * hide()). There is no minimize() API. So "hidden" is emulated by parking the
 * window off-screen, which keeps a window "open" and the runtime alive; the
 * tray's Show restores it to its previous on-screen position.
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

// Off-screen "hide": last-saved on-screen position, and a parking spot far
// off any display. macOS clamps extreme coordinates, but a full screen-width
// negative offset is enough to move the window fully out of view.
const OFF_SCREEN: [number, number] = [-32000, -32000];
let savedPos: [number, number] = win.getPosition() as [number, number];
let hidden = false;

function hideWindow(): void {
  if (hidden) return;
  savedPos = win.getPosition() as [number, number];
  win.setPosition(OFF_SCREEN[0], OFF_SCREEN[1]);
  hidden = true;
}

function showWindow(): void {
  if (hidden) {
    win.setPosition(savedPos[0], savedPos[1]);
    hidden = false;
  }
  win.show();
  win.focus();
}

// Hide instead of quitting when the red-X is clicked (parity with Tauri's
// prevent_close). We must NOT call win.hide() here — see the module doc above.
win.addEventListener("close", (e) => {
  e.preventDefault();
  hideWindow();
});

const tray = await setupTray({ show: showWindow, hide: hideWindow }, baseUrl);
void tray; // keep alive for the app's lifetime
