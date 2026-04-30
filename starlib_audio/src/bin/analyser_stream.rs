//! `bpm-stream` — streaming BPM + section analyser for the Python backend.
//!
//! Reads a decoded audio file from a path passed on argv, runs chunked BPM
//! detection followed by section segmentation, and emits JSON-lines events
//! on stdout. The Python analyser pipeline spawns this binary as a
//! subprocess and relays each line as an SSE event to the frontend.
//!
//! Wire format (one JSON object per line):
//!   {"type":"meta","duration_s":<f32>,"sample_rate":<u32>}
//!   {"type":"window.bpm","start_s":...,"end_s":...,"bpm":...,"confidence":"high|medium|low"}
//!   {"type":"section.detected","index":<u32>,"start_s":...,"end_s":...,"confidence":<f32>}
//!   {"type":"job.complete"}
//!   {"type":"error","message":...}            (stderr-equivalent; also exit code 1)
//!
//! Usage:
//!   bpm-stream analyse --input <path> [--window-s 30] [--hop-s 25]
//!                      [--min-bpm 60] [--max-bpm 200] [--target-sr 22050]
//!                      [--no-sections] [--no-octave-correction]
//!                      [--bpm-range MIN-MAX]
//!                      [--start-s S] [--end-s S]

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;

use starlib_audio::chunk::{analyze_chunks, ChunkOptions, ChunkResult};
use starlib_audio::decode::decode_file;
use starlib_audio::segment::{segment, Section, SegmentOptions};
use starlib_audio::types::BpmOptions;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event<'a> {
    Meta {
        duration_s: f32,
        sample_rate: u32,
    },
    #[serde(rename = "window.bpm")]
    WindowBpm {
        start_s: f32,
        end_s: f32,
        bpm: f32,
        confidence: &'a str,
    },
    #[serde(rename = "section.detected")]
    SectionDetected {
        index: u32,
        start_s: f32,
        end_s: f32,
        confidence: f32,
    },
    #[serde(rename = "job.complete")]
    JobComplete,
    Error {
        message: String,
    },
}

fn emit(ev: &Event<'_>) {
    if let Ok(line) = serde_json::to_string(ev) {
        println!("{line}");
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            emit(&Event::Error {
                message: e.to_string(),
            });
            ExitCode::from(1)
        }
    }
}

struct Cli {
    input: PathBuf,
    chunk: ChunkOptions,
    segment_opts: SegmentOptions,
    bpm_opts: BpmOptions,
    sections_enabled: bool,
    start_s: Option<f32>,
    end_s: Option<f32>,
}

