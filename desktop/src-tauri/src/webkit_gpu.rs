//! Restart the WebKit GPU process that plays the webview's audio.
//!
//! After the Mac sleeps, WebKit can lose the link between the page and its
//! GPU process: every `AudioContext` keeps running and nothing is heard, even
//! a new one. Stopping the GPU process makes WebKit launch a fresh one and
//! reconnect the page's audio to it, the same as an app restart.

/// The pid of the GPU process serving `wk_web_view`, or `None` when it has
/// none or WebKit doesn't report it.
///
/// # Safety
/// `wk_web_view` must be null or a live `WKWebView *`.
#[cfg(target_os = "macos")]
pub unsafe fn gpu_process_id(wk_web_view: *mut std::ffi::c_void) -> Option<i32> {
    use std::ffi::{c_char, c_void};

    #[link(name = "objc")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    if wk_web_view.is_null() {
        return None;
    }
    unsafe {
        let responds: unsafe extern "C" fn(*mut c_void, *const c_void, *const c_void) -> bool =
            std::mem::transmute(objc_msgSend as *const ());
        let pid_of: unsafe extern "C" fn(*mut c_void, *const c_void) -> i32 =
            std::mem::transmute(objc_msgSend as *const ());
        let gpu_pid = sel_registerName(c"_gpuProcessIdentifier".as_ptr());
        if !responds(
            wk_web_view,
            sel_registerName(c"respondsToSelector:".as_ptr()),
            gpu_pid,
        ) {
            return None;
        }
        let pid = pid_of(wk_web_view, gpu_pid);
        (pid > 0).then_some(pid)
    }
}

/// Stop the GPU process `pid`; WebKit launches a new one when the page next needs it.
#[cfg(target_os = "macos")]
pub fn stop(pid: i32) -> std::io::Result<()> {
    if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
