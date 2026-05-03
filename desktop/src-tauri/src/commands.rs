//! Tauri commands exposed to the frontend via `invoke`.
//!
//! Keep this file as a thin adapter: parameter parsing, type conversion for
//! the JSON boundary, and error mapping to strings. Real work lives in the
//! underlying modules.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl};
use tokio::sync::{oneshot, Semaphore};

use crate::bpm::types::AnalysisMode;
use crate::bpm::{self, BpmOptions, Confidence};

/// Global bound on concurrent blocking BPM analysis tasks.
///
/// Tauri's `spawn_blocking` pool is shared with the rest of the app; without
/// a bound a bulk-analyze run would flood it. Size the semaphore to logical
/// CPU count so we saturate cores without starving other blocking work.
fn analysis_semaphore() -> &'static Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| {
        let n = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        Arc::new(Semaphore::new(n))
    })
}

/// JSON representation of a `BpmResult` across the invoke boundary.
#[derive(Serialize)]
pub struct BpmResponse {
    /// Detected BPM as float. Backend rounds to int at persistence time.
    pub bpm: f32,
    pub confidence: &'static str,
    /// Original pre-correction BPM when octave correction fired.
    pub corrected_from: Option<f32>,
    pub algorithm_version: u16,
}

fn confidence_str(c: Confidence) -> &'static str {
    match c {
        Confidence::High => "high",
        Confidence::Medium => "medium",
        Confidence::Low => "low",
    }
}

fn to_response(r: bpm::BpmResult) -> BpmResponse {
    BpmResponse {
        bpm: r.bpm,
        confidence: confidence_str(r.confidence),
        corrected_from: r.corrected_from,
        algorithm_version: r.algorithm_version,
    }
}

/// Analyze BPM for a local audio file.
///
/// Runs synchronously on a blocking thread (the decode + analyze together
/// take ~50 ms on a typical track); Tauri invoke handlers can be called from
/// async contexts so no extra wrapper is needed for responsiveness.
///
/// # Parameters
/// - `consensus`: when `true`, run the analyzer on three windows spaced
///   across the track (25% / 50% / 75%) and take the median. This is a
///   **robustness** toggle — it protects against intro/breakdown/outro
///   sections that would mislead a single-window read — not a precision
///   toggle. Per-window analysis uses the same algorithm either way.
///   Costs roughly 3× CPU for the analyze step (decode only runs once).
///   Param name is part of the wire contract; see the frontend `invoke` call.
#[tauri::command]
pub async fn analyze_local_bpm(
    path: String,
    consensus: Option<bool>,
) -> Result<BpmResponse, String> {
    let sem = analysis_semaphore().clone();
    let _permit = sem
        .acquire_owned()
        .await
        .map_err(|e| format!("analysis semaphore closed: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = _permit; // hold across the blocking work
        let mut options = BpmOptions::default();
        if consensus.unwrap_or(false) {
            options.mode = AnalysisMode::Consensus;
        }
        let result = bpm::local::analyze_local_file(&PathBuf::from(&path), 30.0, 15.0, &options)
            .map_err(|e| e.to_string())?;
        Ok::<_, String>(to_response(result))
    })
    .await
    .map_err(|e| format!("analysis task failed: {e}"))?
}

/// Analyze BPM for a SoundCloud track via its HLS stream.
///
/// The OAuth Client-Credentials token is supplied by the caller; this
/// command doesn't touch credentials. See
/// ``backend/api/bpm.py::get_soundcloud_client_token``.
#[tauri::command]
pub async fn analyze_sc_bpm(
    track_id: u64,
    token: String,
    consensus: Option<bool>,
) -> Result<BpmResponse, String> {
    let mut options = BpmOptions::default();
    if consensus.unwrap_or(false) {
        options.mode = AnalysisMode::Consensus;
    }
    let result = bpm::soundcloud::analyze_sc_track(track_id, &token, &options)
        .await
        .map_err(|e| e.to_string())?;
    Ok(to_response(result))
}


