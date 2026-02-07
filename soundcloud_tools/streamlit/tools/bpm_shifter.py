# ruff: noqa: C901
import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
import streamlit as st
import yt_dlp
from essentia.standard import Energy, MonoLoader, RhythmExtractor2013, Spectrum, Windowing
from pydub import AudioSegment
from scipy.signal import find_peaks
from shazamio import Shazam

from soundcloud_tools.models import Track
from soundcloud_tools.streamlit.client import get_client
from soundcloud_tools.streamlit.utils import render_embedded_track

logger = logging.getLogger(__name__)


def get_cache_dir() -> Path:
    """
    Get or create the cache directory for downloaded tracks.

    Returns
    -------
    Path
        Path to the cache directory
    """
    # Use project directory instead of home directory
    cache_dir = Path(__file__).parent.parent.parent.parent / ".cache" / "tracks"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def get_cached_track_path(track_id: int) -> Path:
    """
    Get the path to a cached track file.

    Parameters
    ----------
    track_id : int
        SoundCloud track ID

    Returns
    -------
    Path
        Path to the cached track file
    """
    cache_dir = get_cache_dir()
    return cache_dir / f"track_{track_id}.mp3"


def is_track_cached(track_id: int) -> bool:
    """
    Check if a track is already cached.

    Parameters
    ----------
    track_id : int
        SoundCloud track ID

    Returns
    -------
    bool
        True if track is cached, False otherwise
    """
    cached_path = get_cached_track_path(track_id)
    return cached_path.exists() and cached_path.stat().st_size > 0


def analyze_bpm_segments(audio_path: str, segment_duration: int = 300) -> list[dict]:
    """
    Analyze BPM in segments for long tracks (>20 minutes).

    Parameters
    ----------
    audio_path : str
        Path to the audio file
    segment_duration : int
        Duration of each segment in seconds (default: 300 = 5 minutes)

    Returns
    -------
    list[dict]
        List of dictionaries with segment info: {start, end, bpm}
    """
    audio = MonoLoader(filename=audio_path, sampleRate=44100)()
    sample_rate = 44100
    total_duration = len(audio) / sample_rate

    segments = []
    rhythm_extractor = RhythmExtractor2013(method="multifeature")

    # If track is shorter than 20 minutes, analyze as a whole
    if total_duration < 1200:  # 20 minutes
        bpm, *_ = rhythm_extractor(audio)
        return [{"start": 0, "end": total_duration, "bpm": round(bpm)}]

    # For long tracks, analyze in segments
    num_segments = int(np.ceil(total_duration / segment_duration))

    for i in range(num_segments):
        start_time = i * segment_duration
        end_time = min((i + 1) * segment_duration, total_duration)

        start_sample = int(start_time * sample_rate)
        end_sample = int(end_time * sample_rate)

        segment_audio = audio[start_sample:end_sample]

        try:
            bpm, *_ = rhythm_extractor(segment_audio)
            segments.append({"start": start_time, "end": end_time, "bpm": round(bpm)})
        except Exception as e:
            logger.warning(f"Failed to analyze segment {i}: {e}")
            segments.append({"start": start_time, "end": end_time, "bpm": None})

    return segments


def detect_transitions(
    audio_path: str,
    bpm_segments: list[dict] | None = None,
    min_transition_gap: int = 120,
    energy_threshold: float = 0.3,
) -> list[int]:
    """
    Detect likely track transitions using energy changes and BPM variations.

    Parameters
    ----------
    audio_path : str
        Path to the audio file
    bpm_segments : list[dict] | None
        Pre-computed BPM segments from analyze_bpm_segments
    min_transition_gap : int
        Minimum seconds between transitions (default: 120 = 2 minutes)
    energy_threshold : float
        Threshold for energy-based transition detection (0-1, default: 0.3)

    Returns
    -------
    list[int]
        List of timestamps (in seconds) where transitions are detected
    """
    audio = MonoLoader(filename=audio_path, sampleRate=44100)()
    sample_rate = 44100
    total_duration = len(audio) / sample_rate

    transitions = set()

    # 1. BPM-based transition detection
    if bpm_segments and len(bpm_segments) > 1:
        logger.info("Detecting transitions from BPM changes...")
        for i in range(1, len(bpm_segments)):
            prev_bpm = bpm_segments[i - 1].get("bpm")
            curr_bpm = bpm_segments[i].get("bpm")

            if prev_bpm and curr_bpm:
                # Significant BPM change (>3 BPM difference)
                bpm_change = abs(curr_bpm - prev_bpm)
                if bpm_change > 3:
                    transition_time = int(bpm_segments[i]["start"])
                    transitions.add(transition_time)
                    logger.info(f"BPM transition detected at {transition_time}s: {prev_bpm} → {curr_bpm} BPM")

    # 2. Energy-based transition detection
    logger.info("Detecting transitions from energy changes...")
    # Analyze energy in windows (5-second windows)
    window_size = 5  # seconds
    hop_size = 2  # seconds
    frame_size = int(window_size * sample_rate)
    hop_samples = int(hop_size * sample_rate)

    energy_values = []
    timestamps = []

    windowing = Windowing(type="hann")
    spectrum = Spectrum()
    energy_calc = Energy()

    for i in range(0, len(audio) - frame_size, hop_samples):
        frame = audio[i : i + frame_size]
        windowed = windowing(frame)
        spec = spectrum(windowed)
        energy_val = energy_calc(spec)
        energy_values.append(energy_val)
        timestamps.append(i / sample_rate)

    if not energy_values:
        logger.warning("No energy values computed")
        return sorted(transitions)

    # Normalize energy values
    energy_array = np.array(energy_values)
    energy_normalized = (energy_array - np.min(energy_array)) / (np.max(energy_array) - np.min(energy_array) + 1e-10)

    # Find peaks and valleys in energy (transitions often have energy drops/peaks)
    # Look for significant valleys (energy drops) which indicate transitions
    valleys, _ = find_peaks(
        -energy_normalized,
        prominence=energy_threshold,
        distance=int(min_transition_gap / hop_size),
    )

    for valley_idx in valleys:
        if valley_idx < len(timestamps):
            transition_time = int(timestamps[valley_idx])
            # Avoid very start/end
            if 30 < transition_time < total_duration - 30:
                transitions.add(transition_time)
                logger.info(f"Energy transition detected at {transition_time}s")

    # 3. Ensure minimum spacing between transitions
    sorted_transitions = sorted(transitions)
    filtered_transitions: list[int] = []

    for trans in sorted_transitions:
        # Keep if it's far enough from the last kept transition
        if not filtered_transitions or trans - filtered_transitions[-1] >= min_transition_gap:
            filtered_transitions.append(trans)
        else:
            # Keep the one closer to the middle of the gap
            logger.debug(f"Skipping transition at {trans}s (too close to {filtered_transitions[-1]}s)")

    logger.info(f"Detected {len(filtered_transitions)} transitions after filtering")
    return filtered_transitions


