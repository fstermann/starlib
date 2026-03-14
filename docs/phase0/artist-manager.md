# Artist Manager — Phase 0 Analysis

## Page Purpose

The Artist Manager provides a UI for managing the weekly archive artist filter configuration. It allows users to:
- Browse and search their followed artists on SoundCloud
- Filter artists by username, permalink, location, follower count, verification status
- Select/deselect artists for inclusion in weekly archive filtering
- Generate environment variable configuration for deployment
- Export configuration as .env file snippet
- Manual configuration via text input

## Inputs

### Artist Loading
- **Load Your Followed Artists button**: Fetches artist shortcuts from SoundCloud API
  - Loads current user's followed artists

### Filters
- **Search Username**: Text input for filtering by display name
  - Case-insensitive substring match
- **Search Permalink**: Text input for filtering by permalink (URL identifier)
  - Case-insensitive substring match
- **Search Location**: Text input for filtering by city or country code
  - Searches combined city + country string
- **Min Followers**: Number input for minimum follower count
  - Default: 0
  - Step: 1000
- **Verified Only**: Checkbox to show only verified artists
  - Default: False
- **Show Selected Only**: Checkbox to filter to selected artists
  - Default: False

### Sort Options
- **Sort By**: Dropdown selection
  - "Username (A-Z)"
  - "Username (Z-A)"
  - "Followers (High-Low)"
  - "Followers (Low-High)"
  - Default: "Username (A-Z)"

### Selection Controls
- **Per-Artist Checkbox**: Toggle individual artist selection
- **Select All Filtered**: Select all currently visible artists
- **Deselect All Filtered**: Deselect all currently visible artists
- **Clear All Selections**: Reset entire selection to empty

### Pagination
- **Current Page**: Displayed in UI
- **Previous Button**: Navigate to previous page
- **Next Button**: Navigate to next page
- **Artists per Page**: Fixed at 50

### Manual Configuration (Tab 2)
- **Artist Permalinks**: Text area for comma-separated permalinks
- **Update Selection button**: Applies manual input to selections

## Outputs

### Artist Display
For each artist (grid layout, 2 columns):
- **Checkbox**: Selection state
- **Username**: Linked to SoundCloud profile
- **Verified Badge**: ✓ if verified
- **Permalink**: Displayed as code (`permalink`)
- **Full Name**: Real name display
- **Follower Count**: Formatted with commas
- **Location**: City, country (if available)

### Configuration Generation
- **Selected Artist Count**: Metric display
- **Environment Variable**: Code block with generated config
  ```bash
  WEEKLY_ARCHIVE_ARTISTS="permalink1,permalink2,..."
  ```
- **Download Button**: .env file snippet download
  - Filename: `weekly_archive_artists.env`
- **Copy Text Area**: Expandable text area for manual copy

### Sidebar: Current Configuration
- **Configured Artist Count**: Number of artists in current settings
- **Artist List**: Expandable list of current artists (alphabetical)
- **Instructions**: How to apply configuration

## Session State

### Artist Data
- `artists`: List of artist objects:
  ```python
  {
      "id": int,
      "permalink": str,
      "username": str,
      "full_name": str,
      "followers": int,
      "verified": bool,
      "city": str,
      "country": str,
      "permalink_url": str
  }
  ```

### Selection State
- `selected_artists`: Set of permalink strings
  - Persists across filter changes
  - Pre-populated with current config on first load
- `loaded_config`: Boolean flag to prevent repeated auto-load
  - Set to True after loading settings into selections

### Pagination State
- `current_page`: Integer page index (0-based)
  - Resets when filters change
  - Persists during navigation

### Other State
- `sc_search_cache`: Shared cache from other tools (not directly used here)

## Filesystem Interactions

**None directly** — This page is configuration-only.

### Settings Integration
- **Read**: Access current `WEEKLY_ARCHIVE_ARTISTS` from settings
  - Via `get_settings().weekly_archive_artists`
  - Comma-separated string of permalinks
- **Write**: User must manually update `.env` file or GitHub secrets
  - Application restart required to apply changes

## Audio Processing Steps

**None** — This page handles configuration management only.

## SoundCloud API Integration

### Fetch Artist Shortcuts

