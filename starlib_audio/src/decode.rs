//! Audio decoding to mono f32 PCM at a configurable target sample rate.
//!
//! Uses symphonia for decoding (fMP4/AAC, MP3, FLAC, WAV, Vorbis) and a
//! simple linear resampler — good enough for tempo detection, where spectral
//! precision matters less than onset timing.

use std::fs::File;
use std::io::Cursor;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;

use crate::types::{BpmError, BpmOptions};

/// Decode in-memory audio bytes to mono f32 PCM at `options.target_sr`.
///
/// `hint` is an optional file-extension-style hint (e.g. `"mp4"`, `"aac"`,
/// `"mp3"`) that helps symphonia pick a demuxer when the container is
/// ambiguous.
pub fn decode_bytes(bytes: &[u8], hint: Option<&str>, options: &BpmOptions) -> Result<Vec<f32>> {
    let src: Box<dyn MediaSource> = Box::new(Cursor::new(bytes.to_vec()));
    decode_from_source(src, hint, options)
}

/// Decode an audio file from disk to mono f32 PCM at `options.target_sr`.
pub fn decode_file(path: &Path, options: &BpmOptions) -> Result<Vec<f32>> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let hint = path.extension().and_then(|e| e.to_str()).map(str::to_owned);
    decode_from_source(Box::new(file), hint.as_deref(), options)
}

fn decode_from_source(
    src: Box<dyn MediaSource>,
    hint: Option<&str>,
    options: &BpmOptions,
) -> Result<Vec<f32>> {
    let mss = MediaSourceStream::new(src, Default::default());
    let mut probe_hint = Hint::new();
    if let Some(h) = hint {
        probe_hint.with_extension(h);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &probe_hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .context("probe failed")?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| anyhow!("no default audio track"))?;
    let track_id = track.id;
    let audio_params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| anyhow!("default track has no audio codec params"))?;
    // Refuse to guess: a missing sample rate would silently corrupt tempo
    // detection (lag-to-BPM mapping is sample-rate dependent).
    let src_sr = audio_params.sample_rate.ok_or(BpmError::MissingSampleRate)?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(audio_params, &AudioDecoderOptions::default())
        .context("decoder init failed")?;

    let mut pcm: Vec<f32> = Vec::new();
    let mut interleaved: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymphError::ResetRequired) => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let ch = decoded.spec().channels().count().max(1);
                let frames = decoded.frames();
                interleaved.resize(frames * ch, 0.0);
                decoded.copy_to_slice_interleaved::<f32, _>(&mut interleaved[..]);
                for frame in interleaved.chunks(ch) {
                    let s = frame.iter().sum::<f32>() / ch as f32;
                    pcm.push(s);
                }
            }
            Err(SymphError::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        }
    }

    if src_sr == options.target_sr {
        Ok(pcm)
    } else {
        Ok(linear_resample(&pcm, src_sr, options.target_sr))
    }
}

/// Linear-interpolation resampler. Not a high-quality resampler — it's fine
/// for tempo detection where onset timing is what matters.
pub(crate) fn linear_resample(x: &[f32], src_sr: u32, dst_sr: u32) -> Vec<f32> {
    if x.is_empty() {
        return vec![];
    }
    let ratio = dst_sr as f64 / src_sr as f64;
    let n = ((x.len() as f64) * ratio) as usize;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let src_pos = i as f64 / ratio;
        let idx = src_pos as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = x[idx.min(x.len() - 1)];
        let b = x[(idx + 1).min(x.len() - 1)];
        out.push(a * (1.0 - frac) + b * frac);
    }
    out
}
