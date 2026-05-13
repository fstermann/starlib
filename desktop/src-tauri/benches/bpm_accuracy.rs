//! BPM accuracy harness.
//!
//! Walks a fixture manifest (Beatport BPM + SoundCloud track id), runs the
//! SoundCloud → BPM pipeline against each entry, and prints accuracy
//! metrics — within-1-BPM, within-0.5-BPM, MIR-standard ACC1/ACC2,
//! octave errors, complete misses — overall and per genre.
//!
//! Auth: needs a SoundCloud OAuth token in `SC_OAUTH_TOKEN`. Obtain via
//! `python scripts/build_bpm_fixture.py token` (Client-Credentials token,
//! ~1 hour validity).
//!
//! Usage:
//! ```bash
//! cd desktop/src-tauri
//! SC_OAUTH_TOKEN=... cargo bench --bench bpm_accuracy
//! # 3-window consensus (~3× network cost, higher accuracy):
//! SC_OAUTH_TOKEN=... BPM_MODE=consensus cargo bench --bench bpm_accuracy
//! # Ellis multi-target DP beat tracker (fewer catastrophic misses):
//! SC_OAUTH_TOKEN=... BPM_TRACKER=dp cargo bench --bench bpm_accuracy
//! # Restrict to a slice (first N entries) or a different manifest:
//! SC_OAUTH_TOKEN=... BPM_LIMIT=20 cargo bench --bench bpm_accuracy
//! SC_OAUTH_TOKEN=... BPM_MANIFEST=manifest_ci.json cargo bench --bench bpm_accuracy
//! ```
//!
//! Emits `target/bpm_accuracy.json` so CI can gate on the metrics.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use starlib_lib::bpm::soundcloud::analyze_sc_track;
use starlib_lib::bpm::types::{AnalysisMode, BeatTracker, BpmOptions};

#[derive(Debug, Deserialize)]
struct Manifest {
    #[allow(dead_code)]
    version: u32,
    entries: Vec<ManifestEntry>,
}

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    sc_track_id: u64,
    /// Canonical BPM the detector is measured against. Possibly normalized
    /// from `source_bpm` (e.g. half-time D&B labels folded to full tempo).
    truth_bpm: u32,
    #[serde(default)]
    #[allow(dead_code)]
    source_bpm: u32,
    #[serde(default)]
    #[allow(dead_code)]
    halftime_normalized: bool,
    artist: String,
    title: String,
    genre: String,
    #[serde(default)]
    #[allow(dead_code)]
    duration_s: u32,
}

#[derive(Debug, Clone, Serialize)]
struct Outcome {
    sc_track_id: u64,
    artist: String,
    title: String,
    genre: String,
    truth_bpm: u32,
    estimated_bpm: Option<f32>,
    error: Option<String>,
}

#[derive(Debug, Default, Serialize)]
struct Metrics {
    total: usize,
    analysed: usize,
    failed: usize,
    within_0_5: usize,
    within_1: usize,
    /// `within_1` plus any track where the estimate is within ±1 BPM of
    /// 2× or 0.5× the truth. Some labels (notably half-time D&B) tag tracks
    /// at the half-tempo; folding that in shows the algorithm's accuracy
    /// independent of label convention.
    within_1_octave_tolerant: usize,
    /// MIR-standard ACC1: estimate within 4% of truth (ISMIR 2004 convention).
    /// At 120 BPM this is ±4.8 BPM; at 174 BPM, ±7 BPM. Comparable to every
    /// published tempo-estimation result; the issue's ±1 BPM target is
    /// ~5–7× stricter than this.
    acc1: usize,
    /// MIR-standard ACC2: ACC1 plus estimates at 2×, ½×, 3× or ⅓× the truth.
    /// Octave-/triplet-tolerant variant. Published EDM SOTA (Schreiber CNN
    /// on GiantSteps) is ~92.5%.
    acc2: usize,
    octave_errors: usize,
    misses: usize,
}

impl Metrics {
    fn record(&mut self, truth: f32, est: Option<f32>) {
        self.total += 1;
        match est {
            None => self.failed += 1,
            Some(bpm) => {
                self.analysed += 1;
                let diff = (bpm - truth).abs();
                if diff <= 0.5 {
                    self.within_0_5 += 1;
                }
                if diff <= 1.0 {
                    self.within_1 += 1;
                    self.within_1_octave_tolerant += 1;
                }
                // MIR-standard ACC1 / ACC2 — the metrics every published
                // tempo paper actually reports against.
                let tol = 0.04 * truth;
                if diff <= tol {
                    self.acc1 += 1;
                    self.acc2 += 1;
                } else {
                    for mul in [2.0_f32, 0.5, 3.0, 1.0 / 3.0] {
                        if (bpm - mul * truth).abs() <= 0.04 * mul * truth {
                            self.acc2 += 1;
                            break;
                        }
                    }
                }
                let octave_lo = (bpm - truth * 0.5).abs();
                let octave_hi = (bpm - truth * 2.0).abs();
                let octave_hit = octave_lo <= 1.0 || octave_hi <= 1.0;
                if diff > 1.0 && octave_hit {
                    self.octave_errors += 1;
                    self.within_1_octave_tolerant += 1;
                }
                if diff > 5.0 && !octave_hit {
                    self.misses += 1;
                }
            }
        }
    }

    fn pct(&self, n: usize) -> f32 {
        if self.total == 0 {
            0.0
        } else {
            100.0 * n as f32 / self.total as f32
        }
    }

