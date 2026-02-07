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

    pg = st.navigation(
        [
            st.Page("tools/meta_editor.py", title="Meta Editor", icon=":material/edit:"),
            st.Page("tools/like_explorer.py", title="Like Explorer", icon=":material/favorite:"),
            st.Page("tools/key_shifter.py", title="Key Shifter", icon=":material/database:"),
            st.Page("tools/bpm_shifter.py", title="BPM Shifter", icon=":material/speed:"),
            st.Page("tools/artist_manager.py", title="Artist Manager", icon=":material/group:"),
        ]
    )
    pg.run()


if __name__ == "__main__":
    main()
