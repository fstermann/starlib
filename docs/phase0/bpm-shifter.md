# BPM Shifter — Phase 0 Analysis

## Page Purpose

The BPM Shifter is a comprehensive tool for analyzing and manipulating SoundCloud DJ mixes and tracks. It provides:
- Download SoundCloud tracks/sets to local cache
- Analyze BPM by segments (for long DJ mixes)
- Detect track transitions in mixes using energy and BPM changes
- Pitch-shift entire tracks to target BPM
- Identify tracks in DJ mixes using Shazam API with intelligent sampling
- Retry identification with pitch variations for better accuracy
- Search identified tracks on SoundCloud and embed players
- Export tracklists as JSON or text

## Inputs

### Track Selection
- **SoundCloud URL**: Text input for track or set URL
  - Format: `https://soundcloud.com/artist/track-name`
  - Supports both individual tracks and DJ sets/mixes

### BPM Analysis
- **Analyze BPM button**: Triggers segmented BPM analysis
- **Segment duration**: Fixed at 300 seconds (5 minutes) for long tracks (>20 min)

### Pitch Shifting
- **Target BPM**: Number input for desired BPM
- **Apply Pitch Shift button**: Triggers audio resampling

### Track Identification
- **Use Smart Detection**: Checkbox to enable/disable transition detection
  - Default: True
- **Samples per Track**: Number input for samples to take per detected track segment
  - Default: 2
- **Fallback Interval**: Number input for sampling interval when smart detection fails
  - Default: 180 seconds
- **Run Identification button**: Triggers Shazam analysis

### Pitch Variation Retry (per identified track)
- **Lower BPM**: Number input for negative pitch adjustment (-10 to 0, default: -3)
- **Upper BPM**: Number input for positive pitch adjustment (0 to 10, default: 3)
- **Retry Identification button**: Re-runs Shazam with pitch variations

### SoundCloud Search (per identified track)
- **Search on SoundCloud button**: Searches and embeds player for identified track

### Cache Management (sidebar)
- **Clear Cache button**: Deletes all cached tracks, snippets, and results

## Outputs

### Track Information Display
- Track title and artist
- Duration (mm:ss format)
- Genre
- Play count
- Artwork image

### BPM Analysis Results
- **Table of segments** (for long tracks):
  - Start time
  - End time
  - Detected BPM per segment
- **Summary**: Total segments, BPM range

### Pitch-Shifted Audio
- **Audio player**: Plays shifted version
- **Download button**: Download as MP3 file
  - Filename: `{title}_shifted_{target_bpm}bpm.mp3`

### Track Identification Results
- **List of identified tracks** with:
  - Timestamp in mix (mm:ss)
  - Track title and artist
  - Genre
  - Confidence score
  - Number of detections
  - Cover artwork
  - Link to Shazam
  - 10-second snippet audio player
  - Embedded SoundCloud player (after search)
  - Pitch variation used (if applicable)

### Export Options
- **JSON export**: Full identification data structure
  - Filename: `tracklist_{track_id}.json`
- **Text export**: Simple timestamp + track format
  - Filename: `tracklist_{track_id}.txt`
  - Format: `MM:SS - Title - Artist`

### Cache Statistics (sidebar)
- Total cached tracks
- Total cache size (MB)
- Last cleanup date

## Session State

### Audio Files
- `audio_file`: Path to downloaded/cached original track
- `shifted_audio`: Path to pitch-shifted output track

### BPM Data
- `bpm_segments`: List of segment analysis results:
  ```python
  [{"start": float, "end": float, "bpm": int}, ...]
  ```
- `target_bpm`: User-selected target BPM for pitch shifting

### Identification Data
- `shazam_results`: List of identified tracks with full metadata
- `sc_search_cache`: Dict mapping `{index}_{query}` → SoundCloud Track object
- `audio_source`: String indicating which audio was used ("Original" or "Pitch-Shifted")

## Filesystem Interactions

### Cache Directory Structure
```
.cache/tracks/
├── track_{track_id}.mp3                    # Downloaded SoundCloud tracks
├── track_{track_id}_shifted_{bpm}.mp3      # Pitch-shifted versions
├── track_{track_id}_shazam.json            # Shazam results cache
├── snippet_{track_id}_{timestamp}.mp3      # 10-second samples
└── snippet_{track_id}_{timestamp}_bpm{±N}.mp3  # Pitch-varied samples
```