    fn print(&self, label: &str) {
        println!("{label}:");
        println!("  total            {}", self.total);
        println!("  analysed         {} ({} failed)", self.analysed, self.failed);
        println!("  within 1 BPM     {} ({:.1}%)", self.within_1, self.pct(self.within_1));
        println!("  within 0.5 BPM   {} ({:.1}%)", self.within_0_5, self.pct(self.within_0_5));
        println!(
            "  +octave-tolerant {} ({:.1}%)",
            self.within_1_octave_tolerant,
            self.pct(self.within_1_octave_tolerant),
        );
        println!("  ACC1 (±4%, MIR)  {} ({:.1}%)", self.acc1, self.pct(self.acc1));
        println!("  ACC2 (±4%+oct)   {} ({:.1}%)", self.acc2, self.pct(self.acc2));
        println!("  octave errors    {} ({:.1}%)", self.octave_errors, self.pct(self.octave_errors));
        println!("  misses (>5)      {} ({:.1}%)", self.misses, self.pct(self.misses));
    }
}

#[derive(Debug, Serialize)]
struct Report {
    mode: &'static str,
    overall: Metrics,
    per_genre: BTreeMap<String, Metrics>,
    outcomes: Vec<Outcome>,
}

fn repo_root() -> PathBuf {
    // Cargo runs benches with CWD = package dir (desktop/src-tauri/).
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("repo root")
        .to_path_buf()
}

fn load_manifest() -> Result<Manifest> {
    // `BPM_MANIFEST` accepts: a bare filename relative to `fixtures/bpm/`
    // (e.g. `manifest_ci.json`), or an absolute / relative path. Falls back
    // to the full 91-track manifest.
    let path = match env::var("BPM_MANIFEST") {
        Ok(p) if p.contains('/') || p.starts_with('.') => PathBuf::from(p),
        Ok(p) => repo_root().join("fixtures/bpm").join(p),
        Err(_) => repo_root().join("fixtures/bpm/manifest.json"),
    };
    let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let m: Manifest = serde_json::from_str(&text).with_context(|| "parse manifest")?;
    Ok(m)
}

fn parse_mode() -> AnalysisMode {
    match env::var("BPM_MODE").as_deref() {
        Ok("consensus") => AnalysisMode::Consensus,
        _ => AnalysisMode::Single,
    }
}

fn parse_beat_tracker() -> BeatTracker {
    match env::var("BPM_TRACKER").as_deref() {
        Ok("dp") | Ok("dynamic") => BeatTracker::DynamicProgramming,
        _ => BeatTracker::Autocorrelation,
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let token = env::var("SC_OAUTH_TOKEN")
        .map_err(|_| anyhow!("SC_OAUTH_TOKEN env var is required (see bench header for how to obtain)"))?;
    let manifest = load_manifest()?;
    let mode = parse_mode();
    let beat_tracker = parse_beat_tracker();
    let limit: Option<usize> = env::var("BPM_LIMIT").ok().and_then(|s| s.parse().ok());

    let entries: Vec<&ManifestEntry> = match limit {
        Some(n) => manifest.entries.iter().take(n).collect(),
        None => manifest.entries.iter().collect(),
    };
    println!(
        "bpm_accuracy: {} entries, mode = {:?}, tracker = {:?}",
        entries.len(),
        mode,
        beat_tracker,
    );

    let options = BpmOptions { mode, beat_tracker, ..BpmOptions::default() };

    let mut overall = Metrics::default();
    let mut per_genre: BTreeMap<String, Metrics> = BTreeMap::new();
    let mut outcomes: Vec<Outcome> = Vec::with_capacity(entries.len());

    let started = Instant::now();
    for (i, entry) in entries.iter().enumerate() {
        let t0 = Instant::now();
        let res = analyze_sc_track(entry.sc_track_id, &token, &options).await;
        let elapsed = t0.elapsed().as_millis();
        let (est, err) = match res {
            Ok(r) => (Some(r.bpm), None),
            Err(e) => (None, Some(e.to_string())),
        };
        let truth = entry.truth_bpm as f32;
        overall.record(truth, est);
        per_genre.entry(entry.genre.clone()).or_default().record(truth, est);
        outcomes.push(Outcome {
            sc_track_id: entry.sc_track_id,
            artist: entry.artist.clone(),
            title: entry.title.clone(),
            genre: entry.genre.clone(),
            truth_bpm: entry.truth_bpm,
            estimated_bpm: est,
            error: err.clone(),
        });
        match est {
            Some(bpm) => println!(
                "[{:>3}/{}] {:>6.1} vs {:>3} ({:+5.1})  {}ms  {} - {}",
                i + 1,
                entries.len(),
                bpm,
                entry.truth_bpm,
                bpm - truth,
                elapsed,
                entry.artist,
                entry.title,
            ),
            None => println!(
                "[{:>3}/{}]  ERR  {:?}  {} - {}",
                i + 1,
                entries.len(),
                err.unwrap_or_default(),
                entry.artist,
                entry.title,
            ),
        }
    }

    println!("\nfinished in {:.1}s", started.elapsed().as_secs_f32());
    println!();
    overall.print("overall");
    println!();
    for (genre, m) in &per_genre {
        m.print(genre);
        println!();
    }

    let report = Report {
        mode: if matches!(mode, AnalysisMode::Consensus) {
            "consensus"
        } else {
            "single"
        },
        overall,
        per_genre,
        outcomes,
    };
    let out_path = repo_root().join("desktop/src-tauri/target/bpm_accuracy.json");
    if let Some(p) = out_path.parent() {
        fs::create_dir_all(p).ok();
    }
    fs::write(&out_path, serde_json::to_string_pretty(&report)?)?;
    println!("wrote {}", out_path.display());

    Ok(())
}
