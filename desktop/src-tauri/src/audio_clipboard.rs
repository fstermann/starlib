//! Audio clips copied to the clipboard as files, the way Finder copies them.
//!
//! DAWs such as Ableton only paste audio that arrives as a file reference, so
//! the clip is saved under the user's Music folder (where a set keeps
//! finding it) and its URL goes on the general pasteboard.

use std::path::{Path, PathBuf};

/// Save `wav` as `<name>.wav` in the clips folder, never replacing an earlier clip.
pub fn save_clip(name: &str, wav: &[u8]) -> std::io::Result<PathBuf> {
    let dir = dirs::audio_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("Starlib")
        .join("Clips");
    std::fs::create_dir_all(&dir)?;
    let path = free_path(&dir, &sanitize(name));
    std::fs::write(&path, wav)?;
    Ok(path)
}

fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | ':' | '\\') || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        "Clip".into()
    } else {
        trimmed.into()
    }
}

fn free_path(dir: &Path, stem: &str) -> PathBuf {
    (1..)
        .map(|n| match n {
            1 => dir.join(format!("{stem}.wav")),
            n => dir.join(format!("{stem} {n}.wav")),
        })
        .find(|path| !path.exists())
        .expect("an unused name")
}

/// Put `path` on the general pasteboard as a file, as Finder's Copy does.
#[cfg(target_os = "macos")]
pub fn copy_file(path: &Path) -> Result<(), String> {
    const SCRIPT: &str = "ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const urls = $.NSArray.arrayWithObject($.NSURL.fileURLWithPath(argv[0]));
  if (!pb.writeObjects(urls)) throw new Error('pasteboard refused the file');
}";
    let output = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT])
        .arg(path)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub fn copy_file(_path: &Path) -> Result<(), String> {
    Err("Copying audio is only supported on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_replaces_path_separators() {
        assert_eq!(sanitize("AC/DC: Live"), "AC-DC- Live");
        assert_eq!(sanitize(" ..hidden "), "hidden");
        assert_eq!(sanitize(""), "Clip");
    }

    #[test]
    fn free_path_skips_existing_clips() {
        let dir = std::env::temp_dir().join(format!("starlib-clips-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Tune.wav"), b"").unwrap();
        assert_eq!(free_path(&dir, "Tune"), dir.join("Tune 2.wav"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