def generate_smart_sample_points(
    duration_s: int,
    transitions: list[int] | None = None,
    samples_per_track: int = 2,
    fallback_interval: int = 180,
    min_gap: int = 30,
) -> list[int]:
    """
    Generate intelligent sample points for track identification.

    Parameters
    ----------
    duration_s : int
        Total duration in seconds
    transitions : list[int] | None
        Detected transition timestamps
    samples_per_track : int
        Number of samples to take per detected track (default: 2)
    fallback_interval : int
        Fallback interval if no transitions detected (default: 180s)
    min_gap : int
        Minimum gap from start/end and between samples (default: 30s)

    Returns
    -------
    list[int]
        List of sample timestamps
    """
    sample_points = []

    if transitions and len(transitions) > 0:
        # Sample around each transition
        # Take samples before the transition (middle of previous track)
        # and after the transition (middle of next track)
        logger.info(f"Generating samples based on {len(transitions)} detected transitions")

        # Add sample at the beginning (first track)
        first_transition = transitions[0]
        if first_transition > min_gap * 2:
            # Sample in the middle of first track
            sample_points.append(first_transition // 2)

        # For each transition, sample the track that comes after it
        for i in range(len(transitions)):
            curr_transition = transitions[i]
            next_transition = transitions[i + 1] if i + 1 < len(transitions) else duration_s

            track_duration = next_transition - curr_transition

            if track_duration > min_gap * 2:
                # Take samples_per_track samples within this track
                if samples_per_track == 1:
                    # Single sample in the middle
                    sample_points.append(curr_transition + track_duration // 2)
                else:
                    # Multiple samples spread across the track
                    for j in range(samples_per_track):
                        offset = (j + 1) * track_duration // (samples_per_track + 1)
                        sample_time = curr_transition + offset
                        if min_gap < sample_time < duration_s - min_gap:
                            sample_points.append(sample_time)
    else:
        # Fallback to interval-based sampling
        logger.info(f"No transitions detected, using fallback interval of {fallback_interval}s")
        sample_points = list(range(min_gap, duration_s - min_gap, fallback_interval))

    # Remove duplicates and ensure minimum spacing
    sample_points = sorted(set(sample_points))
    filtered_points: list[int] = []

    for point in sample_points:
        if not filtered_points or point - filtered_points[-1] >= min_gap:
            filtered_points.append(point)

    logger.info(f"Generated {len(filtered_points)} sample points")
    return filtered_points


def download_track(soundcloud_url: str, track_id: int) -> Path | None:
    """
    Download a SoundCloud track using yt-dlp with caching.

    Parameters
    ----------
    soundcloud_url : str
        SoundCloud URL to the track
    track_id : int
        SoundCloud track ID for caching

    Returns
    -------
    Path | None
        Path to the downloaded file if successful, None otherwise
    """
    # Check if track is already cached
    cached_path = get_cached_track_path(track_id)

    if is_track_cached(track_id):
        logger.info(f"Using cached track: {cached_path}")
        return cached_path

    # Download the track
    try:
        logger.info(f"Downloading track {track_id}...")
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": str(cached_path.with_suffix("")),
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }
            ],
            "quiet": True,
            "no_warnings": True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([soundcloud_url])

        if cached_path.exists():
            logger.info(f"Track downloaded and cached: {cached_path}")
            return cached_path
        return None
    except Exception as e:
        logger.error(f"Failed to download track: {e}")
        return None


def shift_pitch(audio_path: str, original_bpm: float, target_bpm: float, output_path: str) -> bool:
    """
    Shift pitch and tempo of an audio file.

    Parameters
    ----------
    audio_path : str
        Path to input audio file
    original_bpm : float
        Original BPM
    target_bpm : float
        Target BPM
    output_path : str
        Path for output file

    Returns
    -------
    bool
        True if successful, False otherwise
    """
    try:
        # Load audio file
        audio = AudioSegment.from_file(audio_path)

        # Calculate playback rate
        playback_rate = target_bpm / original_bpm

        # Change speed and pitch
        # Note: This changes both tempo and pitch together
        new_sample_rate = int(audio.frame_rate * playback_rate)

        # Change frame rate (speeds up/slows down)
        pitched_audio = audio._spawn(audio.raw_data, overrides={"frame_rate": new_sample_rate})

        # Set back to standard sample rate
        pitched_audio = pitched_audio.set_frame_rate(audio.frame_rate)

        # Export
        pitched_audio.export(output_path, format="mp3")

        return True
    except Exception as e:
        logger.error(f"Failed to shift pitch: {e}")
        return False


