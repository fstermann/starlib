//! SoundCloud HLS → BPM pipeline.
//!
//! Hits `/tracks/{id}/streams`, follows the redirect from api.soundcloud.com
//! to the signed CDN m3u8, downloads init.mp4 + a window of segments, hands
//! bytes to symphonia, runs tempo detection on the decoded PCM.
//!
//! Takes the OAuth token from the caller — this module doesn't touch
//! credentials. The Python backend owns auth state and hands the Rust side
//! a fresh Client-Credentials token for each analysis.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures::future::join_all;
use reqwest::Client;
use serde::Deserialize;
use url::Url;

use crate::tempo::consensus;
use crate::types::AnalysisMode;
use crate::{analyze_bytes, types::BpmOptions, types::BpmResult};

const API_BASE: &str = "https://api.soundcloud.com";
const DEFAULT_OFFSET_PCT: f32 = 30.0;
const CONSENSUS_OFFSETS_PCT: &[f32] = &[25.0, 50.0, 75.0];
const SNIPPET_SECONDS: f32 = 15.0;

#[derive(Deserialize)]
struct StreamsResponse {
    hls_aac_160_url: Option<String>,
    hls_mp3_128_url: Option<String>,
}

/// Analyze a SoundCloud track via its HLS stream and return a BPM estimate.
pub async fn analyze_sc_track(
    track_id: u64,
    token: &str,
    options: &BpmOptions,
) -> Result<BpmResult> {
    let http = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("reqwest client build")?;

    let playlist = resolve_playlist(&http, token, track_id).await?;
    let offsets: &[f32] = match options.mode {
        AnalysisMode::Single => &[DEFAULT_OFFSET_PCT],
        AnalysisMode::Consensus => CONSENSUS_OFFSETS_PCT,
    };

    let mut results = Vec::with_capacity(offsets.len());
    for &off in offsets {
        let raw = fetch_window_bytes(&http, &playlist, off).await?;
        let fmt = if playlist.init_url.is_some() { "mp4" } else { "aac" };
        results.push(analyze_bytes(&raw, Some(fmt), options)?);
    }

    if results.len() == 1 {
        Ok(results.into_iter().next().unwrap())
    } else {
        consensus(&results)
    }
}

/// Download the HLS playlist and segment list for a track. Public so the
/// backend chunked-streaming path can reuse it without re-resolving per chunk.
pub async fn resolve_playlist_for_track(
    http: &Client,
    token: &str,
    track_id: u64,
) -> Result<Playlist> {
    resolve_playlist(http, token, track_id).await
}

async fn resolve_playlist(http: &Client, token: &str, track_id: u64) -> Result<Playlist> {
    let streams_url = format!("{API_BASE}/tracks/{track_id}/streams");
    let streams: StreamsResponse = sc_get(http, token, &streams_url)
        .await?
        .json()
        .await
        .context("parse /streams response")?;
    let hls_url = streams
        .hls_aac_160_url
        .or(streams.hls_mp3_128_url)
        .ok_or_else(|| anyhow!("no HLS variant available for track {track_id}"))?;

    let m3u8_resp = sc_get(http, token, &hls_url).await?;
    let final_url = m3u8_resp.url().clone();
    let m3u8_text = m3u8_resp.text().await.context("read m3u8 body")?;
    Ok(parse_m3u8(&m3u8_text, &final_url))
}

async fn fetch_window_bytes(
    http: &Client,
    playlist: &Playlist,
    offset_pct: f32,
) -> Result<Vec<u8>> {
    let seg_urls = select_segments(&playlist.entries, offset_pct, SNIPPET_SECONDS);
    if seg_urls.is_empty() {
        return Err(anyhow!("no segments selected from m3u8 at offset {offset_pct}%"));
    }
    let mut fetch_urls: Vec<String> = Vec::with_capacity(seg_urls.len() + 1);
    if let Some(init) = &playlist.init_url {
        fetch_urls.push(init.clone());
    }
    fetch_urls.extend(seg_urls);

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
    Ok(raw)
}

async fn sc_get(http: &Client, token: &str, url: &str) -> Result<reqwest::Response> {
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
    Err(anyhow!("sc_get exhausted retries without returning"))
}

/// Parsed HLS playlist: ordered (duration_s, absolute_url) entries plus
/// the optional fMP4 init segment URL.
pub struct Playlist {
    pub entries: Vec<(f32, String)>,
    pub init_url: Option<String>,
}

impl Playlist {
    /// Total duration in seconds (sum of all `EXTINF` durations).
    pub fn total_seconds(&self) -> f32 {
        self.entries.iter().map(|(d, _)| *d).sum()
    }
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
        base.join(u)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| u.to_string())
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
        let entries: Vec<(f32, String)> =
            (0..6).map(|i| (10.0, format!("seg{i}.m4s"))).collect();
        let picked = select_segments(&entries, 30.0, 15.0);
        assert_eq!(picked, vec!["seg1.m4s", "seg2.m4s"]);
    }

    #[test]
    fn select_segments_past_end_returns_empty_when_entries_empty() {
        assert!(select_segments(&[], 30.0, 15.0).is_empty());
    }
}
