// Nuvio Call Overlay.
//
// Sits in the menu bar / system tray, watches the nuvio-call Worker, and when a
// watch-party call starts it opens a small always-on-top window (above
// full-screen apps too) that shows the call. The call itself is the Worker's
// /watch page in call-only mode, so it talks to the same SFU and rooms as the
// phone app and the recorder keeps working.

const { app, BrowserWindow, Tray, Menu, ipcMain, session, screen, Notification, nativeImage, systemPreferences } = require("electron");
const fs = require("fs");
const audioHelper = require("./audioHelper");
const path = require("path");

const DEFAULT_URL = "https://nuvio-call.ameennsh0.workers.dev";
const POLL_MS = 8000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let tray = null;
let setupWin = null;
let callWin = null;
let currentRoom = null;
let dismissed = new Map(); // room -> startedAt that the user closed
let seenLive = new Map(); // room -> startedAt currently live
let lastError = "";
let helperOk = false;
let config = { name: "", workerUrl: DEFAULT_URL, password: "", autoJoin: false };

const configPath = () => path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
  } catch (_) {
    // first run
  }
  config.workerUrl = (config.workerUrl || DEFAULT_URL).replace(/\/+$/, "");
}

function saveConfig(next) {
  config = { ...config, ...next };
  config.workerUrl = (config.workerUrl || DEFAULT_URL).replace(/\/+$/, "");
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

async function fetchLive() {
  const res = await fetch(`${config.workerUrl}/admin/api/state`, {
    headers: { cookie: `dash=${encodeURIComponent(config.password)}` },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) throw new Error("Wrong dashboard password");
  if (!res.ok) throw new Error(`Server answered ${res.status}`);
  const body = await res.json();
  return (body.live || []).filter((r) => r.count > 0);
}

function placeWindow(win) {
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = win.getSize();
  win.setPosition(workArea.x + workArea.width - w - 16, workArea.y + workArea.height - h - 16);
}

function openCall(room, { focus = true } = {}) {
  if (callWin && !callWin.isDestroyed()) {
    callWin.close();
  }
  currentRoom = room;
  callWin = new BrowserWindow({
    width: 380,
    height: 540,
    minWidth: 300,
    minHeight: 360,
    show: false,
    title: `Nuvio call - ${room}`,
    backgroundColor: "#0b0b0f",
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  // Stay above full-screen apps and on every desktop/space.
  callWin.setAlwaysOnTop(true, "screen-saver");
  callWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  placeWindow(callWin);
  const q = new URLSearchParams({ room, name: config.name || "Guest", callonly: "1" });
  if (config.autoJoin) q.set("autojoin", "1");
  callWin.loadURL(`${config.workerUrl}/watch?${q}`);
  callWin.once("ready-to-show", () => (focus ? callWin.show() : callWin.showInactive()));
  callWin.on("closed", () => {
    // Remember that the user closed this particular call so it does not pop up again.
    if (currentRoom && seenLive.has(currentRoom)) dismissed.set(currentRoom, seenLive.get(currentRoom));
    currentRoom = null;
    callWin = null;
    refreshMenu();
  });
  refreshMenu();
}

async function poll() {
  if (!config.password) return;
  try {
    const live = await fetchLive();
    lastError = "";
    const now = new Map(live.map((r) => [r.room, r.startedAt]));
    // A room that ended: close its window and allow the next call to pop up again.
    for (const room of seenLive.keys()) {
      if (!now.has(room)) {
        dismissed.delete(room);
        if (currentRoom === room && callWin && !callWin.isDestroyed()) callWin.close();
      }
    }
    seenLive = now;
    for (const [room, startedAt] of now) {
      if (currentRoom === room) continue;
      if (dismissed.get(room) === startedAt) continue;
      if (callWin && !callWin.isDestroyed()) continue; // already showing another call
      new Notification({ title: "Watch-party call started", body: `Room ${room}` }).show();
      openCall(room, { focus: false });
    }
  } catch (e) {
    lastError = String(e.message || e);
  }
  refreshMenu();
}

function refreshMenu() {
  if (!tray) return;
  const live = [...seenLive.keys()];
  const items = [];
  if (!config.password) {
    items.push({ label: "Set up the overlay...", click: showSetup });
  } else if (lastError) {
    items.push({ label: `Problem: ${lastError}`, enabled: false });
  } else if (live.length === 0) {
    items.push({ label: "No call right now", enabled: false });
  } else {
    for (const room of live) {
      items.push({
        label: `Join call: ${room}`,
        click: () => {
          dismissed.delete(room);
          openCall(room);
        },
      });
    }
  }
  items.push(
    { type: "separator" },
    { label: helperOk ? "Audio helper: running (fixes silent movies)" : "Audio helper: not running", enabled: false },
    {
      label: "Start at login",
      type: "checkbox",
      checked: config.startAtLogin !== false,
      click: (item) => {
        saveConfig({ startAtLogin: item.checked });
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    {
      label: "Join automatically",
      type: "checkbox",
      checked: !!config.autoJoin,
      click: (item) => saveConfig({ autoJoin: item.checked }),
    },
    { label: "Settings...", click: showSetup },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(live.length ? `Nuvio call live: ${live.join(", ")}` : "Nuvio Call Overlay");
}

function showSetup() {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.focus();
    return;
  }
  setupWin = new BrowserWindow({
    width: 420,
    height: 470,
    resizable: false,
    title: "Nuvio Call Overlay",
    backgroundColor: "#15151c",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname, "setup.html"));
  setupWin.on("closed", () => (setupWin = null));
}

app.whenReady().then(async () => {
  loadConfig();
  if (process.platform === "darwin") {
    app.dock && app.dock.hide();
    // Ask once so the call window can use the microphone and camera.
    systemPreferences.askForMediaAccess("microphone").catch(() => {});
    systemPreferences.askForMediaAccess("camera").catch(() => {});
  }
  // The call page may use the microphone and camera.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(["media", "audioCapture", "videoCapture"].includes(permission)));

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png")).resize({ width: 18, height: 18 }));
  ipcMain.handle("get-config", () => config);
  ipcMain.handle("save-config", async (_e, next) => {
    const merged = { ...config, ...next, workerUrl: (next.workerUrl || DEFAULT_URL).replace(/\/+$/, "") };
    try {
      const res = await fetch(`${merged.workerUrl}/admin/api/state`, {
        headers: { cookie: `dash=${encodeURIComponent(merged.password)}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 401) return { error: "That dashboard password is wrong." };
      if (!res.ok) return { error: `The server answered ${res.status}.` };
    } catch (e) {
      return { error: "Could not reach the call server." };
    }
    saveConfig(merged);
    lastError = "";
    poll();
    return { ok: true };
  });
  audioHelper.start().then((ok) => {
    helperOk = ok;
    refreshMenu();
  });
  // Start at login so the helper and the pop-up are always there.
  if (config.startAtLogin === undefined) saveConfig({ startAtLogin: true });
  app.setLoginItemSettings({ openAtLogin: config.startAtLogin !== false });
  refreshMenu();
  if (!config.password || !config.name) showSetup();
  poll();
  setInterval(poll, POLL_MS);
});

// Keep running in the tray when every window is closed.
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  audioHelper.stopAll();
});
app.on("second-instance", showSetup);