**Endpoint**: `client.get_artist_shortcuts()`

**Response Structure**:
```python
{
    "collection": [
        {
            "user": {
                "id": int,
                "permalink": str,
                "username": str,
                "full_name": str,
                "followers_count": int,
                "verified": bool,
                "city": str | None,
                "country_code": str | None,
                "permalink_url": str
            }
        },
        ...
    ]
}
```

**Processing**:
1. Extract user objects from collection
2. Transform into flat dictionary structure
3. Store in session state
4. Display success message with count

**Caching**: Not cached — fetches fresh on each button click

## Filtering Logic

Applied sequentially to `st.session_state.artists`:

1. **Username Filter**:
   ```python
   search_username.lower() in artist["username"].lower()
   ```

2. **Permalink Filter**:
   ```python
   search_permalink.lower() in artist["permalink"].lower()
   ```

3. **Location Filter**:
   ```python
   search_location.lower() in (artist["city"] + " " + artist["country"]).lower()
   ```

4. **Follower Filter**:
   ```python
   artist["followers"] >= min_followers
   ```

5. **Verified Filter**:
   ```python
   artist["verified"] == True
   ```

6. **Selection Filter**:
   ```python
   artist["permalink"] in st.session_state.selected_artists
   ```

All filters are AND-combined (all must pass).

## Sorting Logic

Applied after filtering:

- **Username (A-Z)**: `sorted(artists, key=lambda x: x["username"].lower())`
- **Username (Z-A)**: Same with `reverse=True`
- **Followers (High-Low)**: `sorted(artists, key=lambda x: x["followers"], reverse=True)`
- **Followers (Low-High)**: `sorted(artists, key=lambda x: x["followers"])`

## Pagination Logic

1. **Calculate Pages**:
   ```python
   total_pages = (len(filtered_artists) + 49) // 50
   ```

2. **Slice for Page**:
   ```python
   start_idx = current_page * 50
   end_idx = start_idx + 50
   page_artists = filtered_artists[start_idx:end_idx]
   ```

3. **Navigation**:
   - Previous: Decrement `current_page`, rerun
   - Next: Increment `current_page`, rerun
   - Buttons disabled at boundaries

4. **Reset on Filter Change**: Implicit via `st.rerun()`

## Selection Management

### Initial Load
1. Check if `loaded_config` flag is set
2. If not, load `settings.weekly_archive_artists`
3. Parse comma-separated string
4. Initialize `selected_artists` set
5. Set `loaded_config = True`

### Individual Selection
1. User toggles checkbox
2. Compare with current selection state
3. If changed:
   - Add to or remove from `selected_artists`
   - Call `st.rerun()`

### Bulk Selection
- **Select All**: Add all `filtered_artists` permalinks to set
- **Deselect All**: Remove all `filtered_artists` permalinks from set
- **Clear All**: Empty the `selected_artists` set

All bulk operations trigger `st.rerun()`.

## Configuration Export

### Generate Environment Variable
1. Sort selected permalinks alphabetically
2. Join with commas (no spaces)
3. Wrap in quotes:
   ```python
   env_value = ",".join(sorted(selected_artists))
   f'WEEKLY_ARCHIVE_ARTISTS="{env_value}"'
   ```

### Download as File
- **Content**: Environment variable line + newline
- **Filename**: `weekly_archive_artists.env`
- **MIME type**: `text/plain`

### Copy to Clipboard (via text area)
- User clicks "Show in text area"
- Text area appears with full env variable
- User manually copies

## Dependencies

### External Libraries
- **streamlit**: UI framework
- **asyncio**: Async API calls

### Internal Modules
- `soundcloud_tools.streamlit.client.get_client()`: SoundCloud API client
- `soundcloud_tools.settings.get_settings()`: Access current configuration

## Error Handling

### API Errors
- **No artists fetched**: No explicit error handling (empty list)
- **API failure**: Exception propagates to UI (Streamlit handles)

### Configuration Errors
- **Invalid permalink format**: No validation (accepts any string)
- **Duplicate permalinks**: Set naturally handles duplicates

## UI Layout

