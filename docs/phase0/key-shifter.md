# Key Shifter — Phase 0 Analysis

## Page Purpose

The Key Shifter provides two distinct functionalities:
1. **Individual Track Key Calculator**: Calculate the new Camelot key when a track's tempo is changed by resampling (pitch follows tempo)
2. **Collection BPM Analysis & Labeling**: Batch analyze BPM for all tracks in a folder and write BPM values to metadata

## Inputs

### Individual Key Shifter
- **Original Camelot Key**: Pill selection from 24 options (1A-12A, 1B-12B)
  - Default: "8A"
- **Original BPM**: Number input (100-180, step 1)
  - Default: 128
- **Target BPM**: Number input (100-180, step 1)
  - Default: 140

### Collection BPM Analysis
- **Folder Selection**: Via file_selector component
  - Root folder path
  - Mode (prepare/collection/cleaned)
  - Automatically scans for audio files in selected folder
- **Target BPM for Collection**: Number input (100-180, step 1)
  - Default: 140
  - Used for TPUB metadata tag
- **Analyze Button**: Triggers BPM detection for all tracks
- **Write Metadata Button**: Writes target BPM to TPUB tag for all tracks

## Outputs

### Individual Key Shifter
- **Shifted Camelot Key**: Displayed as code block
  - Format: `{key}@{target_bpm}`
  - Example: `10A@140`

### Collection BPM Analysis
- **Analysis Results Table**: DataFrame showing:
  - Track title
  - Artist
  - Detected BPM (from analysis)
  - Target BPM (user input)
  - Shifted Key (calculated from 8A)
  - Filename
- **Progress Feedback**:
  - Progress bar during analysis (0-100%)
  - Status text showing current track being analyzed
  - Success message with track count
- **Metadata Write Results**:
  - Progress bar during write (0-100%)
  - Status text showing current track being written
  - Success message with track count

### Filesystem Operations
- **Metadata Write**: Updates TPUB tag in ID3 metadata
  - Tag: `TPUB` (Publisher field, repurposed for BPM)
  - Value: `str(int(target_bpm))`
  - Encoding: UTF-8 (encoding=3)

## Session State

- `analysis_results`: List of dict containing:
  ```python
  {
      "filename": str,
      "title": str,
      "artist": str,
      "original_bpm": float,
      "file_path": str,
      "handler": TrackHandler
  }
  ```
- File selector state (from shared component):
  - `mode`: Folder mode
  - Various track info fields (`ti_*`)

## Filesystem Interactions

### Read Operations
- **Scan folder**: Use `load_tracks(folder)` to find all audio files
- **Load audio for BPM analysis**: Read file into memory for Essentia processing
- **Read existing metadata**: Load ID3 tags via mutagen

### Write Operations
- **Write TPUB metadata**: Update ID3 tags in-place
  ```python
  audio_file = ID3(file_path)
  audio_file.add(TPUB(encoding=3, text=str(int(target_bpm))))
  audio_file.save()
  ```

### No File Movement
- All operations are in-place metadata updates
- No file creation, deletion, or relocation

## Audio Processing Steps

### Individual Key Calculation

**Algorithm**: `shifted_key(camelot_key, orig_bpm, target_bpm)`

1. **Parse Camelot Key**:
   - Extract number (1-12) and letter (A/B)
   - Validate format
2. **Calculate Pitch Shift**:
   - Ratio: `target_bpm / orig_bpm`
   - Semitones: `12 * log2(ratio)`
   - Round to nearest integer
3. **Convert to Camelot Step**:
   - Formula: `(semitones * 7) % 12`
   - Circle of fifths relationship
4. **Apply to Camelot Wheel**:
   - New number: `(orig_num + step_change - 1) % 12 + 1`
   - Letter unchanged (A/B preserved)

**Example**:
- Original: 4A @ 128 BPM
- Target: 140 BPM
- Ratio: 1.09375 → +1.53 semitones → +2 semitones
- Step: (2 * 7) % 12 = 2
- Result: 6A @ 140 BPM

### Collection BPM Analysis

**Function**: `analyze_collection_bpm(files, root_folder, progress_bar, status_text)`

For each file:
1. **Load Track Handler**:
   - Create `TrackHandler(root_folder, file)`
   - Extract existing `track_info`
2. **Predict BPM**:
   - Use `BPMPredictor().predict(file_path)`
   - Returns single float value
3. **Store Results**:
   - Track info + predicted BPM
   - Keep handler reference for metadata writing
4. **Update Progress**:
   - Calculate: `(i + 1) / len(files)`
   - Update progress bar and status text
