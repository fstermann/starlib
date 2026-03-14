# Like Explorer — Phase 0 Analysis

## Page Purpose

The Like Explorer allows users to explore and create custom playlists from SoundCloud artists' likes and reposts. It provides:
- Search for SoundCloud users/artists
- Fetch all likes and reposts from selected artist
- Filter tracks by date range, length, search query
- Exclude tracks the user has already liked
- Create private SoundCloud playlists with filtered results
- Set playlist artwork from artist's avatar

## Inputs

### User Search
- **Search query**: Text input for finding SoundCloud users
- **Selected user**: Radio button selection from search results

### Collection Actions
- **Collect button**: Triggers fetching of all likes/reposts for selected user
- **User ID**: Internal ID used for API calls

### Filters
- **Search**: Text query to filter tracks by title or artist
- **Start Date**: Date picker for minimum track date (defaults to beginning of time)
- **End Date**: Date picker for maximum track date (defaults to today)
- **Max Length**: Number input for maximum track duration in minutes (default: 12)
- **Exclude Own Liked Tracks**: Checkbox to filter out tracks user has already liked
- **Own Likes Count**: Display of how many tracks will be excluded

### Playlist Creation
- **Create Playlist button**: Triggers playlist creation from filtered results

## Outputs

### Display Elements
- **User Profile Display**:
  - Username with link to profile
  - Full name
  - Location (city, country code)
  - Follower count
  - Avatar image
- **Likes Section**: List of filtered liked tracks with embedded players
- **Reposts Section**: List of filtered reposted tracks with embedded players
- **Track Counts**: Metrics showing number of filtered likes/reposts

### API Operations
- **Create Playlist**: POST request to SoundCloud API
  - Playlist title: `{artist} | Likes & Reposts | {start_date} - {end_date}`
  - Playlist description: `Likes and reposts of {artist} from {start_date} - {end_date}`
  - Tracks: List of track IDs in chronological order
  - Sharing: Private
  - Tags: `likes,reposts,soundcloud-tools`
- **Update Playlist Image**: POST request to update playlist artwork
  - Downloads artist's high-quality avatar
  - Encodes as base64
  - Uploads to playlist

### User Feedback
- **Success toasts**: Playlist created with track count
- **Warning messages**: No avatar found, no users found
- **Error messages**: Track not found, invalid URL
- **Loading spinners**: "Fetching tracks" during API calls

## Session State

- `user_query`: Search query string for finding users
- `selected_user`: Currently selected User object
- `user_likes`: List of all likes (Repost objects) for selected user
- `user_reposts`: List of all reposts (Repost objects) for selected user
- `own_likes`: List of current user's own likes (for exclusion)
- `fetched_user`: Dict mapping user ID → boolean (tracks which users have been fetched)
- `search_result`: Cached search results (from shared component)

## Filesystem Interactions

**None** — This page is entirely API-driven with no local filesystem access.

## Audio Processing Steps

**None** — No audio file manipulation. Only metadata operations via API.

## SoundCloud API Integration

### User Search
1. **Endpoint**: `client.search(q=user_query)`
2. **Response**: Mixed collection of users, tracks, playlists
3. **Processing**:
   - Filter for `kind == "user"`
   - Display as radio buttons
   - Cache results via `@st.cache_data`

### Fetch User Likes
1. **Endpoint**: `client.get_user_likes(user_id, limit, offset)`
2. **Pagination**: Loop through `next_href` until exhausted
3. **Response**: List of Repost objects containing:
   - `track`: Track object with metadata
   - `created_at`: When track was liked
4. **Limit**: 200 items per request (configurable)

### Fetch User Reposts
1. **Endpoint**: `client.get_user_reposts(user_id, limit, offset)`
2. **Pagination**: Same as likes
3. **Response**: List of Repost objects
4. **Type**: Can be track or playlist reposts

### Fetch Own Likes
1. **Endpoint**: `client.get_user_likes(user_id=settings.user_id, ...)`
2. **Purpose**: Build exclusion list for filtering
3. **User ID**: Retrieved from settings (authenticated user)

### Create Playlist
1. **Build Request**:
   - Merge likes + reposts, sort by `created_at` (descending)
   - Deduplicate by track ID (preserve first occurrence)
   - Build `PlaylistCreateRequest` with Pydantic model:
     ```python
     PlaylistCreate(
         title="...",
         description="...",
         tracks=[track_ids],
         sharing="private",
         tag_list="likes,reposts,soundcloud-tools"
     )
     ```