async def identify_tracks_in_mix(
    audio_path: str,
    duration_s: int,
    track_id: int | str,
    bpm_segments: list[dict] | None = None,
    use_smart_detection: bool = True,
    samples_per_track: int = 2,
    fallback_interval: int = 180,
    progress_callback=None,
) -> list[dict]:
    """
    Identify tracks in a DJ mix/set using Shazam with intelligent transition detection.
    Uses incremental caching - reads existing cache and only processes new samples.

    Parameters
    ----------
    audio_path : str
        Path to the audio file
    duration_s : int
        Total duration in seconds
    track_id : int | str
        SoundCloud track ID or cache key (for unique snippet naming)
    bpm_segments : list[dict] | None
        Pre-computed BPM segments for transition detection
    use_smart_detection : bool
        Use transition detection instead of fixed intervals (default: True)
    samples_per_track : int
        Number of samples per detected track (default: 2)
    fallback_interval : int
        Fallback interval if transition detection disabled/fails (default: 180s)
    progress_callback : callable, optional
        Callback function to report progress (percent, message)

    Returns
    -------
    list[dict]
        List of identified tracks with timestamp, metadata, and confidence score
    """
    cache_dir = get_cache_dir()
    cache_path = cache_dir / f"track_{track_id}_shazam.json"

    # Load existing cache if available
    cached_samples = {}  # timestamp -> result
    if cache_path.exists():
        try:
            with open(cache_path) as f:
                cached_data = json.load(f)
                # Build a lookup of all cached sample results by timestamp
                for entry in cached_data:
                    ts = entry.get("timestamp")
                    if ts is not None:
                        cached_samples[ts] = entry
                logger.info(f"Loaded {len(cached_samples)} cached sample results")
        except Exception as e:
            logger.warning(f"Failed to load cache: {e}")
            cached_samples = {}

    shazam = Shazam()
    audio = AudioSegment.from_file(audio_path)

    # Detect transitions and generate smart sample points
    if use_smart_detection:
        if progress_callback:
            progress_callback(0, "Detecting track transitions...")

        try:
            transitions = detect_transitions(
                audio_path,
                bpm_segments=bpm_segments,
                min_transition_gap=120,
                energy_threshold=0.3,
            )
            logger.info(f"Detected {len(transitions)} transitions")

            sample_points = generate_smart_sample_points(
                duration_s,
                transitions=transitions,
                samples_per_track=samples_per_track,
                fallback_interval=fallback_interval,
                min_gap=30,
            )
        except Exception as e:
            logger.error(f"Smart detection failed: {e}, falling back to interval sampling")
            sample_points = list(range(30, duration_s - 30, fallback_interval))
    else:
        # Fallback to simple interval-based sampling
        sample_points = list(range(30, duration_s - 30, fallback_interval))

    logger.info(f"Will process {len(sample_points)} sample points")

    # Generate all sample info
    tasks = []
    all_samples = []
    samples_to_process = []

    for timestamp in sample_points:
        snippet_path = cache_dir / f"snippet_{track_id}_{timestamp}.mp3"
        sample_info = {"timestamp": timestamp, "path": str(snippet_path)}

        all_samples.append(sample_info)

        # Check if this sample is already in cache
        if timestamp in cached_samples:
            logger.info(f"Using cached result for {timestamp}s")
            continue

        # Extract snippet if it doesn't exist
        if not snippet_path.exists():
            start_ms = timestamp * 1000
            end_ms = (timestamp + 10) * 1000
            snippet = audio[start_ms:end_ms]
            snippet.export(str(snippet_path), format="mp3")
            logger.info(f"Extracted snippet at {timestamp}s")
        else:
            logger.info(f"Using cached snippet at {timestamp}s")

        # Create async task for identification
        tasks.append(_identify_snippet(shazam, str(snippet_path), timestamp))
        samples_to_process.append(sample_info)

    logger.info(f"Processing {len(tasks)} new samples, {len(cached_samples)} from cache")

    # Run all identifications with rate limiting and incremental caching
    batch_size = 5  # Process 5 requests at a time
    delay_between_batches = 2  # Wait 2 seconds between batches

    results = []
    for i in range(0, len(tasks), batch_size):
        batch = tasks[i : i + batch_size]
        batch_num = i // batch_size + 1
        total_batches = (len(tasks) + batch_size - 1) // batch_size if tasks else 0

        logger.info(f"Processing batch {batch_num}/{total_batches}")

        # Update progress if callback provided
        if progress_callback:
            progress_pct = int((i / len(tasks)) * 100) if tasks else 100
            progress_callback(progress_pct, f"Processing batch {batch_num}/{total_batches}...")

        # Run batch concurrently
        batch_results = await asyncio.gather(*batch, return_exceptions=True)
        results.extend(batch_results)

        # **Incremental cache update**: Save results after each batch
        newly_identified = []
        for result, _sample_info in zip(batch_results, samples_to_process[i : i + batch_size], strict=True):
            if isinstance(result, Exception):
                continue
            if result and isinstance(result, dict) and result.get("track"):
                ts = result.get("timestamp")
                if ts is not None:
                    cached_samples[ts] = result
                    newly_identified.append(result)

        if newly_identified:
            # Save all samples (cached + new) back to file
            all_results_for_cache = list(cached_samples.values())
            try:
                with open(cache_path, "w") as f:
                    json.dump(all_results_for_cache, f, indent=2)
                logger.info(f"Saved {len(newly_identified)} new results to cache (total: {len(cached_samples)})")
            except Exception as e:
                logger.error(f"Failed to save cache: {e}")

        # Wait between batches (except for the last one)
        if i + batch_size < len(tasks):
            logger.info(f"Waiting {delay_between_batches}s before next batch...")
            await asyncio.sleep(delay_between_batches)

    # Combine cached results with newly identified results
    # Group consecutive samples that identify the same track

    all_results = list(cached_samples.values())

    # Sort by timestamp
    all_results.sort(key=lambda r: r.get("timestamp", 0))

    # Group results into tracks using time proximity and title matching
    identified_tracks = []
    current_track_group: list[dict[str, Any]] = []

    for result in all_results:
        if not result or not isinstance(result, dict) or not result.get("track"):
            continue

        if not current_track_group:
            current_track_group.append(result)
        else:
            # Check if this is the same track as the current group
            last_result = current_track_group[-1]
            time_diff = result["timestamp"] - last_result["timestamp"]

            last_track = last_result["track"]
            curr_track = result["track"]

            same_track = last_track["title"] == curr_track["title"] and last_track["subtitle"] == curr_track["subtitle"]

            # If same track and within reasonable time (< 5 minutes apart), add to group
            if same_track and time_diff < 300:
                current_track_group.append(result)
            else:
                # Finalize current track group
                if current_track_group:
                    track_entry = _create_track_entry(current_track_group)
                    identified_tracks.append(track_entry)

                # Start new group
                current_track_group = [result]

    # Don't forget the last group
    if current_track_group:
        track_entry = _create_track_entry(current_track_group)
        identified_tracks.append(track_entry)

    logger.info(f"Identified {len(identified_tracks)} unique tracks")
    return identified_tracks


def _create_track_entry(results: list[dict]) -> dict:
    """
    Create a track entry from multiple detection results.

    Parameters
    ----------
    results : list[dict]
        List of detection results for the same track

    Returns
    -------
    dict
        Track entry with confidence score
    """
    # Use the earliest timestamp
    earliest_result = min(results, key=lambda r: r["timestamp"])

    # Calculate confidence based on number of confirmations
    confidence = min(1.0, len(results) / 2)  # Cap at 1.0, expect ~2 samples per track

    return {
        **earliest_result,
        "confidence": confidence,
        "detections": len(results),
        "samples": len(results),
    }


async def _identify_snippet_with_variations(
    shazam: Shazam,
    snippet_variations: list[str | tuple[str, int]],
    timestamp: int,
    original_snippet_path: str,
    max_retries: int = 2,
    return_all: bool = False,
) -> dict | list[dict] | None:
    """
    Try identifying a snippet with multiple pitch variations.

    Parameters
    ----------
    shazam : Shazam
        Shazam instance
    snippet_variations : list[str | tuple[str, int]]
        List of snippet paths or (path, bpm_offset) tuples to try
    timestamp : int
        Timestamp in seconds where this snippet was taken
    original_snippet_path : str
        Path to the original (unmodified) snippet file
    max_retries : int
        Maximum number of retry attempts for failed requests (default: 2)
    return_all : bool
        If True, try all variations and return list of all results (including None for no match).
        If False, return first match.

    Returns
    -------
    dict | list[dict] | None
        If return_all=False: Track information with timestamp, snippet path, and which variation worked, or None
        If return_all=True: List of dicts with results for each variation (result or error info)
    """
    results = []

    # Try each variation
    for _i, variation in enumerate(snippet_variations):
        if isinstance(variation, tuple):
            variation_path, bpm_offset = variation

            # Create pitch-shifted version if it doesn't exist
            if not Path(variation_path).exists():
                try:
                    # Load original snippet
                    original_audio = AudioSegment.from_file(original_snippet_path)

                    # Calculate playback rate for BPM shift
                    # Assuming snippet is from a mix that's already at some BPM
                    # We want to shift by bpm_offset (e.g., +3 or -3)
                    # For small adjustments, we can approximate: rate ≈ 1 + (bpm_offset / current_bpm)
                    # Since we don't know exact current BPM, use a typical value (128 BPM)
                    # For more accuracy, could pass detected BPM, but this is close enough
                    playback_rate = 1 + (bpm_offset / 128.0)

                    # Apply pitch shift
                    new_sample_rate = int(original_audio.frame_rate * playback_rate)
                    shifted_audio = original_audio._spawn(
                        original_audio.raw_data, overrides={"frame_rate": new_sample_rate}
                    )
                    shifted_audio = shifted_audio.set_frame_rate(original_audio.frame_rate)

                    # Export variation
                    shifted_audio.export(variation_path, format="mp3")
                    logger.info(f"Created pitch variation at {timestamp}s with {bpm_offset:+d} BPM offset")
                except Exception as e:
                    logger.error(f"Failed to create pitch variation: {e}")
                    if return_all:
                        # Include error in results when return_all is True
                        results.append(
                            {
                                "bpm_variation": f"{bpm_offset:+d} BPM",
                                "variation_snippet_path": variation_path,
                                "error": f"Failed to create variation: {e}",
                            }
                        )
                    continue

            variation_label = f"{bpm_offset:+d} BPM"
        else:
            variation_path = variation
            variation_label = "original"

        # Try identifying this variation
        logger.info(f"Trying identification with {variation_label} at {timestamp}s...")
        result = await _identify_snippet(shazam, variation_path, timestamp, max_retries)

        if result:
            # Add variation info to result
            result["bpm_variation"] = variation_label
            result["variation_snippet_path"] = variation_path
            results.append(result)
            logger.info(f"✓ Identified at {timestamp}s using {variation_label} variation: {result['track']['title']}")

            # If not returning all results, return immediately on first match
            if not return_all:
                return result
        else:
            logger.info(f"✗ No match found with {variation_label} at {timestamp}s")
            # When return_all is True, include no-match entries
            if return_all:
                results.append(
                    {
                        "bpm_variation": variation_label,
                        "variation_snippet_path": variation_path,
                        "no_match": "true",
                    }
                )

    # Return based on mode
    if return_all:
        return results if results else None

    # If no variation worked, return None
    if not results:
        # Clean up all variation files
        for variation in snippet_variations:
            path = variation if isinstance(variation, str) else variation[0]
            Path(path).unlink(missing_ok=True)
        return None

    # Shouldn't reach here since we return on first match when return_all=False, but just in case
    return results[0] if results else None