5. **Error Handling**:
   - Catch exceptions per-file
   - Log error, skip file, continue

**BPM Detection Details** (via Essentia):
- Algorithm: `RhythmExtractor2013(method="multifeature")`
- Input: Audio loaded at 44100 Hz sample rate
- Output: BPM as float
- Used by: `BPMPredictor` class

### Metadata Writing

**Function**: `write_bpm_to_metadata(track_results, target_bpm, progress_bar, status_text)`

For each track:
1. **Load ID3 Tags**:
   ```python
   audio_file = ID3(str(file_path))
   ```
2. **Add/Update TPUB**:
   ```python
   audio_file.add(TPUB(encoding=3, text=str(int(target_bpm))))
   ```
3. **Save File**:
   ```python
   audio_file.save()
   ```
4. **Update Progress**: Same as analysis
5. **Error Handling**: Log error, continue

## Dependencies

### External Libraries
- **pandas**: DataFrame creation for results display
- **streamlit**: UI framework
- **mutagen.id3**: ID3 tag reading/writing
  - `ID3`: Main tag container
  - `TPUB`: Publisher tag (repurposed for BPM)
- **math**: `log2()` for pitch shift calculation

### Internal Modules
- `soundcloud_tools.handler.track.TrackHandler`: File operations
- `soundcloud_tools.predict.bpm.BPMPredictor`: BPM detection
- `soundcloud_tools.streamlit.file_selection.file_selector`: File picker
- `soundcloud_tools.utils.load_tracks`: Scan folder for audio files

### Audio Analysis (via BPMPredictor)
- **Essentia**: Music information retrieval library
  - `RhythmExtractor2013`: BPM detection algorithm

## Mathematical Background

### Pitch-Tempo Relationship
When resampling audio (no time-stretching):
- Increasing tempo → increases pitch
- Relationship: `new_pitch = old_pitch * (new_tempo / old_tempo)`
- Measured in semitones: 12 per octave

### Camelot Wheel Mapping
- 12 positions (1-12) represent keys
- A/B represent major/minor
- Adjacent positions differ by perfect fifth (7 semitones)
- Formula: `step = (semitones * 7) % 12`

## Error Handling

### Individual Key Shifter
- **Invalid Camelot format**: Raise `ValueError`
  - Must be format: `{1-12}{A|B}`
- **Invalid letter**: Raise `ValueError`
  - Must be 'A' or 'B'
- **Division by zero**: Not handled (assumes valid BPM > 0)

### Collection Analysis
- **No files found**: Show warning, return early
- **Analysis error per file**:
  - Display error message with filename
  - Continue to next file
  - Don't abort entire batch
- **Metadata write error per file**:
  - Display error message with filename
  - Continue to next file

## UI Layout

### Individual Shifter Section
```
┌─────────────────────────────────────────┐
│ Individual Track Key Shifter            │
├─────────────────────────────────────────┤
│ [Camelot Key Pills]         │ ┌───────┐ │
│ Original BPM: [128]         │ │Result │ │
│ Target BPM: [140]           │ │  8A   │ │
│                             │ │ @140  │ │
│                             │ └───────┘ │
└─────────────────────────────────────────┘
```

### Collection Analysis Section
```
┌─────────────────────────────────────────┐
│ Collection BPM Analysis & Labeling      │
├─────────────────────────────────────────┤
│ Found N audio files in `folder`         │
│                                          │
│ [🔍 Analyze BPM]  Target BPM: [140]    │
│                                          │
│ [Results Table]                         │
│                                          │
│ [📝 Write BPM to TPUB]  [🗑️ Clear]     │
└─────────────────────────────────────────┘
```

## Performance Considerations

### BPM Analysis
- **CPU-intensive**: Each track takes ~2-10 seconds
- **Sequential processing**: One track at a time
- **Progress feedback**: Essential for long operations
- **No caching**: Re-analysis required each session

### Metadata Writing
- **Fast operation**: ~0.1-0.5 seconds per file
- **Batch friendly**: Entire collection in seconds
- **In-place updates**: No file duplication

## Edge Cases

- **Empty folder**: Show warning, disable analysis
- **Unsupported file formats**: Skip silently or error per file
- **Missing ID3 tags**: Create new tag container
- **Zero/negative BPM**: May cause mathematical errors
- **Very high/low BPM**: Calculation works but results may be musically nonsensical
- **Corrupted audio**: BPM predictor may fail, caught and logged

## Future Enhancement Opportunities

- Parallel processing for BPM analysis
- Caching of analyzed BPMs
- Support for other metadata tags (TBPM standard tag)
- Batch key detection (not just BPM)
- Visualization of BPM distribution across collection