2. **Endpoint**: `client.post_playlist(data=playlist_request)`
3. **Response**: Created Playlist object with ID

### Update Playlist Image
1. **Download Avatar**:
   - URL: `user.hq_avatar_url`
   - Method: `requests.get(url).content`
2. **Encode**: Base64 encode image data
3. **Build Request**:
   ```python
   PlaylistUpdateImageRequest(image_data=base64_string)
   ```
4. **Endpoint**: `client.update_playlist_image(playlist_urn, data)`
5. **URN Format**: `soundcloud:playlists:{playlist_id}`

## Collection Filtering Logic

### Filter Criteria
Applied to both likes and reposts:

1. **Has Track**: Must have `track` attribute (exclude playlist reposts)
2. **Date Range**: `start_date <= item.created_at.date() <= end_date`
3. **Max Length**: `item.track.duration / 60_000 < max_length` (duration in ms → minutes)
4. **Own Likes**: `item.track.id not in own_likes` (if exclude enabled)
5. **Search Query**: Regex search (case-insensitive) in:
   - `item.track.title`
   - `item.track.artist`

### Sort Order
- Sorted by `created_at` descending (newest first)
- Within playlist: maintain chronological order for context

## Data Models

### User Object
```python
{
    "id": int,
    "username": str,
    "full_name": str,
    "permalink": str,
    "permalink_url": str,
    "avatar_url": str,
    "hq_avatar_url": str,
    "city": str | None,
    "country_code": str | None,
    "followers_count": int,
    "verified": bool
}
```

### Repost/Like Object
```python
{
    "track": Track,
    "created_at": datetime,
    "type": "track-repost" | "track"
}
```

### Track Object
```python
{
    "id": int,
    "title": str,
    "artist": str,  # Derived from user.username or publisher_metadata
    "duration": int,  # milliseconds
    "permalink_url": str,
    "user": User,
    "hq_artwork_url": str
}
```

## UI Components

### User Display (`display_user`)
- 2-column layout: info | avatar
- Username (linked), full name, location, follower count

### Collection Display (`display_collection_tracks`)
- Embedded SoundCloud players for selected tracks
- Track selection via radio buttons
- Shows title, artist, duration

### Embedded Track Player
- HTML iframe with SoundCloud player widget
- Auto-play disabled
- Shows comments, user, teaser

## Dependencies

### External Libraries
- **streamlit**: UI framework
- **asyncio**: Async API calls
- **requests**: Download avatar images
- **base64**: Encode images for API upload
- **devtools**: Pretty-print for logging

### Internal Modules
- `soundcloud_tools.streamlit.client.get_client()`: SoundCloud API client
- `soundcloud_tools.models.User`: User data model
- `soundcloud_tools.models.Track`: Track data model
- `soundcloud_tools.models.Repost`: Repost/like data model
- `soundcloud_tools.models.playlist.Playlist`: Playlist model
- `soundcloud_tools.models.playlist.PlaylistCreate`: Create request model
- `soundcloud_tools.models.playlist.PlaylistUpdateImageRequest`: Image update model
- `soundcloud_tools.settings.get_settings()`: Access user_id

## Error Handling

- **No users found**: Show error, stop execution
- **No likes/reposts fetched**: Show warning, disable filtering
- **API pagination errors**: Log error, raise exception
- **Playlist creation failure**: Exception propagates to UI
- **No avatar available**: Show warning, skip image update
- **Invalid track ID**: Return None, show error message

## Performance Considerations

### Caching
- `@st.cache_data` on `search_users()`: Cache search results
- `@st.cache_data` on `fetch_collection_response()`: Cache API pagination
- Hash function for method: Convert to string

### Pagination
- Fetch in chunks of 200 items
- Progress shown via spinner with "Fetching tracks" message
- Can take significant time for users with thousands of likes

### Rate Limiting
- No explicit handling in current implementation
- Relies on API client's built-in throttling

## Edge Cases

- **Playlist reposts**: Filtered out (only track reposts shown)
- **Duplicate tracks**: Deduplicated when creating playlist
- **Very long playlists**: All tracks included, no pagination limit
- **Empty results**: Shows appropriate warnings
- **Missing avatar**: Skips image update, shows warning
- **Own likes not fetched**: Exclusion filter won't work, but doesn't break
