import logging
import os
import subprocess
from pathlib import Path

import streamlit as st
from streamlit import session_state as sst

logger = logging.getLogger(__name__)


def check_yt_dlp_installed() -> bool:
    """Check if yt-dlp is installed"""
    try:
        result = subprocess.run(["yt-dlp", "--version"], capture_output=True, text=True)
        return result.returncode == 0
    except FileNotFoundError:
        return False


def get_video_info(url: str) -> dict | None:
    """Get video information without downloading"""
    try:
        result = subprocess.run(
            ["yt-dlp", "--dump-json", "--no-warnings", url],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            import json

            return json.loads(result.stdout)
        return None
    except Exception as e:
        logger.error(f"Error getting video info: {e}")
        return None


def download_video(
    url: str, output_path: str, format_option: str = "best", audio_format: str | None = None
) -> tuple[bool, str]:
    """Download video using yt-dlp"""
    try:
        cmd = [
            "yt-dlp",
            # "-f",
            # format_option,
            "-o",
            output_path,
            "--no-warnings",
            "--progress",
            # "--user-agent",
            # "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            # "--extractor-args",
            # "youtube:player-client=web_embedded,web,tv",
        ]

        # Add audio extraction options if needed
        if audio_format:
            cmd.extend(["-x", "--audio-format", audio_format])

        cmd.append(url)

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,  # 10 minute timeout
        )

        if result.returncode == 0:
            return True, "Download completed successfully!"
        else:
            return False, f"Download failed: {result.stderr}"
    except subprocess.TimeoutExpired:
        return False, "Download timed out after 10 minutes"
    except Exception as e:
        return False, f"Error: {str(e)}"


def main():
    st.header(":material/download: YouTube Downloader")
    st.write("Download YouTube videos and audio using yt-dlp")

    # Check if yt-dlp is installed
    if not check_yt_dlp_installed():
        st.error("⚠️ yt-dlp is not installed!")
        st.markdown("""
        **Install yt-dlp:**
        ```bash
        # macOS
        brew install yt-dlp
        
        # Linux/Windows with pip
        pip install yt-dlp
        ```
        """)
        st.stop()

    st.success("✓ yt-dlp is installed")

    # Input section
    with st.container(border=True):
        st.write("#### :material/link: Video URL")
        url = st.text_input(
            "YouTube URL", placeholder="https://www.youtube.com/watch?v=...", label_visibility="collapsed"
        )

        col1, col2 = st.columns(2)
        with col1:
            format_choice = st.selectbox(
                "Format",
                options=[
                    ("Best Quality", "best"),
                    ("Best Audio (MP3)", "bestaudio"),
                    ("Best Audio (WAV)", "bestaudio"),
                ],
                format_func=lambda x: x[0],
            )

        with col2:
            output_dir = st.text_input(
                "Output Directory",
                value=str(Path.home() / "Downloads"),
            )

        if st.button("🔍 Get Video Info", type="secondary", use_container_width=True):
            if url:
                with st.spinner("Fetching video information..."):
                    info = get_video_info(url)
                    if info:
                        sst.video_info = info
                        st.success("✓ Video info retrieved")
                    else:
                        st.error("Failed to get video information")
            else:
                st.warning("Please enter a URL")

    # Video info display
    if sst.get("video_info"):
        info = sst.video_info

        with st.container(border=True):
            st.write("#### :material/info: Video Information")

            col1, col2 = st.columns([1, 2])
            with col1:
                if info.get("thumbnail"):
                    st.image(info["thumbnail"], use_container_width=True)

            with col2:
                st.write(f"**Title:** {info.get('title', 'N/A')}")
                st.write(f"**Channel:** {info.get('uploader', 'N/A')}")
                st.write(f"**Duration:** {info.get('duration', 0) // 60}:{info.get('duration', 0) % 60:02d}")
                st.write(f"**Views:** {info.get('view_count', 0):,}")
                st.write(f"**Upload Date:** {info.get('upload_date', 'N/A')}")

                if info.get("description"):
                    with st.expander("Show description"):
                        st.write(info["description"])

        # Download section
        st.divider()

        if st.button("⬇️ Download", type="primary", use_container_width=True):
            if not url:
                st.error("Please enter a URL")
            else:
                # Create output directory if it doesn't exist
                Path(output_dir).mkdir(parents=True, exist_ok=True)

                # Generate output filename
                safe_title = "".join(
                    c for c in info.get("title", "video") if c.isalnum() or c in (" ", "-", "_")
                ).strip()
                output_template = os.path.join(output_dir, f"{safe_title}.%(ext)s")

                # Determine if we need audio extraction
                audio_format = None
                if format_choice[0] == "Best Audio (WAV)":
                    audio_format = "wav"

                with st.spinner(f"Downloading {info.get('title', 'video')}..."):
                    success, message = download_video(url, output_template, format_choice[1], audio_format)

                    if success:
                        st.success(message)
                        st.balloons()
                        st.info(f"📁 Saved to: {output_dir}")
                    else:
                        st.error(message)


if __name__ == "__main__":
    main()
