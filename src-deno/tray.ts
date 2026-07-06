/**
 * System tray for the Deno desktop shell — parity with src-tauri/src/lib.rs's
 * TrayIconBuilder setup (Show / Hide / Rescan / Quit).
 *
 * NOTE — no left-click toggle. Under Deno 2.9.1 `deno desktop`, registering a
 * `"click"` listener on a status-bar item that also has a menu and calling
 * `win.hide()` from it terminates the whole process (see the two findings
 * below and docs/deno-vs-tauri.md, Task 4). On macOS a menu-bearing status
 * item already opens its menu on click, so a separate left-click toggle is
 * both redundant and fatal — it is intentionally omitted. Show/Hide live in
 * the menu instead.
 *
 * "Hide" does NOT call win.hide(): hiding the app's only window makes the Deno
 * runtime believe no windows are open and it exits the process. Instead we
 * park the window off-screen (see main.ts's setWindowHidden/restoreWindow),
 * which keeps a window "open" so the runtime stays alive.
 */

export interface TrayWindowControls {
  show: () => void;
  hide: () => void;
}

export async function setupTray(
  controls: TrayWindowControls,
  baseUrl: string,
): Promise<Deno.Tray> {
  const iconBytes = await Deno.readFile(new URL("./icons/tray.png", import.meta.url));

  const tray = new Deno.Tray();
  tray.setIcon(iconBytes);
  tray.setTooltip("Stow Dashboard (Deno)");
  tray.setMenu([
    { item: { label: "Show Dashboard", id: "show", enabled: true } },
    { item: { label: "Hide Dashboard", id: "hide", enabled: true } },
    { item: { label: "Rescan Projects", id: "rescan", enabled: true } },
    { item: { label: "Quit", id: "quit", enabled: true } },
  ]);

  tray.addEventListener("menuclick", (e) => {
    switch (e.detail.id) {
      case "show":
        controls.show();
        break;
      case "hide":
        controls.hide();
        break;
      case "rescan":
        fetch(`${baseUrl}/api/scan`, { method: "POST" }).catch(() => {});
        break;
      case "quit":
        Deno.exit(0);
        break;
    }
  });

  return tray;
}
