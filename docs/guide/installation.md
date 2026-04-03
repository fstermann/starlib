# Installation

Starlib is a native macOS desktop app. Download the latest release and install it like any other application.

## Download

Download the `.dmg` file for your Mac:

[Apple Silicon (M1/M2/M3/M4) :material-apple:](https://github.com/fstermann/starlib/releases/download/v0.2.11/Starlib_0.2.11_aarch64.dmg){ .md-button .md-button--primary }
[Intel :material-apple:](https://github.com/fstermann/starlib/releases/download/v0.2.11/Starlib_0.2.11_x64.dmg){ .md-button }

Or browse [all releases on GitHub](https://github.com/fstermann/starlib/releases).

!!! tip "Not sure which Mac you have?"

    Click the Apple menu () → **About This Mac**. If it says "Apple M1" (or M2, M3, …) download the `aarch64` version. If it says "Intel", download the `x86_64` version.

## Install

1. Open the downloaded `.dmg` file.
2. Drag **Starlib** into your **Applications** folder.
3. Open Terminal and run this command to remove the macOS quarantine flag (required for unsigned builds):

    ```bash
    xattr -cr /Applications/Starlib.app
    ```

4. Launch Starlib from your Applications folder.

!!! warning "First launch"

    macOS may show a warning about an unidentified developer. Right-click the app → **Open** → **Open** to bypass this once.

## Updates

Starlib checks for updates automatically on startup. When a new version is available, a banner appears at the top of the app. Click **Update now** to download and install the update. The app will restart automatically.

You can also check manually via **Settings → Updates → Check for updates**.