async def _identify_snippet(shazam: Shazam, snippet_path: str, timestamp: int, max_retries: int = 2) -> dict | None:
    """
    Identify a single audio snippet with retry logic.

    Parameters
    ----------
    shazam : Shazam
        Shazam instance
    snippet_path : str
        Path to the audio snippet
    timestamp : int
        Timestamp in seconds where this snippet was taken
    max_retries : int
        Maximum number of retry attempts for failed requests (default: 2)

    Returns
    -------
    dict | None
        Track information with timestamp and snippet path, or None if not identified
    """
    for attempt in range(max_retries + 1):
        try:
            result = await shazam.recognize(snippet_path)

            # Keep snippet file for playback comparison (don't delete)
            # Snippets will be cleaned up when cache is cleared

            if result and "track" in result:
                track_info = result["track"]
                return {
                    "timestamp": timestamp,
                    "snippet_path": snippet_path,  # Include snippet path for playback
                    "track": {
                        "title": track_info.get("title", "Unknown"),
                        "subtitle": track_info.get("subtitle", "Unknown Artist"),
                        "genres": track_info.get("genres", {}).get("primary", "Unknown"),
                        "shazam_url": track_info.get("url", ""),
                        "cover_art": track_info.get("images", {}).get("coverart", ""),
                    },
                }
            else:
                # Delete snippet if no track was identified
                Path(snippet_path).unlink(missing_ok=True)
            return None

        except Exception as e:
            error_msg = str(e).lower()

            # Check for rate limit errors
            if "rate limit" in error_msg or "429" in error_msg or "too many requests" in error_msg:
                if attempt < max_retries:
                    wait_time = (attempt + 1) * 3  # Exponential backoff: 3s, 6s
                    logger.warning(
                        f"Rate limit hit at {timestamp}s, retrying in {wait_time}s "
                        f"(attempt {attempt + 1}/{max_retries})"
                    )
                    await asyncio.sleep(wait_time)
                    continue
                else:
                    logger.error(f"Rate limit exceeded at {timestamp}s after {max_retries} retries")

            # Check for network/timeout errors
            elif "timeout" in error_msg or "network" in error_msg or "connection" in error_msg:
                if attempt < max_retries:
                    wait_time = 2
                    logger.warning(f"Network error at {timestamp}s, retrying in {wait_time}s")
                    await asyncio.sleep(wait_time)
                    continue
                else:
                    logger.error(f"Network error at {timestamp}s after {max_retries} retries: {e}")

            # Other errors
            else:
                logger.warning(f"Failed to identify snippet at {timestamp}s: {e}")

            Path(snippet_path).unlink(missing_ok=True)
            return None

    # Should not reach here, but just in case
    Path(snippet_path).unlink(missing_ok=True)
    return None


def save_shazam_results(track_id: int | str, results: list[dict]):
    """Save Shazam results to cache."""
    cache_dir = get_cache_dir()
    cache_path = cache_dir / f"track_{track_id}_shazam.json"
    with open(cache_path, "w") as f:
        json.dump(results, f, indent=2)


async def retry_identification_with_variations(
    snippet_path: str,
    timestamp: int,
    bpm_offsets: list[int],
    cache_key: str,
) -> list[dict] | None:
    """
    Retry identifying a snippet with pitch variations.

    Parameters
    ----------
    snippet_path : str
        Path to the original snippet
    timestamp : int
        Timestamp in seconds
    bpm_offsets : list[int]
        List of BPM offsets to try (e.g., [-3, 0, 3])
    cache_key : str
        Cache key for the track (used to clear stale cache)

    Returns
    -------
    list[dict] | None
        List of all identified results (one per variation), or None if no matches
    """
    cache_dir = get_cache_dir()
    shazam = Shazam()

    # Clear the cached result for this timestamp to force re-identification
    cache_path = cache_dir / f"track_{cache_key}_shazam.json"
    if cache_path.exists():
        try:
            with open(cache_path) as f:
                cached_data = json.load(f)
            # Remove entries with matching timestamp
            cached_data = [entry for entry in cached_data if entry.get("timestamp") != timestamp]
            with open(cache_path, "w") as f:
                json.dump(cached_data, f, indent=2)
            logger.info(f"Cleared cache for timestamp {timestamp}")
        except Exception as e:
            logger.warning(f"Failed to clear cache: {e}")

    # Build list of variations to try
    snippet_variations: list[str | tuple[str, int]] = []
    for bpm_offset in bpm_offsets:
        if bpm_offset == 0:
            # Use original snippet
            snippet_variations.append(str(snippet_path))
        else:
            # Create variation path
            # Extract track_id from snippet_path (format: snippet_{track_id}_{timestamp}.mp3)
            snippet_name = Path(snippet_path).stem
            parts = snippet_name.split("_")
            track_id = "_".join(parts[1:-1])  # Handle composite track IDs
            variation_path = cache_dir / f"snippet_{track_id}_{timestamp}_bpm{bpm_offset:+d}.mp3"
            snippet_variations.append((str(variation_path), bpm_offset))

    # Try identification with all variations, returning all results
    results = await _identify_snippet_with_variations(
        shazam, snippet_variations, timestamp, str(snippet_path), return_all=True
    )
    # Ensure we return list[dict] when return_all is True
    if isinstance(results, list):
        return results
    return [results] if results else []