// ----- SoundCloud login window -----
//
// Opens SoundCloud's OAuth2 authorize URL inside an in-app WebviewWindow so
// we can (a) run the existing authorization-code flow unchanged and (b)
// scrape the `oauth_token` session cookie out of the webview's cookie jar
// once login completes. That cookie is required to talk to SoundCloud's
// internal `api-v2.soundcloud.com` — the only endpoint that exposes the
// user's system playlists (Weekly Wave / Daily Drops / Your Mix N). The
// OAuth2 access token minted by this flow cannot reach api-v2 (403), hence
// the need for the cookie.
//
// We deliberately use Rust-side `on_new_window` to honor popups (Google/
// Apple/Facebook SSO) — the JS-side config path is broken in Tauri >=2.3
// (upstream issue tauri#14263).

const SC_LOGIN_WINDOW_LABEL: &str = "sc-login";
// Stable identifier → persistent WKWebsiteDataStore on macOS. User logs in
// once, stays logged in across reconnects.
const SC_LOGIN_DATA_STORE: [u8; 16] = *b"starlib-sc-auth!";
// Modern Safari UA. Some providers reject their own embedded-webview UA for
// SSO flows; impersonating plain Safari avoids that class of failures.
const SC_LOGIN_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15";
// The backend's Tauri return_to URL. When the webview lands here, the
// OAuth2 code exchange has already happened server-side; it's safe to
// harvest cookies and close the window.
const SC_DONE_URL_PREFIX: &str = "http://127.0.0.1:8000/auth/soundcloud/done";
// Where we bounce the webview after OAuth completes. secure.soundcloud.com
// and api-auth.soundcloud.com hold the identity-provider session, but the
// `.soundcloud.com` cookie jar (where `oauth_token` lives) is only written
// when the main web app establishes a session — which requires a hit to
// soundcloud.com itself. Navigating here converts IdP session → web
// session and lets us harvest `oauth_token` below.
const SC_POST_AUTH_URL: &str = "https://soundcloud.com/";
// Max time to wait for soundcloud.com to issue `oauth_token` after the
// post-auth navigation. Anything longer means auto-session promotion
// didn't happen — the cookie is unreachable without a manual login.
const SC_COOKIE_WAIT_SECS: u64 = 8;

#[derive(Serialize, Clone, Debug)]
pub struct CapturedAuth {
    /// api-v2 web-session token lifted from the SoundCloud cookie jar.
    /// `None` if login was cancelled or the cookie wasn't set (older
    /// accounts, unusual auth flows). OAuth2 tokens are still captured
    /// via the normal /redirect → /result pipeline regardless.
    pub oauth_token: Option<String>,
    /// `true` when the user reached the redirect page; `false` when the
    /// window was closed before login completed.
    pub completed: bool,
}