### Read Operations
- **Load cached track**: Check if track already downloaded
- **Load cached Shazam results**: Read JSON file with previous identifications
- **Load cached snippets**: Read previously extracted audio samples
- **Calculate cache stats**: Scan cache directory, sum file sizes

### Write Operations
- **Download track**: Save MP3 from SoundCloud using yt-dlp
- **Save pitch-shifted audio**: Export resampled audio to cache
- **Extract snippets**: Export 10-second segments at sample points
- **Create pitch variations**: Export pitch-adjusted snippets
- **Save Shazam results**: Write JSON cache incrementally after each batch
- **Update Shazam cache**: Modify JSON to replace/remove specific timestamp entries

### Delete Operations
- **Clear cache**: Recursively delete all files in cache directory
- **Delete failed snippets**: Remove snippets that didn't match
- **Delete stale variations**: Clean up pitch-varied snippets after selection

## Audio Processing Steps

### 1. Track Download

**Function**: `download_track(soundcloud_url, track_id)`

1. **Check Cache**:
   - Path: `.cache/tracks/track_{track_id}.mp3`
   - Return immediately if exists and valid (size > 0)

2. **Download with yt-dlp**:
   ```python
   ydl_opts = {
       "format": "bestaudio/best",
       "outtmpl": ".cache/tracks/track_{track_id}",
       "postprocessors": [{
           "key": "FFmpegExtractAudio",
           "preferredcodec": "mp3",
           "preferredquality": "192"
       }]
   }
   ```
3. **Verify**: Check file exists after download
4. **Return**: Path to cached file

### 2. BPM Analysis

**Function**: `analyze_bpm_segments(audio_path, segment_duration=300)`

1. **Load Audio**:
   - Use Essentia's `MonoLoader(filename, sampleRate=44100)`
   - Calculate total duration from sample count

2. **Short Track (<20 minutes)**:
   - Analyze entire track as one segment
   - Use `RhythmExtractor2013(method="multifeature")`
   - Return single BPM value

3. **Long Track (≥20 minutes)**:
   - Split into 5-minute segments
   - For each segment:
     - Extract audio samples for time range
     - Run BPM detection
     - Handle exceptions (set BPM to None)
   - Return list of segment BPMs

**Essentia Algorithm**:
- Input: Mono audio at 44.1kHz
- Method: Multi-feature rhythm extraction (combines multiple algorithms)
- Output: Float BPM value

### 3. Transition Detection

**Function**: `detect_transitions(audio_path, bpm_segments, min_transition_gap=120, energy_threshold=0.3)`

Detects likely track boundaries in DJ mixes using two methods:

#### BPM-Based Detection
1. Iterate through BPM segments
2. Compare adjacent BPMs: `abs(curr_bpm - prev_bpm) > 3`
3. Mark transition at segment boundary
4. Log BPM change (e.g., "128 → 135 BPM")

#### Energy-Based Detection
1. **Windowing**:
   - Window size: 5 seconds
   - Hop size: 2 seconds
   - Use Hann window

2. **Energy Calculation**:
   - For each window:
     - Apply windowing
     - Compute spectrum (FFT)
     - Calculate energy
   - Normalize energy values (0-1)

3. **Valley Detection**:
   - Use `scipy.signal.find_peaks` on inverted energy
   - Prominence: `energy_threshold` (0.3)
   - Distance: `min_transition_gap / hop_size` (60 windows)
   - Energy drops indicate transitions (track changes)

4. **Filter Edges**: Exclude transitions near start/end (±30 seconds)

#### Combining Results
1. Merge BPM and energy transitions into set
2. Sort chronologically
3. Enforce minimum spacing:
   - Keep transitions ≥ `min_transition_gap` (120s) apart
   - When conflict: keep first occurrence
4. Return sorted list of timestamps

### 4. Smart Sample Generation

**Function**: `generate_smart_sample_points(duration_s, transitions, samples_per_track=2, fallback_interval=180, min_gap=30)`

#### With Transitions
1. **First Track**: Sample at midpoint before first transition
2. **For Each Subsequent Track**:
   - Calculate track duration: `next_transition - curr_transition`
   - If duration > `min_gap * 2`:
     - Take `samples_per_track` samples
     - Evenly spaced across track duration
     - Example: 2 samples → at 1/3 and 2/3 points
3. **Skip Short Segments**: Ignore tracks < 60 seconds