async def search_soundcloud_track(query: str) -> Track | None:
    """
    Search for a track on SoundCloud.

    Parameters
    ----------
    query : str
        Search query (typically "artist - title")

    Returns
    -------
    Track | None
        First matching track or None if not found
    """
    try:
        client = get_client()
        result = await client.search(q=query)

        if not result or not result.collection:
            return None

        # Filter for tracks only
        tracks = [item for item in result.collection if item.kind == "track"]

        if not tracks:
            return None

        return tracks[0]  # Return first match
    except Exception as e:
        logger.warning(f"Failed to search SoundCloud for '{query}': {e}")
        return None


def render_track_info(track):
    """Display track information."""
    st.success(f"✅ Found: **{track.title}** by **{track.artist}**")

    col1, col2 = st.columns([1, 3])
    with col1:
        if track.artwork_url:
            st.image(track.hq_artwork_url, width=200)
    with col2:
        st.write(f"**Duration:** {track.duration_s // 60}:{track.duration_s % 60:02d}")
        st.write(f"**Genre:** {track.genre or 'N/A'}")
        st.write(f"**Plays:** {track.playback_count:,}" if track.playback_count else "")


def handle_bpm_analysis(track_id, client, track, sc_url):
    """Handle BPM analysis button and display results."""
    if st.button("🔍 Analyze BPM", type="primary"):
        # Check if already cached
        if is_track_cached(track_id):
            st.info("✨ Using cached track file")

        with st.spinner("Downloading track..." if not is_track_cached(track_id) else "Loading track..."):
            audio_path = download_track(sc_url, track_id)

            if audio_path:
                st.session_state.audio_file = str(audio_path)
                st.success("✅ Track ready")
            else:
                st.error("❌ Failed to download track")
                return False

        with st.spinner("Analyzing BPM... This may take a moment for long tracks."):
            segments = analyze_bpm_segments(str(audio_path))
            st.session_state.bpm_segments = segments
        return True
    return False


