//! Per-track arrangement analysis: bar grid, per-bar features, groove grid
//! and tonal centre. Measures only; section labels are interpreted elsewhere.

pub mod features;
pub mod grid;
pub mod tonal;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::decode::{decode_file_stereo, Stereo};
use features::{SourceFeatures, BANDS_HZ, SLOTS_PER_BAR};
use grid::Grid;
use tonal::{BassPeak, Tonal};

/// Bump when a change alters any measured value for the same input.
pub const PIPELINE_VERSION: u32 = 1;
pub const SAMPLE_RATE: u32 = 44_100;

/// Groove lanes: (name, stem, low Hz, high Hz).
const GROOVE_LANES: [(&str, &str, f64, f64); 4] = [
    ("kick", "drums", 30.0, 120.0),
    ("drum_mids", "drums", 300.0, 3000.0),
    ("drum_tops", "drums", 3000.0, 20000.0),
    ("bass", "bass", 30.0, 300.0),
];

/// Everything measured for one track.
#[derive(Debug, Serialize)]
pub struct Breakdown {
    pub pipeline_version: u32,
    pub sample_rate: u32,
    pub duration_s: f64,
    pub grid: Grid,
    pub bands_hz: [(f64, f64); 6],
    /// `mix` plus one entry per stem.
    pub sources: BTreeMap<String, SourceFeatures>,
    /// Band energy per 16th note, keyed by lane; lanes need the drums/bass stems.
    pub groove: BTreeMap<String, Vec<[f64; SLOTS_PER_BAR]>>,
    pub tonal: Tonal,
}

/// Tempo and downbeat supplied by the caller instead of estimated.
#[derive(Debug, Clone, Copy)]
pub struct GridOverride {
    pub bpm: f64,
    pub downbeat_s: f64,
}

/// Analyse the mix and its stems (`(name, path)`, e.g. `("drums", …)`).
///
/// `on_stage` is called with the name of each source before it is measured.
pub fn analyse(
    mix_path: &Path,
    stems: &[(String, PathBuf)],
    grid_override: Option<GridOverride>,
    mut on_stage: impl FnMut(&str),
) -> Result<Breakdown> {
    on_stage("mix");
    let mix = decode(mix_path)?;
    let duration_s = mix.left.len() as f64 / f64::from(SAMPLE_RATE);
    let grid = match grid_override {
        Some(g) => Grid::fixed(g.bpm, g.downbeat_s, duration_s),
        None => grid::estimate(&features::mid(&mix), SAMPLE_RATE)?,
    };
    let mix_features = features::measure(&mix, &grid);
    drop(mix);
    let reference = mix_features.peak_power();

    let mut sources = BTreeMap::from([("mix".to_owned(), mix_features.into_db(reference))]);
    let mut groove = BTreeMap::new();
    let mut bass_peaks: Vec<BassPeak> = Vec::new();
    let mut chroma = Vec::new();
    for (name, path) in stems {
        on_stage(name);
        let stem = decode(path)?;
        sources.insert(
            name.clone(),
            features::measure(&stem, &grid).into_db(reference),
        );
        for (lane, _, lo, hi) in GROOVE_LANES.iter().filter(|lane| lane.1 == name) {
            groove.insert(
                (*lane).to_owned(),
                features::groove_lane(&stem, &grid, *lo, *hi),
            );
        }
        match name.as_str() {
            "bass" => bass_peaks = tonal::bass_peaks(&stem),
            "other" => chroma = tonal::chroma(&stem, &grid),
            _ => {}
        }
    }

    Ok(Breakdown {
        pipeline_version: PIPELINE_VERSION,
        sample_rate: SAMPLE_RATE,
        duration_s,
        grid,
        bands_hz: BANDS_HZ,
        sources,
        groove,
        tonal: Tonal {
            root: bass_peaks
                .first()
                .map(|p| p.note.trim_end_matches(char::is_numeric).to_owned()),
            bass_peaks,
            chroma,
        },
    })
}

fn decode(path: &Path) -> Result<Stereo> {
    decode_file_stereo(path, SAMPLE_RATE).with_context(|| format!("decode {}", path.display()))
}