/// Open SoundCloud's OAuth authorize URL in an in-app webview window and
/// wait until login completes (or the window is closed). Returns any
/// `oauth_token` cookie found for https://soundcloud.com at that point.
#[tauri::command]
pub async fn open_soundcloud_login<R: Runtime>(
    app: AppHandle<R>,
    auth_url: String,
) -> Result<CapturedAuth, String> {
    let url = Url::parse(&auth_url).map_err(|e| format!("invalid auth_url: {e}"))?;

    // Reuse the window if it somehow leaked from a previous attempt.
    if let Some(existing) = app.get_webview_window(SC_LOGIN_WINDOW_LABEL) {
        let _ = existing.close();
        // Give the runtime a moment to drop the window before rebuilding.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let (tx, rx) = oneshot::channel::<bool>();
    let signal = Arc::new(Mutex::new(Some(tx)));

    let signal_page = signal.clone();
    let signal_close = signal.clone();

    let mut builder = WebviewWindowBuilder::new(
        &app,
        SC_LOGIN_WINDOW_LABEL,
        WebviewUrl::External(url),
    )
    .title("Sign in to SoundCloud")
    .inner_size(520.0, 740.0)
    .min_inner_size(380.0, 520.0)
    .resizable(true)
    .user_agent(SC_LOGIN_USER_AGENT)
    .on_new_window(|url, _features| {
        // Let the OS/webview handle SSO popups natively. On macOS WKWebView
        // the popup inherits our parent's WKWebsiteDataStore, so cookies
        // roundtrip correctly. Returning Create{} with a Tauri child would
        // also work but isolates the data store — which breaks SSO.
        log::info!("[sc-login] allow popup: {url}");
        NewWindowResponse::Allow
    })
    .on_page_load(move |_window, payload| {
        let u = payload.url().as_str();
        log::info!("[sc-login] page loaded: {u}");
        if u.starts_with(SC_DONE_URL_PREFIX) {
            if let Ok(mut slot) = signal_page.lock() {
                if let Some(tx) = slot.take() {
                    let _ = tx.send(true);
                }
            }
        }
    });

    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(SC_LOGIN_DATA_STORE);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let dir = dirs::config_dir()
            .ok_or_else(|| "cannot determine config dir".to_string())?
            .join("com.starlib.Starlib")
            .join("sc-webview");
        builder = builder.data_directory(dir);
    }

    let window = builder
        .build()
        .map_err(|e| format!("build login window: {e}"))?;

    // If the user closes the window before reaching /done, settle the
    // oneshot with `completed=false` so we don't hang forever.
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            if let Ok(mut slot) = signal_close.lock() {
                if let Some(tx) = slot.take() {
                    let _ = tx.send(false);
                }
            }
        }
    });

    let completed = rx.await.unwrap_or(false);

    // After OAuth2 completes we only hold the identity-provider session
    // (api-auth.soundcloud.com). Navigate to the main web app so it can
    // promote the IdP session to a `.soundcloud.com` session and set the
    // `oauth_token` cookie the api-v2 endpoints require. Poll the cookie
    // store for up to SC_COOKIE_WAIT_SECS; bail early the moment we see
    // oauth_token so the window doesn't stay open any longer than needed.
    if completed {
        if let Some(win) = app.get_webview_window(SC_LOGIN_WINDOW_LABEL) {
            match Url::parse(SC_POST_AUTH_URL) {
                Ok(u) => {
                    if let Err(e) = win.navigate(u) {
                        log::warn!("[sc-login] post-auth navigate failed: {e}");
                    }
                }
                Err(e) => log::warn!("[sc-login] bad post-auth url: {e}"),
            }

            let deadline =
                std::time::Instant::now() + Duration::from_secs(SC_COOKIE_WAIT_SECS);
            while std::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(400)).await;
                if let Ok(cookies) = win.cookies() {
                    if cookies.iter().any(|c| {
                        c.name() == "oauth_token"
                            && c.domain()
                                .map(|d| d.ends_with("soundcloud.com"))
                                .unwrap_or(true)
                    }) {
                        log::info!("[sc-login] oauth_token materialized");
                        break;
                    }
                }
            }
        }
    }

    // Harvest cookies BEFORE closing the window — closing the window on
    // macOS may also tear down the webview's cookie accessor.
    //
    // On WKWebView, `cookies_for_url` filters by strict host-match rules
    // (including the Secure + Domain attributes), and some SoundCloud
    // cookies may be scoped to `secure.soundcloud.com` host-only. Try
    // `cookies()` (which returns the entire store) so we don't miss the
    // token because of a URL scoping mismatch. Log every cookie's name/
    // domain the first time through so a harvest miss is trivially
    // diagnosable from backend.log.
    let oauth_token = if let Some(win) = app.get_webview_window(SC_LOGIN_WINDOW_LABEL) {
        match win.cookies() {
            Ok(cookies) => {
                log::info!("[sc-login] cookie store has {} entries", cookies.len());
                for c in &cookies {
                    log::info!(
                        "[sc-login]   name={} domain={:?} path={:?} http_only={:?} secure={:?}",
                        c.name(),
                        c.domain(),
                        c.path(),
                        c.http_only(),
                        c.secure(),
                    );
                }
                let tok = cookies
                    .iter()
                    .find(|c| {
                        c.name() == "oauth_token"
                            && c.domain()
                                .map(|d| d.ends_with("soundcloud.com"))
                                .unwrap_or(true)
                    })
                    .map(|c| c.value().to_string());
                log::info!(
                    "[sc-login] oauth_token present={}",
                    tok.is_some()
                );
                tok
            }
            Err(e) => {
                log::warn!("[sc-login] cookies() failed: {e}");
                None
            }
        }
    } else {
        None
    };

    if let Some(win) = app.get_webview_window(SC_LOGIN_WINDOW_LABEL) {
        let _ = win.close();
    }

    Ok(CapturedAuth {
        oauth_token,
        completed,
    })
}
