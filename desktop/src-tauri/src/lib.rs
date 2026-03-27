use tauri::Manager;
use tauri_plugin_shell::ShellExt;

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
        }
        Err(e) => {
            eprintln!("Failed to start backend sidecar: {e}");
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
