use std::process::{Command, Child, Stdio};
use std::sync::Mutex;
use std::path::PathBuf;
use std::net::TcpStream;
use std::fs;
use std::collections::HashMap;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    Manager, AppHandle, WebviewWindowBuilder, WebviewUrl,
};

const PORT: u16 = 3088;

struct ServerProcess(Mutex<Option<Child>>);

fn get_standalone_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().ok()?;
        let resources = exe.parent()?.parent()?.join("Resources").join("standalone");
        if resources.exists() {
            return Some(resources);
        }
    }

    // Fallback for development
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.clone();
    for _ in 0..10 {
        dir = dir.parent()?.to_path_buf();
        let standalone = dir.join(".next").join("standalone");
        if standalone.join("server.js").exists() {
            return Some(standalone);
        }
    }

    None
}

fn parse_env_file(path: &PathBuf) -> HashMap<String, String> {
    let mut env_vars = HashMap::new();

    if let Ok(content) = fs::read_to_string(path) {
        for line in content.lines() {
            let line = line.trim();
            // Skip empty lines and comments
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            // Parse KEY=VALUE
            if let Some(pos) = line.find('=') {
                let key = line[..pos].trim().to_string();
                let value = line[pos + 1..].trim().to_string();
                env_vars.insert(key, value);
            }
        }
    }

    env_vars
}

fn start_server() -> Option<Child> {
    let standalone_dir = get_standalone_dir()?;
    let server_js = standalone_dir.join("server.js");
    let env_file = standalone_dir.join(".env.local");

    if !server_js.exists() {
        return None;
    }

    // Parse .env.local and pass as environment variables
    let env_vars = parse_env_file(&env_file);

    let mut cmd = Command::new("node");
    cmd.arg("server.js")
        .env("PORT", PORT.to_string())
        .env("HOSTNAME", "localhost")
        .current_dir(&standalone_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Add all env vars from .env.local
    for (key, value) in env_vars {
        cmd.env(key, value);
    }

    cmd.spawn().ok()
}

fn wait_for_server(timeout_secs: u64) -> bool {
    let addr = format!("localhost:{}", PORT);
    let start = std::time::Instant::now();

    while start.elapsed().as_secs() < timeout_secs {
        if TcpStream::connect(&addr).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    false
}

fn trigger_rescan() {
    let url = format!("http://localhost:{}/api/scan", PORT);
    std::thread::spawn(move || {
        let _ = Command::new("curl")
            .args(["-X", "POST", &url])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
    });
}

fn show_or_create_window(app: &AppHandle) {
    let url = format!("http://localhost:{}", PORT);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        if let Ok(window) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
            .title("Stow Dashboard")
            .inner_size(1400.0, 900.0)
            .min_inner_size(800.0, 600.0)
            .center()
            .build()
        {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    } else {
        show_or_create_window(app);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            // Start the Node.js server
            if let Some(child) = start_server() {
                let state: tauri::State<ServerProcess> = app.state();
                *state.0.lock().unwrap() = Some(child);
            }

            // Build tray menu
            let show_item = MenuItem::with_id(app, "show", "Show Dashboard", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "Hide Dashboard", true, None::<&str>)?;
            let rescan_item = MenuItem::with_id(app, "rescan", "Rescan Projects", true, None::<&str>)?;
            let separator = MenuItem::with_id(app, "sep", "─────────────", false, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[
                &show_item,
                &hide_item,
                &rescan_item,
                &separator,
                &quit_item,
            ])?;

            // Create tray icon
            let app_handle = app.handle().clone();
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Stow Dashboard")
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_window(&app_handle);
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => show_or_create_window(app),
                        "hide" => hide_window(app),
                        "rescan" => trigger_rescan(),
                        "quit" => {
                            if let Some(state) = app.try_state::<ServerProcess>() {
                                if let Ok(mut guard) = state.0.lock() {
                                    if let Some(ref mut child) = *guard {
                                        let _ = child.kill();
                                    }
                                }
                            }
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Wait for server to start, then show window
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if wait_for_server(15) {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    show_or_create_window(&handle);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
