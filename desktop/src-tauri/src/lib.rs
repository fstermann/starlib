use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

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
                eprintln!("[backend] healthy after {attempt} attempt(s)");
                return true;
            }
            _ => {
                tokio::time::sleep(std::time::Duration::from_millis(HEALTH_RETRY_INTERVAL_MS))
                    .await;
            }
        }
    }
    eprintln!("[backend] failed to become healthy after {HEALTH_MAX_RETRIES} retries");
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
                    eprintln!("[backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[backend:err] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[backend] process exited: {:?}", status);
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
                        eprintln!(
                            "[backend] exceeded {MAX_RESTART_ATTEMPTS} restart attempts — giving up"
                        );
                        let _ = handle.emit(
                            "backend-error",
                            "Backend crashed repeatedly and could not be restarted",
                        );
                        break;
                    }

                    eprintln!("[backend] restarting sidecar (attempt {attempts}/{MAX_RESTART_ATTEMPTS})");
                    match spawn_sidecar(&handle) {
                        Ok(child) => {
                            if let Some(mutex) = handle.try_state::<std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>>() {
                                if let Ok(mut guard) = mutex.lock() {
                                    *guard = Some(child);
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!("[backend] restart failed: {e}");
                        }
                    }
                }
            });

            // Monitor backend readiness and emit error if it fails.
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let healthy = wait_for_backend_ready().await;
                if !healthy {
                    eprintln!("[backend] sidecar did not become ready — app may not work correctly");
                    let _ = handle.emit("backend-error", "Backend failed to start");
                }
            });
        }
        Err(e) => {
            eprintln!("Failed to start backend sidecar: {e}");
            let _ = app.emit("backend-error", format!("Failed to start backend: {e}"));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            start_backend(&app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Kill the backend sidecar when the main window is closed.
                if let Some(mutex) = window.app_handle().try_state::<std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>>() {
                    if let Ok(mut guard) = mutex.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
