# Frosted-AIO

An unofficial Windows control app for **TRYX Panorama AIO coolers** with the curved 2240×1080 pump screen.
It replaces the official KANALI app with a minimal dark interface and talks to the cooler directly. No TRYX
software is needed or included.

> **Not affiliated with TRYX.** TRYX, KANALI and Panorama are trademarks of their owner. This is a
> community project, tested on a **Panorama SE (PASE_1021)**. Other Panorama models use the same USB
> protocol and may work, but are untested. Use at your own risk.

## Features

- **Live dashboard:** CPU and GPU temperature, load, clock and power, with a 60-second graph.
- **Pump screen:**
  - On/off, brightness and the standby animation.
  - Full-screen video, or split screen with a separate image, GIF or video on each side.
  - Uploading converts your files to the cooler's format. Delete files stored on the cooler.
- **Stats overlay:** up to 8 items, including temperatures, usage, clocks, power, RAM, network speed, disk,
  fan %, clock, date and custom text. Choose a layout preset, Roboto or Orbitron font, size and any colour,
  plus CPU/GPU brand badges.
- **Now Playing:** the song Windows' media controls report (Spotify, browsers and more), as a centred line at
  the top or bottom, with play/pause and skip buttons.
- **Fan curve:** drag the points, or set a fixed speed.
- **Profiles:** named setups of screen media, brightness, overlay, Now Playing and fan curve. Each can switch
  on automatically while a chosen game or program runs, and switches back when it closes.
- **Temperature alerts:** a Windows notification, fans at 100% and red overlay text when the CPU or GPU stays
  over your limit.
- **Keyboard shortcuts:** system-wide keys for screen on/off, next profile, night mode, fan boost, brightness,
  play/pause and each profile.
- **Phone remote:** a page for your phone's browser on the home network (scan the QR code, sign in with a
  6-digit PIN) to switch profiles and videos, change brightness, and toggle night mode and fan boost.
- **Night mode:** dim or turn off the screen on a schedule or when the PC is idle.
- **Stats history:** one CSV per day in `Documents\Frosted-AIO\History`, with charts in the app.
- **Runs quietly:** system tray, start at sign-in, no administrator prompt after install, and in-app updates
  from GitHub Releases.

## Install

1. Download `Frosted-AIO-Setup-<version>.exe` from [Releases](https://github.com/Frosty9999/frosted-aio/releases)
   and run it. The installer isn't code-signed, so Windows SmartScreen may warn. Choose **More info**, then
   **Run anyway**.
2. If KANALI is installed, quit it, and turn off its startup in Frosted-AIO's Settings (or uninstall KANALI).
   Only one app can drive the cooler at a time.

**Requirements:**
- Windows 10 or 11, 64-bit.
- **[PawnIO](https://pawnio.eu/)**, the driver LibreHardwareMonitor uses to read CPU temperature, clock and
  power. KANALI installs it. Without it, CPU readings show 0.

## How it works

| Part | What it does |
|---|---|
| `src/cooler.js`, `src/usbio.ps1` | Talks to the cooler over USB through Windows' built-in driver. Each message is `"TRYX"` + a 4-byte little-endian length + a protobuf message. |
| `src/protocol/*.proto` | Message definitions for the cooler's USB protocol. |
| `src/sensors.ps1` | Reads PC sensors with [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor). |
| `src/media.js` | Converts videos, GIFs and images to the cooler's H.264 format with FFmpeg. |
| `src/overlay.js` | Lays out the stats overlay. The same code drives the cooler and the in-app preview. |
| `src/nowplaying.ps1` | Reads Windows' media controls for Now Playing. |
| `src/updater.js` | Checks this repo's latest release and installs it. |
| `src/profiles.js` | Profiles and the running-program check for auto-switching. |
| `src/remote.js`, `src/remote/` | The phone remote's web server and page. It only answers devices on the local network, and needs the PIN. |

Connecting is three requests: `get_device_info`, `get_sys_config`, then `get_device_auth`, which the cooler
answers with `"ok"`. Uploads go `file_transmit_begin`, then 256 KB `file_transmit_data` pieces, then
`file_transmit_end` with a CRC-32C of the whole file.

## Build

Requirements: Node.js 20+ and Windows PowerShell 5.1.

```bash
npm install
```
```bash
npm run vendor
```
```bash
npm run dist
```

- `npm run vendor` downloads FFmpeg 8.1 (BtbN GPL build) and LibreHardwareMonitorLib 0.9.6 into `vendor\`.
- `npm run dist` builds `dist\Frosted-AIO-Setup-<version>.exe`. After editing `build/icon.svg`, run `npm run icon` to regenerate every icon size.
- For development, `npm start` runs the app from source (as administrator, for sensors and the cooler).
- `npm start -- --ui-test` runs the interface without touching the cooler, with sample data and throwaway settings.

## Releasing

1. Bump `version` in `package.json`.
2. Run `npm run dist`.
3. Create a GitHub release tagged `v<version>` with the installer attached. Installed copies offer the
   update in **Settings → Updates**.

## Licence

MIT, see [LICENSE](LICENSE). Bundled components keep their own licences:
- FFmpeg: GPL-3.0
- LibreHardwareMonitor: MPL-2.0
- qrcode-generator: MIT
- Roboto and Orbitron fonts: OFL-1.1
