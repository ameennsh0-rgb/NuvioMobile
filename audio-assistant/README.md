# Nuvio Audio Assistant

Background app (menu bar / tray). Some movies use audio the browser cannot play
(Dolby AC3/EAC3, DTS, TrueHD). The Nuvio web player detects the silence and asks
this assistant, on `127.0.0.1:11471`, for a copy where the video is untouched and
the audio is converted to AAC. It bundles its own ffmpeg; nothing leaves your computer.

Use Chrome, Edge or Firefox (Safari blocks the web player from calling it).
On Apple Silicon the bundled ffmpeg runs through Rosetta.
