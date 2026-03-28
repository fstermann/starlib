use tauri::Manager;
use tauri_plugin_shell::ShellExt;

const BACKEND_URL: &str = "http://127.0.0.1:8000";
const HEALTH_MAX_RETRIES: u32 = 30;
const HEALTH_RETRY_INTERVAL_MS: u64 = 500;

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

/// Start the Python backend sidecar and keep a reference to the child process
/// so it can be killed when the app window is closed.
fn start_backend(app: &tauri::AppHandle) {
    let shell = app.shell();
    match shell
        .sidecar("starlib-backend")
        .expect("starlib-backend sidecar not found in bundle")
        .spawn()
    {
        Ok((mut rx, child)) => {
            // Store the child so it lives as long as the app.
            app.manage(std::sync::Mutex::new(Some(child)));

            // Forward stdout/stderr from the sidecar to the Tauri log.
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
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // Wait for backend to be ready before the app continues.
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                if !wait_for_backend_ready().await {
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