fn parse_args(args: Vec<String>) -> Result<Cli> {
    let mut iter = args.into_iter();
    let cmd = iter.next().ok_or_else(|| anyhow!("missing subcommand"))?;
    if cmd != "analyse" && cmd != "analyze" {
        return Err(anyhow!("unknown subcommand: {cmd}"));
    }

    let mut input: Option<PathBuf> = None;
    let mut chunk = ChunkOptions::default();
    let mut segment_opts = SegmentOptions::default();
    let mut bpm_opts = BpmOptions::default();
    let mut sections_enabled = true;
    let mut start_s: Option<f32> = None;
    let mut end_s: Option<f32> = None;

    while let Some(flag) = iter.next() {
        let take = |iter: &mut std::vec::IntoIter<String>, name: &str| -> Result<String> {
            iter.next()
                .ok_or_else(|| anyhow!("missing value for {name}"))
        };
        match flag.as_str() {
            "--input" => input = Some(PathBuf::from(take(&mut iter, "--input")?)),
            "--window-s" => chunk.window_s = take(&mut iter, "--window-s")?.parse()?,
            "--hop-s" => chunk.hop_s = take(&mut iter, "--hop-s")?.parse()?,
            "--target-sr" => bpm_opts.target_sr = take(&mut iter, "--target-sr")?.parse()?,
            "--min-bpm" => bpm_opts.min_bpm = take(&mut iter, "--min-bpm")?.parse()?,
            "--max-bpm" => bpm_opts.max_bpm = take(&mut iter, "--max-bpm")?.parse()?,
            "--bpm-range" => {
                // Format: MIN-MAX (e.g. 120-130). Constrains the autocorrelation
                // search range; tighter than min/max default to suppress 2x/0.5x
                // octave errors when the user knows the set's BPM band.
                let v = take(&mut iter, "--bpm-range")?;
                let (lo, hi) = v
                    .split_once('-')
                    .ok_or_else(|| anyhow!("--bpm-range must be MIN-MAX, got {v}"))?;
                bpm_opts.min_bpm = lo.parse()?;
                bpm_opts.max_bpm = hi.parse()?;
            }
            "--no-octave-correction" => bpm_opts.octave_correction = false,
            "--no-sections" => sections_enabled = false,
            "--bands" => segment_opts.bands = take(&mut iter, "--bands")?.parse()?,
            "--kernel-half-s" => {
                segment_opts.kernel_half_s = take(&mut iter, "--kernel-half-s")?.parse()?
            }
            "--min-gap-s" => segment_opts.min_gap_s = take(&mut iter, "--min-gap-s")?.parse()?,
            "--peak-threshold" => {
                segment_opts.peak_threshold = take(&mut iter, "--peak-threshold")?.parse()?
            }
            "--start-s" => start_s = Some(take(&mut iter, "--start-s")?.parse()?),
            "--end-s" => end_s = Some(take(&mut iter, "--end-s")?.parse()?),
            other => return Err(anyhow!("unknown flag: {other}")),
        }
    }

    Ok(Cli {
        input: input.ok_or_else(|| anyhow!("--input is required"))?,
        chunk,
        segment_opts,
        bpm_opts,
        sections_enabled,
        start_s,
        end_s,
    })
}

fn run(args: Vec<String>) -> Result<()> {
    let cli = parse_args(args)?;
    let pcm = decode_file(&cli.input, &cli.bpm_opts)
        .with_context(|| format!("decode {}", cli.input.display()))?;
    let sr = cli.bpm_opts.target_sr;
    let total_s = pcm.len() as f32 / sr as f32;
    emit(&Event::Meta {
        duration_s: total_s,
        sample_rate: sr,
    });

    // Optional [start_s, end_s] window — used by re-analyse to scope the
    // emitted events to a region without re-decoding the whole set.
    let start_idx = cli
        .start_s
        .map(|s| (s.max(0.0) * sr as f32) as usize)
        .unwrap_or(0);
    let end_idx = cli
        .end_s
        .map(|s| ((s.max(0.0) * sr as f32) as usize).min(pcm.len()))
        .unwrap_or(pcm.len());
    if start_idx >= end_idx {
        return Err(anyhow!(
            "empty analysis window: start={start_idx} end={end_idx}"
        ));
    }
    let window = &pcm[start_idx..end_idx];
    let region_offset = start_idx as f32 / sr as f32;

    // Stage 1: chunked BPM events. Streamed as they finish.
    let _: Vec<ChunkResult> = analyze_chunks(window, sr, &cli.bpm_opts, &cli.chunk, |c| {
        emit(&Event::WindowBpm {
            start_s: c.start_s + region_offset,
            end_s: c.end_s + region_offset,
            bpm: c.bpm,
            confidence: c.confidence,
        });
    })?;

    // Stage 2: section segmentation across the same window.
    if cli.sections_enabled {
        let sections: Vec<Section> = segment(window, sr, &cli.segment_opts)?;
        for (idx, s) in sections.iter().enumerate() {
            emit(&Event::SectionDetected {
                index: idx as u32,
                start_s: s.start_s + region_offset,
                end_s: s.end_s + region_offset,
                confidence: s.confidence,
            });
        }
    }

    emit(&Event::JobComplete);
    Ok(())
}
