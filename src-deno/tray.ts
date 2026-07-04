/**
 * System tray for the Deno desktop shell — parity with src-tauri/src/lib.rs's
 * TrayIconBuilder setup (Show / Hide / Rescan / Quit + left-click toggle).
 */

export async function setupTray(
  win: Deno.BrowserWindow,
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
        win.show();
        win.focus();
        break;
      case "hide":
        win.hide();
        break;
      case "rescan":
        fetch(`${baseUrl}/api/scan`, { method: "POST" }).catch(() => {});
        break;
      case "quit":
        Deno.exit(0);
        break;
    }
  });

  tray.addEventListener("click", () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });

  return tray;
}
