# Meta Editor — Phase 0 Analysis

## Page Purpose

The Meta Editor is the primary tool for editing audio track metadata with integrated SoundCloud search functionality. It allows users to:
- Edit track metadata (title, artist, genre, release date, artwork, remix info, comments)
- Search for tracks on SoundCloud and copy their metadata
- Manage artwork (view, add, remove, download covers)
- Convert audio files between formats (AIFF ↔ MP3)
- Rename files based on metadata
- Finalize tracks by converting and moving them to the "cleaned" collection

## Inputs

### File Selection
- **Root folder**: Path to music library root (from settings or user input)
- **Mode**: Selection of folder mode
  - `prepare`: Staging area for new files
  - `collection`: Main organized music library
  - `cleaned`: Final processed files
  - `""` (Direct): Custom folder path
- **Selected file**: Single audio file selected from the chosen folder

### SoundCloud Search
- **Enable toggle**: Whether to enable SoundCloud search
- **Search query**: Text query for SoundCloud search (auto-populated from cleaned filename)
- **Track URL**: Optional direct URL to a specific SoundCloud track
- **Selected track**: Track selected from search results

### Metadata Editors
- **Title**: Text input for track title
- **Artists**: Text input for artist name(s), supports multiple artists separated by comma
- **Genre**: Text input for genre classification
- **Release date**: Date picker for track release date
- **Artwork URL**: URL to fetch artwork from
- **Remix info** (optional):
  - Original artist(s)
  - Remixer(s)
  - Mix name (e.g., "Remix", "VIP Mix")
- **Comment**: Structured comment with version, SoundCloud ID, and permalink

### Metadata Actions (Buttons)
- **Clean**: Remove free download mentions, separate artists
- **Titelize**: Capitalize title/artists properly
- **Remove 'Original Mix'**: Strip "Original Mix" from title
- **Build from Remix**: Construct title from remix components
- **Remove parenthesis**: Strip `[]` brackets
- **Isolate Title**: Extract just the title part

### Auto-Actions (Checkboxes)
- **Auto Artwork**: Automatically copy artwork if missing
- **Auto Metadata**: Automatically copy metadata if missing
- **Auto Clean**: Automatically clean title and artists
- **Auto Titelize**: Automatically capitalize
- **Auto Remove 'Original Mix'**: Automatically strip original mix

### Conversion & Finalization
- **Convert format**: Dropdown to select mp3 or aiff
- **Save**: Save metadata to current file
- **Finalize**: Convert format (if needed) and move to cleaned folder
- **Rename**: Rename file to match metadata
- **Delete**: Delete the current file

## Outputs

### Metadata Updates
- **ID3 tags** (MP3 files):
  - `TIT2`: Title
  - `TPE1`: Artist
  - `TCON`: Genre
  - `TDRC` or `TDRL`: Release date
  - `APIC`: Artwork (embedded image)
  - `COMM`: Comment
  - Remix fields:
    - `TOPE`: Original artist
    - `TPE4`: Remixer
    - `TIT3`: Mix name
- **AIFF chunks** (AIFF files):
  - Equivalent ID3 tags written to AIFF format

### File Operations
- **Rename**: File renamed to `{artist} - {title}.{ext}`
- **Convert to MP3**: File transcoded to 320kbps MP3
- **Convert to AIFF**: File transcoded to AIFF format
- **Move to cleaned**: File moved from prepare → cleaned folder
- **Archive**: Original file moved to archive after conversion
- **Delete**: File permanently deleted

### UI Feedback
- **Success messages**: Metadata saved, file renamed, finalized
- **Warning messages**: File already exists, conversion failed
- **Error messages**: Invalid folder, no files found
- **Toast notifications**: Quick action confirmations

## Session State

All track info fields are prefixed with `ti_`:

- `ti_title`: Current title value
- `ti_artist`: Current artist value
- `ti_genre`: Current genre value
- `ti_release_date`: Current release date value
- `ti_remixer`: Remix remixer value
- `ti_original_artist`: Remix original artist value
- `ti_mix_name`: Remix mix name
- `ti_comment`: Comment text
- `ti_comment_on_sc`: Boolean, whether comment is on SoundCloud
- `ti_artwork_url`: URL for artwork download
- `ti_search_url`: SoundCloud track URL from search
- `search_result`: Dict mapping query → search results (cached)
- `mode`: Current folder mode (prepare/collection/cleaned/direct)
- `finalize_disabled`: Boolean, whether finalize button is disabled
- `convert_format`: Selected conversion format (mp3/aiff)
- `auto_copy_artwork`: Auto-action checkbox state
- `auto_copy_metadata`: Auto-action checkbox state
- `auto_clean`: Auto-action checkbox state
- `auto_titelize`: Auto-action checkbox state
- `auto_remove_original_mix`: Auto-action checkbox state
- `new_track_name`: Name of renamed track (for success message)