def display_bpm_segments(segments, track):
    """Display BPM analysis results."""
    st.success("✅ BPM Analysis Complete")

    if len(segments) == 1:
        st.metric("Detected BPM", f"{segments[0]['bpm']} BPM")
    else:
        st.warning(f"⚠️ Long track detected ({track.duration_s // 60} min). Showing BPM per segment:")

        # Display segments in columns
        cols = st.columns(min(len(segments), 4))
        for i, segment in enumerate(segments):
            with cols[i % 4]:
                start_min = int(segment["start"] // 60)
                end_min = int(segment["end"] // 60)
                st.metric(
                    f"Segment {i + 1}",
                    f"{segment['bpm']} BPM" if segment["bpm"] else "N/A",
                    delta=f"{start_min}-{end_min} min",
                    delta_color="off",
                )


def handle_pitch_shifting(segments, track_id):
    """Handle pitch shifting UI and processing."""
    # Get detected BPM (use first segment or average)
    if len(segments) == 1:
        detected_bpm = segments[0]["bpm"]
    else:
        valid_bpms = [s["bpm"] for s in segments if s["bpm"]]
        detected_bpm = int(np.mean(valid_bpms)) if valid_bpms else 120

    # Allow manual override of original BPM
    col1, col2, col3 = st.columns(3)

    with col1:
        st.metric("Detected BPM", f"{detected_bpm}")

    with col2:
        original_bpm = st.number_input(
            "Original BPM",
            min_value=20,
            max_value=300,
            value=detected_bpm,
            step=1,
            help="Override if detection is incorrect",
        )

    with col3:
        target_bpm = st.number_input(
            "Target BPM", min_value=20, max_value=300, value=original_bpm, step=1, help="Select the desired BPM"
        )

    # Show pitch change
    if target_bpm != original_bpm:
        semitones = 12 * np.log2(target_bpm / original_bpm)
        st.info(f"📊 Pitch shift: **{semitones:+.2f} semitones** ({target_bpm / original_bpm:.2%} speed)")

    # Process button
    col1, col2 = st.columns([1, 2])

    with col1:
        process_btn = st.button("🎚️ Apply Pitch Shift", disabled=(target_bpm == original_bpm), type="primary")

    if process_btn and st.session_state.get("audio_file"):
        with st.spinner("Processing audio... This may take a minute."):
            cache_dir = get_cache_dir()
            output_path = cache_dir / f"track_{track_id}_{original_bpm}bpm_to_{target_bpm}bpm.mp3"

            # Check if this shifted version is already cached
            if output_path.exists() and output_path.stat().st_size > 0:
                st.info("✨ Using cached shifted version")
                st.session_state.shifted_audio = str(output_path)
                st.success("✅ Pitch shift ready!")
            else:
                success = shift_pitch(st.session_state.audio_file, original_bpm, target_bpm, str(output_path))

                if success:
                    st.session_state.shifted_audio = str(output_path)
                    st.success("✅ Pitch shift applied!")
                else:
                    st.error("❌ Failed to process audio")

    return target_bpm


def get_cache_stats() -> dict:
    """
    Get statistics about the cache directory.

    Returns
    -------
    dict
        Dictionary with cache statistics
    """
    cache_dir = get_cache_dir()
    mp3_files = list(cache_dir.glob("*.mp3"))
    json_files = list(cache_dir.glob("*.json"))
    all_files = mp3_files + json_files
    total_size = sum(f.stat().st_size for f in all_files)

    # Count different file types
    track_files = [f for f in mp3_files if f.name.startswith("track_") and "snippet" not in f.name]
    snippet_files = [f for f in mp3_files if "snippet" in f.name]

    return {
        "num_files": len(all_files),
        "num_tracks": len(track_files),
        "num_snippets": len(snippet_files),
        "num_json": len(json_files),
        "total_size_mb": total_size / (1024 * 1024),
        "cache_dir": cache_dir,
    }


def clear_cache():
    """Clear all cached tracks and snippets."""
    cache_dir = get_cache_dir()
    for file in cache_dir.glob("*.mp3"):
        try:
            file.unlink()
        except Exception as e:
            logger.error(f"Failed to delete {file}: {e}")

    # Also clear JSON cache files
    for file in cache_dir.glob("*.json"):
        try:
            file.unlink()
        except Exception as e:
            logger.error(f"Failed to delete {file}: {e}")


def render_sidebar_cache_management():
    """Render cache management sidebar."""
    with st.sidebar:
        st.subheader("💾 Cache Management")
        cache_stats = get_cache_stats()

        st.metric("Total Files", cache_stats["num_files"])
        st.metric("Cache Size", f"{cache_stats['total_size_mb']:.2f} MB")

        with st.expander("Cache Details"):
            st.write(f"**Location:** `{cache_stats['cache_dir']}`")
            st.write(f"**Tracks:** {cache_stats['num_tracks']}")
            st.write(f"**Snippets:** {cache_stats['num_snippets']}")
            st.write(f"**Metadata:** {cache_stats['num_json']}")
            st.caption("Tracks are cached to avoid re-downloading. Snippets are kept for playback comparison.")

        if st.button("🗑️ Clear Cache", type="secondary"):
            clear_cache()
            st.success("Cache cleared!")
            st.rerun()


def get_track_from_url(sc_url: str, client):
    """Fetch track details from SoundCloud URL."""
    with st.spinner("Fetching track information..."):
        track_id = asyncio.run(client.get_track_id(sc_url))

    if not track_id:
        st.error("❌ Could not extract track ID from URL. Please check the URL and try again.")
        return None, None

    with st.spinner("Loading track details..."):
        track = asyncio.run(client.get_track(track_id=track_id))

    if not track:
        st.error("❌ Could not load track details")
        return None, None

    return track, track_id


def render_bpm_analysis_section(track, track_id, client, sc_url):
    """Render BPM analysis section."""
    st.subheader("2. BPM Analysis")

    if "bpm_segments" not in st.session_state or st.session_state.get("current_track_id") != track_id:
        st.session_state.current_track_id = track_id
        st.session_state.bpm_segments = None
        st.session_state.audio_file = None

    if not handle_bpm_analysis(track_id, client, track, sc_url):
        return False

    if not st.session_state.get("bpm_segments"):
        return False

    display_bpm_segments(st.session_state.bpm_segments, track)
    return True


def render_pitch_shifting_section(segments, track_id):
    """Render pitch shifting section."""
    st.divider()
    st.subheader("3. Adjust Pitch & Speed")

    target_bpm = handle_pitch_shifting(segments, track_id)
    st.session_state.target_bpm = target_bpm
    return target_bpm


def get_identification_audio_source(track_id, audio_source):
    """Determine which audio file and cache key to use for identification."""
    if audio_source == "Pitch-Shifted":
        audio_file = st.session_state.get("shifted_audio")
        cache_key = f"{track_id}_shifted_{st.session_state.get('target_bpm', 'unknown')}"

        if not audio_file:
            st.warning("⚠️ Please apply a pitch shift first to identify the shifted version")
            return None, None
    else:
        audio_file = st.session_state.get("audio_file")
        cache_key = str(track_id)

    return audio_file, cache_key


def load_cached_identification_results(cache_key, audio_source):
    """Load cached identification results if available."""
    cache_path = get_cache_dir() / f"track_{cache_key}_shazam.json"

    if not cache_path.exists():
        return False

    if st.session_state.get("shazam_source") != audio_source:
        st.session_state.shazam_results = None
        st.session_state.shazam_source = None
        return False

    if st.session_state.get("shazam_results") is not None:
        return True

    with open(cache_path) as f:
        st.session_state.shazam_results = json.load(f)
        st.session_state.shazam_source = audio_source

    st.info(f"✨ Loaded track identification from cache ({audio_source.lower()} version)")
    return True


def render_identification_settings(track, is_cached, use_smart_detection_default=True):
    """Render identification configuration settings."""
    with st.expander("⚙️ Identification Settings", expanded=False):
        use_smart_detection = st.checkbox(
            "🧠 Use Smart Detection (Recommended)",
            value=use_smart_detection_default,
            help="Automatically detect track transitions using BPM changes and energy analysis.",
        )

        if use_smart_detection:
            st.info("Smart detection analyzes BPM changes and audio energy to find where tracks transition.")
            samples_per_track = st.slider(
                "Samples per track",
                min_value=1,
                max_value=3,
                value=2,
                step=1,
                help="Number of samples to take per detected track for validation.",
            )
            st.caption("⚡ Smart detection typically uses 50-70% fewer API calls than fixed intervals")
            fallback_interval = 180
        else:
            st.warning("Using fixed interval sampling (less efficient)")
            fallback_interval = st.slider(
                "Interval between checks (seconds)",
                min_value=60,
                max_value=300,
                value=180,
                step=30,
                help="How often to check for new tracks.",
            )
            samples_per_track = 1

        st.divider()

        estimated_tracks = max(1, int(track.duration_s / 60 / 3.5)) if use_smart_detection else 0
        total_samples = (
            estimated_tracks * samples_per_track
            if use_smart_detection
            else len(list(range(30, int(track.duration_s) - 30, fallback_interval)))
        )

        if use_smart_detection:
            st.info(f"Estimated **{estimated_tracks}** tracks ≈ **{total_samples}** API calls")
        else:
            st.info(f"Will take **{total_samples}** samples at {fallback_interval}s intervals")

        cached_count = 0
        if is_cached:
            try:
                cache_path = get_cache_dir() / f"track_{st.session_state.current_track_id}_shazam.json"
                with open(cache_path) as f:
                    cached_data = json.load(f)
                    cached_count = len(cached_data)
            except Exception:
                pass

        new_samples = max(0, total_samples - cached_count)
        est_time = (new_samples / 5) * 2

        if cached_count > 0:
            st.success(
                f"✨ **{cached_count} samples already cached**, will process **{new_samples} new samples** "
                f"(est. **{est_time / 60:.1f} min**)"
            )
        elif new_samples > 0:
            st.caption(f"Est. time: **{est_time / 60:.1f} min**")

        st.caption("⏱️ Rate limiting: Processing 5 requests per batch with 2s delay")

    return use_smart_detection, samples_per_track, fallback_interval


def render_preview_transitions_button(audio_file):
    """Render preview transitions button."""
    if st.button("👁️ Preview Transitions", help="See where transitions are detected before identifying"):
        with st.spinner("Detecting transitions..."):
            try:
                transitions = detect_transitions(
                    audio_file,
                    bpm_segments=st.session_state.get("bpm_segments"),
                    min_transition_gap=120,
                    energy_threshold=0.3,
                )
                st.session_state.preview_transitions = transitions
                st.rerun()
            except Exception as e:
                st.error(f"Failed to detect transitions: {e}")


def render_transition_preview():
    """Render detected transitions preview."""
    if not st.session_state.get("preview_transitions"):
        return

    transitions = st.session_state.preview_transitions
    st.markdown("#### 🎯 Detected Transitions")
    st.caption(f"Found **{len(transitions)}** potential track changes:")

    transition_times = [f"{trans // 60:02d}:{trans % 60:02d}" for trans in transitions]

    cols = st.columns(min(len(transition_times), 5))
    for i, time_str in enumerate(transition_times):
        with cols[i % 5]:
            st.metric(f"Track {i + 1}", time_str, delta="transition", delta_color="off")

    st.caption("These timestamps will be used to intelligently sample the mix")


def run_track_identification(audio_file, track, cache_key, use_smart_detection, samples_per_track, fallback_interval):
    """Run track identification process."""
    progress_bar = st.progress(0, text="Starting identification...")
    status_text = st.empty()

    try:

        def update_progress(pct, msg):
            progress_bar.progress(pct, text=msg)
            status_text.text(msg)

        results = asyncio.run(
            identify_tracks_in_mix(
                audio_file,
                track.duration_s,
                cache_key,
                bpm_segments=st.session_state.get("bpm_segments"),
                use_smart_detection=use_smart_detection,
                samples_per_track=samples_per_track,
                fallback_interval=fallback_interval,
                progress_callback=update_progress,
            )
        )

        cache_path = get_cache_dir() / f"track_{cache_key}_shazam.json"
        with open(cache_path, "w") as f:
            json.dump(results, f, indent=2)

        st.session_state.shazam_results = results
        st.session_state.shazam_source = st.session_state.get("audio_source_selection", "Original")

        progress_bar.progress(100, text="Identification complete!")
        status_text.empty()
        st.success(f"✅ Identified {len(results)} unique tracks!")
    except Exception as e:
        logger.exception("Failed to identify tracks")
        st.error(f"❌ Identification failed: {e!s}")


def render_track_identification_section(track, track_id):
    """Render track identification section for DJ sets."""
    st.divider()
    st.subheader("4. Track Identification (DJ Set)")

    if "shazam_results" not in st.session_state:
        st.session_state.shazam_results = None
    if "shazam_source" not in st.session_state:
        st.session_state.shazam_source = None

    audio_source = st.radio(
        "Identify tracks from:",
        options=["Original", "Pitch-Shifted"],
        horizontal=True,
        help="Choose whether to identify from the original or pitch-shifted version",
    )
    st.session_state.audio_source_selection = audio_source

    audio_file, cache_key = get_identification_audio_source(track_id, audio_source)
    if not audio_file:
        return

    cache_path = get_cache_dir() / f"track_{cache_key}_shazam.json"
    load_cached_identification_results(cache_key, audio_source)

    use_smart_detection, samples_per_track, fallback_interval = render_identification_settings(
        track, cache_path.exists()
    )

    col1, col2, col3 = st.columns([1, 1, 2])

    with col1:
        if use_smart_detection and audio_file:
            render_preview_transitions_button(audio_file)

    with col2:
        identify_btn = st.button("🔍 Identify Tracks", type="primary", disabled=audio_file is None)

    if identify_btn:
        st.session_state.shazam_results = None
        st.session_state.pop("preview_transitions", None)

    with col3:
        if st.session_state.shazam_results and st.session_state.shazam_source == audio_source:
            st.success(f"✅ Identified {len(st.session_state.shazam_results)} tracks ({audio_source.lower()})")
        elif audio_file:
            st.info(f"Ready to identify tracks in the {audio_source.lower()} mix")

    render_transition_preview()

    if identify_btn and audio_file:
        run_track_identification(
            audio_file, track, cache_key, use_smart_detection, samples_per_track, fallback_interval
        )

    if st.session_state.shazam_results:
        render_identification_results(track_id, audio_source, cache_key)


def render_identification_results(track_id, audio_source, cache_key):
    """Render track identification results."""
    st.markdown("### Identified Tracks")

    if "sc_search_cache" not in st.session_state:
        st.session_state.sc_search_cache = {}

    with st.expander("Result Details", expanded=False):
        st.write(st.session_state.shazam_results)

    for i, result in enumerate(st.session_state.shazam_results):
        render_single_track_result(i, result, track_id, audio_source, cache_key)

    render_export_options(track_id)


def render_single_track_result(i, result, track_id, audio_source, cache_key):
    """Render a single track identification result."""
    timestamp = result["timestamp"]
    track_info = result["track"]
    confidence = result.get("confidence", 1.0)
    detections = result.get("detections", 1)
    samples = result.get("samples", 1)

    time_str = f"{timestamp // 60:02d}:{timestamp % 60:02d}"

    confidence_emoji = "🟢" if confidence >= 0.67 else "🟡" if confidence >= 0.5 else "🔴"

    search_query = f"{track_info['subtitle']} - {track_info['title']}"
    bpm_variation = result.get("bpm_variation")
    variation_tag = f" [{bpm_variation}]" if bpm_variation and bpm_variation != "original" else ""

    expander_title = (
        f"{confidence_emoji} **{time_str}** - {track_info['title']} - "
        f"{track_info['subtitle']}{variation_tag} ({detections}/{samples} matches)"
    )

    with st.expander(expander_title, expanded=False):
        st.progress(
            confidence,
            text=f"Confidence: {confidence:.0%} ({detections}/{samples} samples matched)",
        )

        snippet_path = result.get("snippet_path")
        if snippet_path and Path(snippet_path).exists():
            st.markdown("**🎧 Original Snippet (10s from mix)**")
            with open(snippet_path, "rb") as f:
                st.audio(f.read(), format="audio/mp3")
            st.caption(f"Extracted from {time_str} in the mix")
            st.divider()

        col1, col2 = st.columns([1, 1])

        with col1:
            render_track_info_panel(track_info, bpm_variation)

        with col2:
            render_soundcloud_search_panel(i, search_query)

        if track_info.get("cover_art"):
            st.image(track_info["cover_art"], width=200)

        st.divider()
        render_pitch_retry_panel(i, result, track_id, audio_source, cache_key)


def render_track_info_panel(track_info, bpm_variation):
    """Render track information panel."""
    st.markdown("**Track Info**")
    st.write(f"**Title:** {track_info['title']}")
    st.write(f"**Artist:** {track_info['subtitle']}")
    if track_info.get("genres"):
        st.write(f"**Genre:** {track_info['genres']}")

    if bpm_variation and bpm_variation != "original":
        st.info(f"🎚️ Identified using **{bpm_variation}** pitch adjustment")

    if track_info.get("shazam_url"):
        st.link_button("🔗 View on Shazam", track_info["shazam_url"], use_container_width=True)


def render_soundcloud_search_panel(i, search_query):
    """Render SoundCloud search panel."""
    st.markdown("**SoundCloud Player**")

    cache_key = f"{i}_{search_query}"

    if cache_key not in st.session_state.sc_search_cache:
        if st.button("🔍 Search on SoundCloud", key=f"search_{i}"):
            with st.spinner("Searching SoundCloud..."):
                sc_track = asyncio.run(search_soundcloud_track(search_query))
                st.session_state.sc_search_cache[cache_key] = sc_track
                st.rerun()
    else:
        sc_track = st.session_state.sc_search_cache[cache_key]

        if sc_track:
            render_embedded_track(sc_track, height=166)
            if st.button("🔄 Search Again", key=f"clear_{i}"):
                del st.session_state.sc_search_cache[cache_key]
                st.rerun()
        else:
            st.warning("Track not found on SoundCloud")
            if st.button("🔄 Try Again", key=f"retry_{i}"):
                del st.session_state.sc_search_cache[cache_key]
                st.rerun()


def render_pitch_retry_panel(i, result, track_id, audio_source, cache_key):
    """Render pitch variation retry panel."""
    st.markdown("**🎚️ Retry with Pitch Variations**")
    st.caption("Try different tempo adjustments if this identification seems incorrect")

    retry_col1, retry_col2, retry_col3 = st.columns([1, 1, 1])

    with retry_col1:
        lower_bpm = st.number_input(
            "Lower BPM",
            min_value=-10,
            max_value=0,
            value=-3,
            step=1,
            key=f"lower_{i}",
            help="Try pitching down",
        )

    with retry_col2:
        upper_bpm = st.number_input(
            "Upper BPM",
            min_value=0,
            max_value=10,
            value=3,
            step=1,
            key=f"upper_{i}",
            help="Try pitching up",
        )

    with retry_col3:
        st.write("")
        st.write("")
        if st.button("🔄 Retry Identification", key=f"retry_pitch_{i}", use_container_width=True):
            handle_pitch_retry(i, result, track_id, audio_source, cache_key, lower_bpm, upper_bpm)


def handle_pitch_retry(i, result, track_id, audio_source, cache_key_template, lower_bpm, upper_bpm):
    """Handle pitch variation retry logic."""
    bpm_offsets = []
    if lower_bpm < 0:
        bpm_offsets.append(lower_bpm)
    bpm_offsets.append(0)
    if upper_bpm > 0:
        bpm_offsets.append(upper_bpm)

    cache_key_retry = (
        f"{track_id}_shifted_{st.session_state.get('target_bpm', 'unknown')}"
        if audio_source == "Pitch-Shifted"
        else str(track_id)
    )

    snippet_path = result.get("snippet_path")
    timestamp = result["timestamp"]

    with st.spinner(f"Retrying with {len(bpm_offsets)} variations..."):
        try:
            results_list = asyncio.run(
                retry_identification_with_variations(snippet_path, timestamp, bpm_offsets, cache_key_retry)
            )

            if results_list:
                st.success(f"✅ Found {len(results_list)} match(es) across {len(bpm_offsets)} variations")
                render_variation_results(i, results_list, cache_key_retry)
            else:
                st.error("❌ Could not identify track with any variation")
        except Exception as e:
            logger.exception("Retry failed")
            st.error(f"❌ Retry failed: {e}")


def render_variation_results(i, results_list, cache_key_retry):
    """Render all attempted variation results."""
    st.markdown("**All Attempted Variations:**")

    for idx, result in enumerate(results_list):
        bpm_var = result.get("bpm_variation", "unknown")

        with st.container():
            if result.get("error"):
                st.error(f"**{bpm_var}:** {result['error']}")
                st.divider()
                continue

            if result.get("no_match"):
                render_no_match_variation(result, bpm_var)
                st.divider()
                continue

            render_matched_variation(i, idx, result, bpm_var, cache_key_retry)
            st.divider()


def render_no_match_variation(result, bpm_var):
    """Render a variation that didn't match."""
    result_col1, result_col2 = st.columns([3, 1])

    with result_col1:
        st.warning(f"**{bpm_var}:** No match found")

        var_snippet_path = result.get("variation_snippet_path")
        if var_snippet_path and Path(var_snippet_path).exists():
            st.caption("Listen to this variation:")
            with open(var_snippet_path, "rb") as f:
                st.audio(f.read(), format="audio/mp3")

    with result_col2:
        st.write("")


def render_matched_variation(i, idx, result, bpm_var, cache_key_retry):
    """Render a matched variation."""
    track_title = result["track"]["title"]
    track_artist = result["track"]["subtitle"]

    result_col1, result_col2 = st.columns([3, 1])

    with result_col1:
        st.markdown(f"**{bpm_var}:** {track_title} - {track_artist}")

        var_snippet_path = result.get("variation_snippet_path")
        if var_snippet_path and Path(var_snippet_path).exists():
            with open(var_snippet_path, "rb") as f:
                st.audio(f.read(), format="audio/mp3")

    with result_col2:
        if st.button(
            "Select",
            key=f"select_{i}_{idx}",
            use_container_width=True,
        ):
            select_variation_result(i, result, bpm_var, cache_key_retry)


def select_variation_result(i, result, bpm_var, cache_key_retry):
    """Update session state with selected variation."""
    current_results = list(st.session_state.shazam_results)
    original_result = current_results[i]

    updated_result = {
        "timestamp": original_result["timestamp"],
        "snippet_path": original_result.get("snippet_path"),
        "confidence": original_result.get("confidence", 1.0),
        "detections": original_result.get("detections", 1),
        "samples": original_result.get("samples", 1),
        "track": result["track"],
        "bpm_variation": result.get("bpm_variation", "original"),
        "variation_snippet_path": result.get("variation_snippet_path"),
    }

    current_results[i] = updated_result
    st.session_state.shazam_results = current_results

    old_search_query = f"{original_result['track']['subtitle']} - {original_result['track']['title']}"
    old_cache_key = f"{i}_{old_search_query}"
    if "sc_search_cache" in st.session_state and old_cache_key in st.session_state.sc_search_cache:
        del st.session_state.sc_search_cache[old_cache_key]

    save_shazam_results(cache_key_retry, st.session_state.shazam_results)
    st.success(f"✅ Selected {bpm_var} variation")
    st.rerun()


def render_export_options(track_id):
    """Render export options for identified tracks."""
    st.divider()
    col1, col2 = st.columns(2)

    with col1:
        json_data = json.dumps(st.session_state.shazam_results, indent=2)
        st.download_button(
            "📥 Download as JSON",
            json_data,
            file_name=f"tracklist_{track_id}.json",
            mime="application/json",
        )

    with col2:
        tracklist_lines = [
            f"{r['timestamp'] // 60:02d}:{r['timestamp'] % 60:02d} - {r['track']['title']} - {r['track']['subtitle']}"
            for r in st.session_state.shazam_results
        ]
        tracklist_text = "\n".join(tracklist_lines)
        st.download_button(
            "📥 Download as Text", tracklist_text, file_name=f"tracklist_{track_id}.txt", mime="text/plain"
        )


def render_playback(track):
    """Render audio playback section."""
    st.divider()
    st.subheader("5. Playback")

    col1, col2 = st.columns(2)

    with col1:
        st.write("**Original**")
        if st.session_state.get("audio_file"):
            with open(st.session_state.audio_file, "rb") as f:
                st.audio(f.read(), format="audio/mp3")

    with col2:
        st.write("**Shifted**")
        if st.session_state.get("shifted_audio"):
            with open(st.session_state.shifted_audio, "rb") as f:
                audio_data = f.read()
                st.audio(audio_data, format="audio/mp3")

                target_bpm = st.session_state.get("target_bpm", "shifted")
                st.download_button(
                    label="⬇️ Download Shifted Track",
                    data=audio_data,
                    file_name=f"{track.title}_shifted_{target_bpm}bpm.mp3",
                    mime="audio/mp3",
                )
        else:
            st.info("Apply pitch shift to hear the result")


def main():
    st.title("🎵 BPM Analyzer & Pitch Shifter")
    st.markdown("Analyze BPM and adjust pitch/speed of SoundCloud tracks")

    render_sidebar_cache_management()

    client = get_client()

    st.subheader("1. Enter SoundCloud Link")
    sc_url = st.text_input(
        "SoundCloud Track/Set URL",
        placeholder="https://soundcloud.com/artist/track-name",
        help="Paste a SoundCloud track or set URL",
    )

    if not sc_url:
        st.info("👆 Enter a SoundCloud URL to get started")
        return

    track, track_id = get_track_from_url(sc_url, client)
    if not track or not track_id:
        return

    render_track_info(track)
    st.divider()

    if not render_bpm_analysis_section(track, track_id, client, sc_url):
        return

    render_pitch_shifting_section(st.session_state.bpm_segments, track_id)

    if track.duration_s / 60 > 20:
        render_track_identification_section(track, track_id)

    render_playback(track)


if __name__ == "__main__":
    main()
