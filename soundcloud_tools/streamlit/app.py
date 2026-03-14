import logging

import streamlit as st


def main():
    logging.basicConfig(level=logging.INFO)

    st.set_page_config(
        page_title="SoundCloud Tools",
        page_icon=":material/cloud:",
        layout="wide",
        initial_sidebar_state="expanded",
    )

    # # Display authentication status in sidebar
    # with st.sidebar:
    #     st.divider()

    #     # User Info Section
    #     with st.expander("👤 User Info", expanded=True):
    #         try:
    #             client = get_client()
    #             user = asyncio.run(client.get_me())

    #             # Display avatar and basic info
    #             col1, col2 = st.columns([1, 3])
    #             with col1:
    #                 st.image(user.avatar_url, width=60)
    #             with col2:
    #                 st.markdown(f"**{user.username}**")
    #                 if user.verified:
    #                     st.caption("✓ Verified")
    #                 st.caption(f"[View Profile]({user.permalink_url})")

    #             # Additional details
    #             st.caption(f"👥 {user.followers_count:,} followers")
    #             if user.city and user.country_code:
    #                 st.caption(f"📍 {user.city}, {user.country_code}")
    #             elif user.country_code:
    #                 st.caption(f"📍 {user.country_code}")

    #             # Badges
    #             badges = []
    #             if user.badges.pro:
    #                 badges.append("🌟 Pro")
    #             if user.badges.pro_unlimited:
    #                 badges.append("✨ Pro Unlimited")
    #             if user.badges.creator_mid_tier:
    #                 badges.append("🎨 Creator")
    #             if badges:
    #                 st.caption(" • ".join(badges))

    #         except Exception as e:
    #             st.error(f"Error loading user: {str(e)}")

    #     # Authentication Status Section
    #     with st.expander("🔐 Authentication Status", expanded=False):
    #         try:
    #             client = get_client()
    #             auth_status = client.get_auth_status()

    #             # Auth method
    #             if auth_status["auth_method"] == "Auto (Client Credentials)":
    #                 st.success(f"**Method:** {auth_status['auth_method']}")
    #             elif auth_status["auth_method"] == "Manual OAuth Token":
    #                 st.info(f"**Method:** {auth_status['auth_method']}")
    #             else:
    #                 st.error(f"**Method:** {auth_status['auth_method']}")

    #             # Token status
    #             if auth_status["has_access_token"]:
    #                 st.success("✓ Access Token: Active")
    #             else:
    #                 st.error("✗ Access Token: Missing")

    #             # Refresh token
    #             if auth_status["has_refresh_token"]:
    #                 st.success("✓ Refresh Token: Available")

    #             # Expiration
    #             if auth_status["time_until_expiry_seconds"]:
    #                 expiry_time = timedelta(seconds=auth_status["time_until_expiry_seconds"])
    #                 minutes = int(expiry_time.total_seconds() // 60)
    #                 if minutes > 10:
    #                     st.success(f"⏱️ Expires in: {minutes} minutes")
    #                 elif minutes > 0:
    #                     st.warning(f"⏱️ Expires in: {minutes} minutes")
    #                 else:
    #                     st.error("⏱️ Token expired")

    #             # Client ID (masked)
    #             if auth_status["client_id"]:
    #                 st.caption(f"Client ID: `{auth_status['client_id']}`")

    #         except Exception as e:
    #             st.error(f"Auth Error: {str(e)}")

    pg = st.navigation(
        [
            st.Page("tools/auth.py", title="Authentication", icon="🔐"),
            st.Page("tools/meta_editor.py", title="Meta Editor", icon=":material/edit:"),
            st.Page("tools/like_explorer.py", title="Like Explorer", icon=":material/favorite:"),
            st.Page("tools/rekordbox_viewer.py", title="Rekordbox Viewer", icon=":material/queue_music:"),
            st.Page("tools/youtube_downloader.py", title="YouTube Downloader", icon=":material/download:"),
            st.Page("tools/key_shifter.py", title="Key Shifter", icon=":material/database:"),
            st.Page("tools/bpm_shifter.py", title="BPM Shifter", icon=":material/speed:"),
            st.Page("tools/artist_manager.py", title="Artist Manager", icon=":material/group:"),
        ]
    )
    pg.run()


if __name__ == "__main__":
    main()