## Filesystem Interactions

### Read Operations
- **Load audio file**: Read file for playback and metadata extraction
- **Read existing metadata**: Extract ID3/AIFF tags from audio file
- **List folder contents**: Enumerate audio files in selected folder
- **Check file existence**: Verify if MP3 export already exists

### Write Operations
- **Save metadata**: Write updated ID3/AIFF tags to file
- **Add/remove artwork**: Modify APIC tags in file
- **Rename file**: Change filename on disk
- **Convert format**: Create new file with different format
- **Move file**: Transfer file between prepare/cleaned/archive folders
- **Delete file**: Remove file from disk

### Folder Structure
```
{root_folder}/
├── prepare/          # Staging area for new tracks
├── collection/       # Main organized library
├── cleaned/          # Final processed tracks
└── archive/          # Original files after conversion
```

## Audio Processing Steps

### Metadata Extraction
1. Load audio file using mutagen (MP3/AIFF/WAV)
2. Extract ID3 tags or AIFF chunks
3. Parse into TrackInfo model:
   - Title, artist(s), genre, release date
   - Artwork (APIC data)
   - Remix info (TOPE, TPE4, TIT3)
   - Comment (COMM)
4. Populate session state with extracted values

### Metadata Writing
1. Collect modified values from session state
2. Create TrackInfo object with new values
3. Write to audio file:
   - **MP3**: Use mutagen.id3 to write/update tags
   - **AIFF**: Use mutagen.aiff to write ID3-style chunks
4. Save file to disk

### Format Conversion

#### MP3 Conversion (AIFF/WAV → MP3)
1. Execute ffmpeg command:
   ```bash
   ffmpeg -i input.{aiff,wav} -b:a 320k -q:a 0 output.mp3
   ```
2. Copy metadata to new MP3 file
3. Verify conversion success
4. Move original to archive folder

#### AIFF Conversion (MP3/WAV → AIFF)
1. Execute ffmpeg command:
   ```bash
   ffmpeg -i input.{mp3,wav} output.aiff
   ```
2. Copy metadata to new AIFF file
3. Verify conversion success
4. Move original to archive folder

### Finalization Workflow
1. Check metadata completeness (title, artist, genre, date, artwork)
2. Check exactly 1 cover exists
3. If format matches target → move to cleaned
4. If format differs:
   - Convert to target format
   - Copy all metadata to new file
   - Move original to archive
   - Move converted file to cleaned

### Artwork Processing
1. **Fetch from URL**: Download image from `artwork_url` using requests
2. **Embed in file**: Add APIC tag with JPEG image data
3. **Extract from file**: Read APIC tags, display in UI
4. **Remove covers**: Delete all APIC tags from file
5. **Download cover**: Export APIC data as JPEG file

## SoundCloud Integration

### Search Flow
1. Clean filename: Remove underscores, "Free DL", remix markers
2. Execute search query via SoundCloud API
3. Cache results in session state (`search_result[query]`)
4. Filter for track-type results
5. Display tracks with radio button selection
6. Show embedded player for selected track

### Metadata Import
1. Convert SoundCloud Track object to TrackInfo
2. Extract fields:
   - `title` → from track.title
   - `artist` → from publisher_metadata.artist or user.username
   - `genre` → from track.genre
   - `release_date` → from track.display_date
   - `artwork_url` → from track.hq_artwork_url
3. Auto-detect remix info from title parsing
4. Create Comment with SoundCloud ID and permalink

### Direct URL Import
1. Extract track ID from SoundCloud URL
2. Fetch track directly via API
3. Import metadata (same as search flow)

## Dependencies

### External Libraries
- **mutagen**: Audio metadata reading/writing (ID3, AIFF, WAV)
- **streamlit**: UI framework
- **requests**: Download artwork from URLs
- **asyncio**: Async SoundCloud API calls

### Internal Modules
- `soundcloud_tools.handler.track.TrackHandler`: Main file handler
- `soundcloud_tools.handler.track.TrackInfo`: Metadata model
- `soundcloud_tools.streamlit.client.get_client()`: SoundCloud API client
- `soundcloud_tools.streamlit.components.*`: UI component builders
- `soundcloud_tools.utils.string.*`: String cleaning utilities

## Edge Cases & Error Handling

- **Invalid folder**: Show error, stop execution
- **No files found**: Show warning, stop execution
- **File already exists**: Show warning when MP3 export exists
- **Conversion failure**: Show warning, fallback to move without conversion
- **Missing SoundCloud results**: Show "No tracks found" warning
- **Invalid track URL**: Show error message
- **Incomplete metadata**: Disable finalize button
- **No covers/multiple covers**: Disable finalize button
