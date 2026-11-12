# Nuvio Call Overlay

A tiny menu-bar (Mac) / tray (Windows) app. When a watch-party call starts, a
small always-on-top window with the call pops up, above full-screen apps too.

- It polls the call Worker's dashboard state (needs the dashboard password once).
- The call window is the Worker's `/watch?callonly=1` page, so it uses the same
  SFU and rooms as the phone app, and the recorder keeps recording as usual.
- Tray menu: join a live call, "Join automatically", Settings, Quit.
- Closing the window for a call means it will not pop up again for that call.

Install: download the DMG (Mac) or setup .exe (Windows) from this repo's
Releases (pre-releases named "Nuvio Call Overlay N"). Unsigned: on a Mac
right-click the app > Open the first time; allow microphone/camera.

## Built-in audio helper

The app also runs the Nuvio audio helper (127.0.0.1:11471) with its own bundled
ffmpeg. When a movie in the Nuvio web player has audio the browser cannot play
(Dolby AC3/EAC3, DTS, TrueHD), the web player asks the helper for a version with
AAC audio. No Terminal, brew or Node needed. On Apple Silicon Macs the bundled
ffmpeg runs through Rosetta (macOS offers to install it when needed).
The app starts at login (switch in the tray menu).