#### Without Transitions (Fallback)
- Sample every `fallback_interval` (180s)
- Start at `min_gap` (30s)
- End at `duration_s - min_gap`

#### Post-Processing
1. Deduplicate timestamps
2. Enforce `min_gap` spacing between samples
3. Return sorted list

### 5. Pitch Shifting

**Function**: `shift_pitch(audio_path, original_bpm, target_bpm, output_path)`

1. **Load Audio**: Using pydub `AudioSegment.from_file()`
2. **Calculate Playback Rate**:
   ```python
   playback_rate = target_bpm / original_bpm
   ```
3. **Resample**:
   - Change frame rate: `new_rate = original_rate * playback_rate`
   - This speeds up/slows down audio AND changes pitch
4. **Normalize**:
   - Set frame rate back to standard (44.1kHz)
   - Audio is now at target tempo/pitch
5. **Export**: Save as MP3

**Note**: This changes BOTH tempo and pitch together (no time-stretching)

### 6. Track Identification

**Function**: `identify_tracks_in_mix(audio_path, duration_s, track_id, bpm_segments, ...)`

#### Incremental Caching
1. **Load Cache**: Read `track_{track_id}_shazam.json`
2. **Build Lookup**: Map timestamp → result
3. **Skip Cached Samples**: Only process new timestamps

#### Sample Extraction
For each sample point:
1. **Check Cache**: Skip if result exists
2. **Extract Snippet**:
   - Start: `timestamp * 1000` (convert to ms)
   - Duration: 10 seconds
   - Export as MP3: `snippet_{track_id}_{timestamp}.mp3`
3. **Create Async Task**: `_identify_snippet(shazam, path, timestamp)`

#### Batch Processing
1. **Rate Limiting**:
   - Batch size: 5 concurrent requests
   - Delay: 2 seconds between batches
   - Prevents Shazam API rate limits

2. **Execute Batch**:
   ```python
   await asyncio.gather(*batch, return_exceptions=True)
   ```

3. **Incremental Cache Update**:
   - After EACH batch:
     - Merge new results with cached results
     - Write entire dataset to JSON
     - Provides resilience against interruptions

#### Error Handling & Retries
**Per Sample** (in `_identify_snippet`):
- **Rate Limit (429)**: Retry with exponential backoff (3s, 6s)
- **Network/Timeout**: Retry after 2 seconds
- **Max Retries**: 2 attempts
- **Failed Samples**: Delete snippet, return None

#### Result Grouping
1. **Sort** all results by timestamp
2. **Group Consecutive Matches**:
   - Same track (title + artist match)
   - Within 5 minutes of each other
3. **Create Track Entries**:
   - Use earliest timestamp
   - Calculate confidence: `min(1.0, detections / 2)`
   - Store detection count
4. Return list of unique tracks

### 7. Pitch Variation Retry

**Function**: `retry_identification_with_variations(snippet_path, timestamp, bpm_offsets, cache_key)`

For failed or uncertain identifications:

1. **Clear Stale Cache**: Remove cached result for this timestamp
2. **Build Variations**:
   - Offset 0: Use original snippet
   - Offset ±N: Create pitch-shifted versions
     ```python
     playback_rate = 1 + (bpm_offset / 128.0)
     ```
   - Save as `snippet_{track_id}_{timestamp}_bpm{±N}.mp3`

3. **Try All Variations**:
   - Call Shazam for each variation
   - Return ALL results (including misses)

4. **User Selection**:
   - Display all attempts with audio players
   - User selects correct match
   - Update cache with selected result

## Dependencies

### External Libraries
- **yt-dlp**: Download SoundCloud tracks
- **pydub**: Audio manipulation (pitch shifting, snippet extraction)
- **Essentia**: BPM detection (`RhythmExtractor2013`)
- **scipy**: Signal processing (`find_peaks` for transition detection)
- **numpy**: Array operations for energy analysis
- **shazamio**: Track identification (Shazam API wrapper)
- **asyncio**: Concurrent Shazam requests
- **json**: Cache serialization
- **base64**: Image encoding (for playlist artwork in Like Explorer)
- **requests**: HTTP requests (artwork download)

### Internal Modules
- `soundcloud_tools.streamlit.client.get_client()`: SoundCloud API client
- `soundcloud_tools.models.Track`: Track data model
- `soundcloud_tools.streamlit.utils.render_embedded_track()`: SoundCloud player embed

