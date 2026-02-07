import math

import pandas as pd
import streamlit as st
from mutagen.id3 import ID3, TPUB

from soundcloud_tools.handler.track import TrackHandler
from soundcloud_tools.predict.bpm import BPMPredictor
from soundcloud_tools.streamlit.file_selection import file_selector
from soundcloud_tools.utils import load_tracks


def shifted_key(camelot_key: str, orig_bpm: float, target_bpm: float) -> str:
    """
    Calculate the new Camelot key of a track when its tempo is changed
    by resampling (so pitch follows tempo).

    Parameters
    ----------
    camelot_key : str
        Original Camelot key, e.g. "4A" or "9B"
    orig_bpm : float
        Original BPM
    target_bpm : float
        Target BPM

    Returns
    -------
    str
        New Camelot key after pitch shift
    """
    camelot_key = camelot_key.strip().upper()
    if len(camelot_key) < 2:
        raise ValueError("Camelot key must look like '4A' or '9B'")

    try:
        orig_num = int(camelot_key[:-1])
        letter = camelot_key[-1]
    except ValueError as e:
        raise ValueError("Invalid Camelot format") from e

    if letter not in ("A", "B"):
        raise ValueError("Camelot letter must be 'A' or 'B'")

    # Compute semitone shift
    ratio = target_bpm / orig_bpm
    semitones = 12 * math.log2(ratio)
    semitones_rounded = round(semitones)

    # Convert semitone shift → Camelot step
    step_change = (semitones_rounded * 7) % 12

    new_num = (orig_num + step_change - 1) % 12 + 1

    return f"{new_num}{letter}"


def analyze_collection_bpm(files: list, root_folder, progress_bar, status_text):
    """Analyze BPM for all tracks in the collection."""
    predictor = BPMPredictor()
    results = []

    for i, file in enumerate(files):
        try:
            handler = TrackHandler(root_folder=root_folder, file=file)
            track_info = handler.track_info

            # Predict BPM
            predicted_bpm = predictor.predict(str(handler.file))

            results.append(
                {
                    "filename": file.name,
                    "title": track_info.title or file.stem,
                    "artist": track_info.artist_str or "Unknown",
                    "original_bpm": predicted_bpm,
                    "file_path": str(file),
                    "handler": handler,
                }
            )

            # Update progress
            progress = (i + 1) / len(files)
            progress_bar.progress(progress)
            status_text.text(f"Analyzing {i + 1}/{len(files)}: {file.name}")

        except Exception as e:
            st.error(f"Error analyzing {file.name}: {e!s}")
            continue

    return results


def write_bpm_to_metadata(track_results: list, target_bpm: float, progress_bar, status_text):
    """Write BPM values to TPUB metadata tag for all tracks."""
    for i, track_data in enumerate(track_results):
        try:
            handler = track_data["handler"]
            file_path = handler.file

            # Load the audio file with mutagen
            audio_file = ID3(str(file_path))

            # Write BPM to TPUB tag
            audio_file.add(TPUB(encoding=3, text=str(int(target_bpm))))
            audio_file.save()

            # Update progress
            progress = (i + 1) / len(track_results)
            progress_bar.progress(progress)
            status_text.text(f"Writing metadata {i + 1}/{len(track_results)}: {track_data['filename']}")

        except Exception as e:
            st.error(f"Error writing metadata for {track_data['filename']}: {e!s}")
            continue


def main():
    st.header(":material/database: Key Shifter")
    st.write(
        "Calculate the new Camelot key of a track when its tempo is changed by resampling (so pitch follows tempo)."
    )
    st.divider()

    # Original key shifter functionality
    st.subheader("Individual Track Key Shifter")
    c1, c2, _ = st.columns((1.3, 1, 1))
    with c1:
        key = st.pills(
            "Original Camelot Key", [f"{i}{mode}" for mode in ("A", "B") for i in range(1, 13)], default="8A"
        )
        bpm = st.number_input("Original BPM", min_value=100, max_value=180, value=128, step=1)
        target_bpm = st.number_input("Target BPM", min_value=100, max_value=180, value=140, step=1)
        key_shifted = shifted_key(key, bpm, target_bpm)
    with c2.container(border=True):
        st.write("Shifted Camelot Key")
        st.code(f"{key_shifted}@{target_bpm}", width="content")

    st.divider()

    # Collection analysis functionality
    st.subheader("Collection BPM Analysis & Labeling")
    st.write("Analyze BPM for all tracks in your collection and add the result as metadata labels.")

    # File selection
    with st.sidebar:
        file, root_folder = file_selector()
        if file is None:
            st.warning("No files present in folder")
            return

    data_folder = file.parent
    files = load_tracks(data_folder)

    if not files:
        st.warning("No audio files found in the selected folder")
        return

    st.write(f"Found {len(files)} audio files in `{data_folder}`")

    # Analysis controls
    col1, col2 = st.columns(2)

    with col1:
        analyze_button = st.button(f"🔍 Analyze BPM for {len(files)} tracks", type="primary")

    with col2:
        target_bpm_for_collection = st.number_input(
            "Target BPM for Collection",
            min_value=100,
            max_value=180,
            value=140,
            step=1,
            help="BPM value to write to TPUB metadata tag",
        )

    # Initialize session state for results
    if "analysis_results" not in st.session_state:
        st.session_state.analysis_results = None

    # Run analysis
    if analyze_button:
        with st.container():
            st.write("### Analyzing Collection...")
            progress_bar = st.progress(0)
            status_text = st.empty()

            # Perform BPM analysis
            results = analyze_collection_bpm(files, root_folder, progress_bar, status_text)
            st.session_state.analysis_results = results

            progress_bar.progress(1.0)
            status_text.text("Analysis complete!")
            st.success(f"Successfully analyzed {len(results)} tracks")

    # Display results if available
    if st.session_state.analysis_results:
        st.write("### Analysis Results")

        # Create dataframe for display
        df_data = []
        for result in st.session_state.analysis_results:
            # Calculate shifted key based on original BPM and target BPM
            try:
                shifted_key_value = shifted_key("8A", result["original_bpm"], target_bpm_for_collection)
            except Exception:
                shifted_key_value = "Error"

            df_data.append(
                {
                    "Track": result["title"],
                    "Artist": result["artist"],
                    "Detected BPM": result["original_bpm"],
                    "Target BPM": target_bpm_for_collection,
                    "Shifted Key (from 8A)": shifted_key_value,
                    "File": result["filename"],
                }
            )

        df = pd.DataFrame(df_data)
        st.dataframe(df, use_container_width=True)

        # Write metadata button
        if st.button(f"📝 Write BPM ({target_bpm_for_collection}) to TPUB metadata for all tracks", type="secondary"):
            with st.container():
                st.write("### Writing Metadata...")
                progress_bar = st.progress(0)
                status_text = st.empty()

                # Write BPM to metadata
                write_bpm_to_metadata(
                    st.session_state.analysis_results, target_bpm_for_collection, progress_bar, status_text
                )

                progress_bar.progress(1.0)
                status_text.text("Metadata writing complete!")
                st.success(f"Successfully wrote BPM metadata to {len(st.session_state.analysis_results)} tracks")

        # Clear results button
        if st.button("🗑️ Clear Results"):
            st.session_state.analysis_results = None
            st.rerun()


if __name__ == "__main__":
    main()