### Tab 1: Browse & Filter Artists
```
┌─────────────────────────────────────────┐
│ [Load Your Followed Artists]            │
├─────────────────────────────────────────┤
│ Filters:                                 │
│ [Search Username] [Search Permalink]    │
│ [Search Location]                        │
│ [Min Followers] [Verified Only]         │
│ [Show Selected Only]                    │
├─────────────────────────────────────────┤
│ Sort: [Dropdown]  Results: N            │
├─────────────────────────────────────────┤
│ [Select All] [Deselect All] [Clear]    │
├─────────────────────────────────────────┤
│ Artists (N):                            │
│ ┌─────────────┬─────────────┐          │
│ │ [☑] Artist 1│ [☐] Artist 2│          │
│ │ Info...     │ Info...     │          │
│ └─────────────┴─────────────┘          │
│ ...                                      │
├─────────────────────────────────────────┤
│ [◄ Previous] Page X/Y [Next ►]         │
├─────────────────────────────────────────┤
│ Generated Configuration:                │
│ Selected Artists: N                     │
│ WEEKLY_ARCHIVE_ARTISTS="..."           │
│ [Download .env] [Show text area]       │
└─────────────────────────────────────────┘
```

### Tab 2: Manual Configuration
```
┌─────────────────────────────────────────┐
│ Artist Permalinks:                      │
│ [Text area with comma-separated list]  │
│                                          │
│ [Update Selection from Manual Input]   │
├─────────────────────────────────────────┤
│ Tips:                                    │
│ • Permalink format                      │
│ • Case insensitive                      │
│ • No spaces in names                    │
│ • Unique identifier                     │
│ • Example usage                         │
└─────────────────────────────────────────┘
```

### Sidebar
```
┌─────────────────────┐
│ Current Config      │
├─────────────────────┤
│ Configured: N       │
│ [View Artists ▼]    │
│ • artist1           │
│ • artist2           │
│ ...                 │
├─────────────────────┤
│ How to apply:       │
│ 1. Filter & select  │
│ 2. Copy env var     │
│ 3. Add to .env      │
│ 4. Restart app      │
└─────────────────────┘
```

## Performance Considerations

### API Calls
- **Fetch artists**: Single API call per button click
- **No pagination**: Loads all followed artists at once
- **No caching**: Fresh data on each load

### Filtering & Sorting
- **Client-side**: All filtering done in Python
- **Fast operations**: Even with thousands of artists
- **Instant feedback**: Rerun is quick for filter changes

### State Management
- **Persistent selection**: Survives filter changes
- **Page reset**: Avoids showing empty pages after filtering

## Edge Cases

### Empty States
- **No followed artists**: Shows empty list
- **No filter matches**: Shows 0 results, pagination hidden
- **No selection**: Shows empty configuration

### Large Datasets
- **Thousands of artists**: Pagination handles well
- **Long permalinks**: UI may need horizontal scroll
- **Many selected**: Generated config can be very long

### Configuration
- **Trailing commas**: Not validated (may cause parsing issues)
- **Spaces in permalinks**: Not validated (likely invalid)
- **Empty permalinks**: Not filtered out
- **Duplicate selections**: Set prevents duplicates

### Manual Input
- **Malformed input**: Splits on commas, accepts any string
- **Mixed case**: Works (SoundCloud permalinks are case-insensitive)
- **Extra whitespace**: Stripped via `.strip()`

## Integration with Weekly Archive

### Purpose
The generated `WEEKLY_ARCHIVE_ARTISTS` environment variable is used by a separate weekly archive feature (not in Streamlit app) to filter tracks.

### Configuration Flow
1. User selects artists in Artist Manager
2. Copies generated environment variable
3. Adds to deployment environment (`.env` or GitHub secrets)
4. Restarts application
5. Weekly archive script uses this config to filter tracks

### Settings Access
```python
settings = get_settings()
current_artists = settings.weekly_archive_artists  # Comma-separated string
artist_list = [a.strip() for a in current_artists.split(",")]
```

## Future Enhancement Opportunities

- Auto-sync with `.env` file (write directly)
- Import from existing `.env` file
- Batch operations (select by genre, country, follower range)
- Artist analytics (track count, recent activity)
- Grouping/tagging of artists for organization
- Preview of affected tracks before applying
- Automatic application restart after config change
- Validation of permalink format
- Conflict resolution (if local and remote configs differ)