### External Tools
- **ffmpeg**: Required by yt-dlp and pydub for format conversion

## Error Handling

### Download Errors
- **yt-dlp failure**: Log error, return None, show error message
- **Cache read failure**: Treat as missing, proceed with download

### Analysis Errors
- **BPM detection per segment**: Catch exception, set BPM to None, continue
- **Transition detection failure**: Fallback to interval sampling

### Identification Errors
- **Shazam rate limit**: Exponential backoff, retry up to 2 times
- **Network timeout**: Retry with 2-second delay
- **No match**: Delete snippet, return None, continue
- **Batch failure**: Log exception, save partial results, continue

### Pitch Shift Errors
- **pydub exception**: Log error, return False, show error message
- **Invalid BPM**: No explicit handling (assumes valid input)

## Performance Considerations

### Caching Strategy
- **Track downloads**: Permanent cache (until manually cleared)
- **Shazam results**: Persistent JSON cache
- **Snippets**: Kept for playback comparison
- **Pitch variations**: Cleaned up after selection (to save space)

### Optimization
- **Incremental caching**: Save after each Shazam batch
- **Cache reuse**: Check before re-downloading or re-identifying
- **Concurrent requests**: 5 parallel Shazam queries
- **Rate limiting**: Prevent API blocks

### Resource Usage
- **Long mixes**: ~30-60 samples × 10s each = 5-10 minutes analysis time
- **Disk space**: ~5-10 MB per track download, ~100-500 KB per snippet
- **Network**: Depends on track length and identification count

## UI Layout

```
┌─────────────────────────────────────────┐
│ 1. Enter SoundCloud Link               │
│    [URL input]                          │
│    Track info display                   │
├─────────────────────────────────────────┤
│ 2. BPM Analysis                         │
│    [🔍 Analyze BPM]                     │
│    [BPM segments table]                 │
├─────────────────────────────────────────┤
│ 3. Pitch Shifting                       │
│    Target BPM: [140]                    │
│    [Apply Pitch Shift]                  │
├─────────────────────────────────────────┤
│ 4. Track Identification (mixes >20min)│
│    [Settings inputs]                    │
│    [Run Identification]                 │
│    [Progress bar]                       │
│                                          │
│    For each identified track:           │
│    ┌──────────────────────────────────┐ │
│    │ Timestamp | Track Info           │ │
│    │ [Snippet player]                 │ │
│    │ [SoundCloud player]              │ │
│    │ [Pitch retry panel]              │ │
│    └──────────────────────────────────┘ │
│    [Export JSON] [Export Text]          │
├─────────────────────────────────────────┤
│ 5. Playback                             │
│    Original | Shifted                   │
│    [Player]   [Player + Download]       │
└─────────────────────────────────────────┘
```

### Sidebar
```
┌─────────────────────┐
│ Cache Management    │
├─────────────────────┤
│ Cached Tracks: N    │
│ Cache Size: X MB    │
│ [🗑️ Clear Cache]   │
└─────────────────────┘
```

## Edge Cases

### Track Download
- **Invalid URL**: Show error, stop execution
- **Private/deleted track**: yt-dlp fails, show error
- **Very large file**: May timeout or fill disk

### BPM Analysis
- **Variable tempo**: Each segment gets independent BPM
- **No clear beat**: May return unreliable BPM values
- **Short tracks**: Analyzed as single segment

### Transition Detection
- **No transitions found**: Fallback to interval sampling
- **False positives**: Minimized by min_gap spacing
- **Energy artifacts**: May create spurious transitions

### Track Identification
- **No matches**: Shows empty list, export still available
- **Partial matches**: Some samples identify, others don't
- **Wrong identifications**: User can retry with pitch variations
- **Rate limits**: Automatic retry with backoff
- **Cache corruption**: Warnings logged, proceeds with fresh cache

### Pitch Shifting
- **Extreme BPM ratios**: Audio quality degrades significantly
- **Already at target BPM**: Produces identical copy
- **Large file**: May take significant time

## Future Enhancement Opportunities

- Parallel BPM analysis (multiple segments at once)
- Time-stretching (change tempo without pitch)
- Key detection and harmonic mixing suggestions
- Automatic tracklist formatting (with timestamps)
- Upload to SoundCloud as timestamped comments
- Batch processing of multiple mixes
- Machine learning for better transition detection
- Metadata tagging of identified tracks in cache
