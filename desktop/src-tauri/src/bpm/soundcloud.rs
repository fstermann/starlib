//! SoundCloud HLS → BPM pipeline.
//!
//! Mirrors what `bpm_bench_rs` proved out: hit `/tracks/{id}/streams`,
//! follow the redirect from api.soundcloud.com to the signed CDN m3u8,
//! download init.mp4 + a window of segments, hand bytes to symphonia,
//! run tempo detection on the decoded PCM.
//!
//! Takes the OAuth token from the caller — this module doesn't touch
//! credentials. The Python backend owns auth state and hands the Rust
//! side a fresh Client-Credentials token for each analysis.

use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use futures::future::join_all;
use reqwest::Client;
use serde::Deserialize;
use url::Url;

use super::{analyze_bytes, types::BpmOptions, types::BpmResult};

const API_BASE: &str = "https://api.soundcloud.com";
/// Window offset into the track (percent of duration). 30% lands past the
/// intro on typical electronic tracks — matches A2's default.
const OFFSET_PCT: f32 = 30.0;
/// Analysis window length in seconds.
const SNIPPET_SECONDS: f32 = 15.0;

#[derive(Deserialize)]
struct StreamsResponse {
    hls_aac_160_url: Option<String>,
    hls_mp3_128_url: Option<String>,
}

/// Analyze a SoundCloud track via its HLS stream and return a BPM estimate.
pub async fn analyze_sc_track(track_id: u64, token: &str, options: &BpmOptions) -> Result<BpmResult> {
    let http = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("reqwest client build")?;

    // 1. /streams → get the HLS playlist URL
    let streams_url = format!("{API_BASE}/tracks/{track_id}/streams");
    let streams: StreamsResponse = sc_get(&http, token, &streams_url)
        .await?
        .json()
        .await
        .context("parse /streams response")?;
    let hls_url = streams
        .hls_aac_160_url
        .or(streams.hls_mp3_128_url)
        .ok_or_else(|| anyhow!("no HLS variant available for track {track_id}"))?;

    // 2. Fetch the m3u8 (redirect to the signed CDN needs the OAuth header)
    let m3u8_resp = sc_get(&http, token, &hls_url).await?;
    let final_url = m3u8_resp.url().clone();
    let m3u8_text = m3u8_resp.text().await.context("read m3u8 body")?;
    let playlist = parse_m3u8(&m3u8_text, &final_url);

    // 3. Pick a window of segments; init.mp4 (fMP4 CMAF) is fetched alongside
    let seg_urls = select_segments(&playlist.entries, OFFSET_PCT, SNIPPET_SECONDS);
    if seg_urls.is_empty() {
        return Err(anyhow!("no segments selected from m3u8"));
    }
    let mut fetch_urls: Vec<String> = Vec::with_capacity(seg_urls.len() + 1);
    if let Some(init) = &playlist.init_url {
        fetch_urls.push(init.clone());
    }
    fetch_urls.extend(seg_urls);

    // 4. Concurrent download of init + segments; concatenate the bytes
    let bodies = join_all(fetch_urls.iter().map(|u| {
        let http = http.clone();
        async move {
            http.get(u)
                .send()
                .await?
                .error_for_status()?
                .bytes()
                .await
                .map(|b| b.to_vec())
                .map_err(anyhow::Error::from)
        }
    }))
    .await;
    let mut raw: Vec<u8> = Vec::new();
    for b in bodies {
        raw.extend(b?);
    }

    // 5. Hand the bytes to the BPM pipeline. fMP4 when init.mp4 was prepended;
    //    ADTS AAC otherwise (rare on modern SoundCloud but we fall back).
    let fmt = if playlist.init_url.is_some() { "mp4" } else { "aac" };
    analyze_bytes(&raw, Some(fmt), options)
}

// ---------- SC API helpers ----------

async fn sc_get(http: &Client, token: &str, url: &str) -> Result<reqwest::Response> {
    // Plain OAuth header only — the public API (api.soundcloud.com) rejects
    // requests that include the web-client `client_id` query param.
    for attempt in 0..2 {
        let resp = http
            .get(url)
            .header("Authorization", format!("OAuth {token}"))
            .header("Accept", "application/json")
            .send()
            .await?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        if !status.is_server_error() || attempt == 1 {
            return Err(anyhow!("http {status} for {url}"));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    unreachable!()
}

// ---------- m3u8 parsing ----------

struct Playlist {
    entries: Vec<(f32, String)>, // (duration_s, absolute_url)
    init_url: Option<String>,
}

fn parse_m3u8(text: &str, base: &Url) -> Playlist {
    let mut entries = Vec::new();
    let mut init_url = None;
    let mut pending_dur: Option<f32> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            for part in rest.split(',') {
                if let Some((k, v)) = part.split_once('=') {
                    if k.trim() == "URI" {
                        let u = v.trim().trim_matches('"');
                        init_url = Some(absolute(u, base));
                    }
                }
            }
        } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let dur_str = rest.split(',').next().unwrap_or("");
            pending_dur = dur_str.parse().ok();
        } else if !line.starts_with('#') {
            if let Some(dur) = pending_dur.take() {
                entries.push((dur, absolute(line, base)));
            }
        }
    }
    Playlist { entries, init_url }
}

fn absolute(u: &str, base: &Url) -> String {
    if u.starts_with("http") {
        u.to_string()
    } else {
        base.join(u).map(|v| v.to_string()).unwrap_or_else(|_| u.to_string())
    }
}

fn select_segments(entries: &[(f32, String)], offset_pct: f32, snippet_s: f32) -> Vec<String> {
    if entries.is_empty() {
        return vec![];
    }
    let total: f32 = entries.iter().map(|(d, _)| *d).sum();
    let target = (total * (offset_pct / 100.0)).max(0.0);
    let mut cum = 0.0;
    let mut start = 0;
    for (i, (d, _)) in entries.iter().enumerate() {
        if cum + d > target {
            start = i;
            break;
        }
        cum += d;
    }
    let mut out = Vec::new();
    let mut acc = 0.0;
    for (d, u) in &entries[start..] {
        out.push(u.clone());
        acc += d;
        if acc >= snippet_s {
            break;
        }
    }
    out
}

// ---------- Unit tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_m3u8_extracts_init_and_entries() {
        let text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"https://cdn.example/init.mp4\"\n#EXTINF:10.0,\nseg0.m4s\n#EXTINF:10.0,\nseg1.m4s\n#EXT-X-ENDLIST\n";
        let base = Url::parse("https://cdn.example/path/playlist.m3u8").unwrap();
        let pl = parse_m3u8(text, &base);
        assert_eq!(pl.init_url.as_deref(), Some("https://cdn.example/init.mp4"));
        assert_eq!(pl.entries.len(), 2);
        assert_eq!(pl.entries[0].1, "https://cdn.example/path/seg0.m4s");
    }

    #[test]
    fn select_segments_covers_requested_window() {
        let entries: Vec<(f32, String)> = (0..6)
            .map(|i| (10.0, format!("seg{i}.m4s")))
            .collect();
        let picked = select_segments(&entries, 30.0, 15.0);
        assert_eq!(picked, vec!["seg1.m4s", "seg2.m4s"]);
    }

    #[test]
    fn select_segments_past_end_returns_empty_when_entries_empty() {
        assert!(select_segments(&[], 30.0, 15.0).is_empty());
    }
}
