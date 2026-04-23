use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

pub mod bpm;
pub mod commands;

/// Returns the app config directory used by both the Rust and Python layers.
/// Matches `platformdirs.user_config_path("com.starlib.Starlib")`.
fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .expect("cannot determine config directory")
        .join("com.starlib.Starlib")
}

use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_shell::ShellExt;

static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

const BACKEND_URL: &str = "http://127.0.0.1:8000";
const HEALTH_MAX_RETRIES: u32 = 30;
const HEALTH_RETRY_INTERVAL_MS: u64 = 500;
const MAX_RESTART_ATTEMPTS: u32 = 3;
const RESTART_DELAY_MS: u64 = 2000;

/// Poll the backend /health endpoint until it responds or retries are exhausted.
async fn wait_for_backend_ready() -> bool {
    let client = reqwest::Client::new();
    for attempt in 1..=HEALTH_MAX_RETRIES {
        match client
            .get(format!("{BACKEND_URL}/health"))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                log::info!("[backend] healthy after {attempt} attempt(s)");
                return true;
            }
            _ => {
                tokio::time::sleep(std::time::Duration::from_millis(HEALTH_RETRY_INTERVAL_MS))
                    .await;
            }
        }
    }
    log::error!("[backend] failed to become healthy after {HEALTH_MAX_RETRIES} retries");
    false
}

/// Spawn the sidecar and forward its output. Returns the child handle.
fn spawn_sidecar(
    app: &tauri::AppHandle,
) -> Result<tauri_plugin_shell::process::CommandChild, String> {
    let shell = app.shell();
    let (mut rx, child) = shell
        .sidecar("starlib-backend")
        .expect("starlib-backend sidecar not found in bundle")
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    log::info!("[backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    log::warn!("[backend:err] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(status) => {
                    log::info!("[backend] process exited: {:?}", status);
                    let _ = handle.emit("backend-disconnected", "Backend process exited");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

/// Start the Python backend sidecar with automatic restart on crash.
/// Keeps a reference to the child process so it can be killed on app close.
fn start_backend(app: &tauri::AppHandle) {
    match spawn_sidecar(app) {
        Ok(child) => {
            app.manage(std::sync::Mutex::new(Some(child)));
            // Spawn a watchdog that monitors and restarts on crash.
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut attempts = 0u32;
                loop {
                    // Sleep before checking — give the sidecar time to run.
                    tokio::time::sleep(std::time::Duration::from_millis(RESTART_DELAY_MS)).await;

                    // Check if the child is still held (None means it exited/was taken).
                    if SHUTTING_DOWN.load(Ordering::SeqCst) {
                        break;
                    }

                    let needs_restart = {
                        if let Some(mutex) = handle.try_state::<std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>>() {
                            if let Ok(guard) = mutex.lock() {
                                guard.is_none()
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    };

                    if !needs_restart {
                        // Still running — reset attempt counter and keep watching.
                        attempts = 0;
                        continue;
                    }

                    attempts += 1;
                    if attempts > MAX_RESTART_ATTEMPTS {
                        log::error!(
                            "[backend] exceeded {MAX_RESTART_ATTEMPTS} restart attempts — giving up"
                        );
                        let _ = handle.emit(
                            "backend-error",
                            "Backend crashed repeatedly and could not be restarted",
                        );
                        break;
                    }

                    log::warn!("[backend] restarting sidecar (attempt {attempts}/{MAX_RESTART_ATTEMPTS})");
                    match spawn_sidecar(&handle) {
                        Ok(child) => {
                            if let Some(mutex) = handle.try_state::<std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>>() {
                                if let Ok(mut guard) = mutex.lock() {
                                    *guard = Some(child);
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("[backend] restart failed: {e}");
                        }
                    }
                }
            });

            // Monitor backend readiness and emit error if it fails.
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let healthy = wait_for_backend_ready().await;
                if !healthy {
                    log::error!("[backend] sidecar did not become ready — app may not work correctly");
                    let _ = handle.emit("backend-error", "Backend failed to start");
                }
            });
        }
        Err(e) => {
            log::error!("Failed to start backend sidecar: {e}");
            let _ = app.emit("backend-error", format!("Failed to start backend: {e}"));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            commands::analyze_local_bpm,
            commands::analyze_sc_bpm,
            commands::open_soundcloud_login,
        ])
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                        path: app_config_dir(),
                        file_name: Some("backend".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(5_242_880) // 5 MB
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            start_backend(&app.handle());

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    log::info!("[deep-link] received: {url}");
                    let _ = handle.emit("deep-link", url.to_string());
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.set_focus();
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Only the main window closing means "app is quitting" —
                // auxiliary windows (e.g. the SoundCloud login webview)
                // open and close during the normal app lifecycle and must
                // not tear down the backend sidecar.
                if window.label() != "main" {
                    return;
                }
                // Signal the watchdog to stop before killing the sidecar.
                SHUTTING_DOWN.store(true, Ordering::SeqCst);
                // Shut down the backend sidecar when the main window is closed.
                // Dropping the child handle closes the stdin pipe; the Python
                // sidecar detects stdin EOF and exits. We also send SIGTERM as
                // a backup (PyInstaller's bootloader forwards it to the child).
                if let Some(mutex) = window.app_handle().try_state::<std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>>() {
                    if let Ok(mut guard) = mutex.lock() {
                        if let Some(child) = guard.take() {
                            let pid = child.pid();
                            // Drop the handle — closes the stdin pipe.
                            drop(child);
                            // Backup: send SIGTERM so the bootloader can
                            // forward it to the actual Python process.
                            #[cfg(unix)]
                            unsafe {
                                libc::kill(pid as i32, libc::SIGTERM);
                            }
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
