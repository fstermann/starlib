import asyncio
import logging

import streamlit as st

from soundcloud_tools.settings import get_settings
from soundcloud_tools.streamlit.client import get_client

logger = logging.getLogger(__name__)


def main():  # noqa: C901
    st.title("👥 Artist Manager")
    st.markdown("Manage artists for weekly archive filtering")

    client = get_client()
    settings = get_settings()

    # Sidebar: Current Configuration
    with st.sidebar:
        st.subheader("📋 Current Configuration")

        current_artists = getattr(settings, "weekly_archive_artists", "")
        if current_artists:
            artist_list = [a.strip() for a in current_artists.split(",") if a.strip()]
            st.metric("Configured Artists", len(artist_list))

            with st.expander("View Artists"):
                for artist in sorted(artist_list):
                    st.write(f"• {artist}")
        else:
            st.info("No artists configured yet")

        st.divider()

        st.markdown("""
        **How to apply configuration:**

        1. Filter and select artists below
        2. Copy the generated env variable
        3. Add it to your `.env` file or GitHub secrets:
           ```
           WEEKLY_ARCHIVE_ARTISTS="permalink1,permalink2,..."
           ```
        4. Restart the application
        """)

    # Main content
    tab1, tab2 = st.tabs(["🔍 Browse & Filter Artists", "⚙️ Manual Configuration"])

    with tab1:
        st.subheader("Your Followed Artists")

        # Initialize session state for selections
        if "selected_artists" not in st.session_state:
            st.session_state.selected_artists = set()

        # Load current config into selections on first run
        if "loaded_config" not in st.session_state and current_artists:
            artist_list = [a.strip() for a in current_artists.split(",") if a.strip()]
            st.session_state.selected_artists = set(artist_list)
            st.session_state.loaded_config = True

        # Fetch artist shortcuts
        if st.button("📥 Load Your Followed Artists", type="primary"):
            with st.spinner("Loading followed artists..."):
                artist_shortcuts = asyncio.run(client.get_artist_shortcuts())
                st.session_state.artists = [
                    {
                        "id": a.user.id,
                        "permalink": a.user.permalink,
                        "username": a.user.username,
                        "full_name": a.user.full_name,
                        "followers": a.user.followers_count,
                        "verified": a.user.verified,
                        "city": a.user.city or "",
                        "country": a.user.country_code or "",
                        "permalink_url": a.user.permalink_url,
                    }
                    for a in artist_shortcuts.collection
                ]
                st.success(f"✅ Loaded {len(st.session_state.artists)} artists")

        # Display and filter artists
        if "artists" in st.session_state and st.session_state.artists:
            st.divider()

            # Filters
            col1, col2, col3 = st.columns(3)

            with col1:
                search_username = st.text_input(
                    "🔍 Search Username", placeholder="e.g., deadmau5", help="Filter by artist username (display name)"
                )

            with col2:
                search_permalink = st.text_input(
                    "🔍 Search Permalink",
                    placeholder="e.g., deadmau5",
                    help="Filter by artist permalink (URL identifier)",
                )

            with col3:
                search_location = st.text_input(
                    "🌍 Search Location", placeholder="e.g., Berlin, DE", help="Filter by city or country code"
                )

            col1, col2, col3 = st.columns(3)

            with col1:
                min_followers = st.number_input(
                    "Min Followers", min_value=0, value=0, step=1000, help="Minimum follower count"
                )

            with col2:
                verified_only = st.checkbox("✓ Verified Only", value=False)

            with col3:
                show_selected_only = st.checkbox(
                    "👁️ Show Selected Only", value=False, help="Filter to show only selected artists"
                )

            # Apply filters
            filtered_artists = st.session_state.artists

            if search_username:
                filtered_artists = [a for a in filtered_artists if search_username.lower() in a["username"].lower()]

            if search_permalink:
                filtered_artists = [a for a in filtered_artists if search_permalink.lower() in a["permalink"].lower()]

            if search_location:
                filtered_artists = [
                    a for a in filtered_artists if search_location.lower() in (a["city"] + " " + a["country"]).lower()
                ]

            if min_followers > 0:
                filtered_artists = [a for a in filtered_artists if a["followers"] >= min_followers]

            if verified_only:
                filtered_artists = [a for a in filtered_artists if a["verified"]]

            if show_selected_only:
                filtered_artists = [a for a in filtered_artists if a["permalink"] in st.session_state.selected_artists]

            # Sort options
            st.divider()
            col1, col2 = st.columns([3, 1])

            with col1:
                sort_by = st.selectbox(
                    "Sort by",
                    ["Username (A-Z)", "Username (Z-A)", "Followers (High-Low)", "Followers (Low-High)"],
                    index=0,
                )

            with col2:
                st.metric("Results", len(filtered_artists))

            # Apply sorting
            if sort_by == "Username (A-Z)":
                filtered_artists = sorted(filtered_artists, key=lambda x: x["username"].lower())
            elif sort_by == "Username (Z-A)":
                filtered_artists = sorted(filtered_artists, key=lambda x: x["username"].lower(), reverse=True)
            elif sort_by == "Followers (High-Low)":
                filtered_artists = sorted(filtered_artists, key=lambda x: x["followers"], reverse=True)
            elif sort_by == "Followers (Low-High)":
                filtered_artists = sorted(filtered_artists, key=lambda x: x["followers"])

            # Bulk selection controls
            st.divider()
            col1, col2, col3 = st.columns(3)

            with col1:
                if st.button("✅ Select All Filtered", use_container_width=True):
                    for artist in filtered_artists:
                        st.session_state.selected_artists.add(artist["permalink"])
                    st.rerun()

            with col2:
                if st.button("❌ Deselect All Filtered", use_container_width=True):
                    for artist in filtered_artists:
                        st.session_state.selected_artists.discard(artist["permalink"])
                    st.rerun()

            with col3:
                if st.button("🗑️ Clear All Selections", use_container_width=True):
                    st.session_state.selected_artists.clear()
                    st.rerun()

            # Display artists
            st.divider()
            st.write(f"### Artists ({len(filtered_artists)})")

            # Pagination
            artists_per_page = 50
            total_pages = (len(filtered_artists) + artists_per_page - 1) // artists_per_page

            if "current_page" not in st.session_state:
                st.session_state.current_page = 0

            # Page navigation
            if total_pages > 1:
                col1, col2, col3 = st.columns([1, 2, 1])
                with col1:
                    if st.button("⬅️ Previous", disabled=st.session_state.current_page == 0):
                        st.session_state.current_page -= 1
                        st.rerun()
                with col2:
                    st.write(f"Page {st.session_state.current_page + 1} of {total_pages}")
                with col3:
                    if st.button("Next ➡️", disabled=st.session_state.current_page >= total_pages - 1):
                        st.session_state.current_page += 1
                        st.rerun()

            # Get artists for current page
            start_idx = st.session_state.current_page * artists_per_page
            end_idx = start_idx + artists_per_page
            page_artists = filtered_artists[start_idx:end_idx]

            # Display artists in grid
            for i in range(0, len(page_artists), 2):
                cols = st.columns(2)
                for j, col in enumerate(cols):
                    if i + j < len(page_artists):
                        artist = page_artists[i + j]
                        with col:
                            with st.container(border=True):
                                is_selected = artist["permalink"] in st.session_state.selected_artists

                                # Header with checkbox
                                col_check, col_info = st.columns([1, 10])
                                with col_check:
                                    selected = st.checkbox(
                                        "Select",
                                        value=is_selected,
                                        key=f"artist_{artist['id']}",
                                        label_visibility="collapsed",
                                    )
                                    if selected != is_selected:
                                        if selected:
                                            st.session_state.selected_artists.add(artist["permalink"])
                                        else:
                                            st.session_state.selected_artists.discard(artist["permalink"])
                                        st.rerun()

                                with col_info:
                                    verified_badge = " ✓" if artist["verified"] else ""
                                    st.markdown(
                                        f"**[@{artist['username']}]({artist['permalink_url']})**{verified_badge}"
                                    )
                                    st.caption(f"🔗 `{artist['permalink']}`")

                                # Artist details
                                st.write(f"👤 {artist['full_name']}")
                                st.write(f"👥 {artist['followers']:,} followers")
                                if artist["city"] or artist["country"]:
                                    location = (
                                        f"{artist['city']}, {artist['country']}"
                                        if artist["city"]
                                        else artist["country"]
                                    )
                                    st.write(f"📍 {location}")

            # Reset to page 1 when filters change
            if total_pages > 1:
                st.divider()
                col1, col2, col3 = st.columns([1, 2, 1])
                with col1:
                    if st.button("⬅️ Prev", disabled=st.session_state.current_page == 0, key="bottom_prev"):
                        st.session_state.current_page -= 1
                        st.rerun()
                with col2:
                    st.write(f"Page {st.session_state.current_page + 1} of {total_pages}")
                with col3:
                    next_disabled = st.session_state.current_page >= total_pages - 1
                    if st.button("Next ➡️", disabled=next_disabled, key="bottom_next"):
                        st.session_state.current_page += 1
                        st.rerun()

        # Generate configuration
        if st.session_state.get("selected_artists"):
            st.divider()
            st.subheader("📝 Generated Configuration")

            selected_count = len(st.session_state.selected_artists)
            st.metric("Selected Artists", selected_count)

            # Generate env variable value
            env_value = ",".join(sorted(st.session_state.selected_artists))

            st.code(f'WEEKLY_ARCHIVE_ARTISTS="{env_value}"', language="bash")

            col1, col2 = st.columns(2)
            with col1:
                st.download_button(
                    label="💾 Download as .env snippet",
                    data=f'WEEKLY_ARCHIVE_ARTISTS="{env_value}"\n',
                    file_name="weekly_archive_artists.env",
                    mime="text/plain",
                    use_container_width=True,
                )

            with col2:
                # Copy button (using st.code with copy button)
                if st.button("📋 Show in text area to copy", use_container_width=True):
                    st.text_area("Copy this to your .env file:", f'WEEKLY_ARCHIVE_ARTISTS="{env_value}"', height=100)

    with tab2:
        st.subheader("Manual Artist Configuration")
        st.markdown("""
        Manually enter artist permalinks (comma-separated) if you prefer not to browse.
        This is useful for quickly adding or removing specific artists.
        """)

        manual_input = st.text_area(
            "Artist Permalinks",
            value=(
                ",".join(sorted(st.session_state.selected_artists)) if st.session_state.get("selected_artists") else ""
            ),
            height=150,
            placeholder="deadmau5, skrillex, porter-robinson, ...",
            help="Enter artist permalinks separated by commas",
        )

        if st.button("💾 Update Selection from Manual Input"):
            if manual_input:
                artists = [a.strip() for a in manual_input.split(",") if a.strip()]
                st.session_state.selected_artists = set(artists)
                st.success(f"✅ Updated selection to {len(artists)} artists")
                st.rerun()
            else:
                st.session_state.selected_artists = set()
                st.success("✅ Cleared selection")
                st.rerun()

        st.divider()

        st.markdown("### 💡 Tips")
        st.markdown("""
        - **Permalink format**: Use the artist's SoundCloud permalink (from their URL)
        - **Case insensitive**: The filter is case-insensitive
        - **No spaces**: Replace spaces with hyphens (e.g., `porter-robinson`)
        - **Unique identifier**: Permalinks are more stable than usernames
        - **Example**: For `https://soundcloud.com/deadmau5`, use `deadmau5`
        """)


if __name__ == "__main__":
    main()
