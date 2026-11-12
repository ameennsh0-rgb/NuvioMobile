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
