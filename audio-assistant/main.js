// Nuvio Audio Assistant.
//
// A tiny background app (menu bar on Mac, tray on Windows) that runs the local
// audio helper. When a movie in the Nuvio web player has audio the browser cannot
// play (Dolby AC3/EAC3, DTS, TrueHD), the web player asks this assistant for a
// copy with AAC audio. Everything happens on this computer, nothing is uploaded.

const { app, Tray, Menu, Notification, nativeImage } = require("electron");
const path = require("path");
const audioHelper = require("./audioHelper");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let tray = null;
let running = false;
let startAtLogin = true;

function refreshMenu() {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: running ? "Audio assistant: running" : "Audio assistant: could not start (port 11471 in use?)",
        enabled: false,
      },
      { label: "Fixes silent movies in the Nuvio web player", enabled: false },
      { type: "separator" },
      {
        label: "Start at login",
        type: "checkbox",
        checked: startAtLogin,
        click: (item) => {
          startAtLogin = item.checked;
          app.setLoginItemSettings({ openAtLogin: startAtLogin });
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.setToolTip(running ? "Nuvio Audio Assistant (running)" : "Nuvio Audio Assistant (stopped)");
}

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock && app.dock.hide();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png")).resize({ width: 18, height: 18 }));
  app.setLoginItemSettings({ openAtLogin: true });
  running = await audioHelper.start();
  refreshMenu();
  new Notification({
    title: "Nuvio Audio Assistant",
    body: running ? "Running in the menu bar. Silent movies in the web player will be fixed automatically." : "Could not start. Is another copy already running?",
  }).show();
});

// Keep running in the background when there are no windows.
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  audioHelper.stopAll();
});
