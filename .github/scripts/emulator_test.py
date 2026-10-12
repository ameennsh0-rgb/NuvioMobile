#!/usr/bin/env python3
"""
Emulator smoke test for the seek-preview fork ("middle ground": no streaming).

1. Install + launch the APK, step past first-run screens, screenshot each screen.
2. Pre-fill the cloud-thumbnail settings (repo + token from secrets) for every profile slot.
3. Open a movie page by deep link (nuvio://movie/<imdb>) and confirm the app asks the
   cloud job to prepare previews, then wait for the thumbnails to land in the repo.
4. Write screenshots, UI text dumps, logs and summary.txt into ./out.
"""
import json
import os
import re
import subprocess
import time
import urllib.request

# Settings come from a private file written by the workflow (the emulator runner doesn't
# forward step environment variables into the script).
if os.path.exists(".test-env.json"):
    for k, v in json.load(open(".test-env.json")).items():
        if v and not os.environ.get(k):
            os.environ[k] = v

PKG = "com.nuviodebug.com"
OUT = "out"
REPO = os.environ.get("THUMBS_REPO", "").strip()
TOKEN = os.environ.get("THUMBS_TOKEN", "").strip()
# A rotating list of well-known films, so each run usually exercises a fresh cloud job.
TITLES = ["tt0111161", "tt0468569", "tt1375666", "tt0816692", "tt0109830", "tt0137523",
          "tt0120737", "tt0110912", "tt0167260", "tt0133093", "tt0080684", "tt0114369",
          "tt0102926", "tt0120815", "tt0317248", "tt0245429", "tt0482571", "tt0407887"]
TITLE = os.environ.get("TEST_TITLE") or TITLES[int(os.environ.get("GITHUB_RUN_NUMBER", "0")) % len(TITLES)]
SKIP_WORDS = ["Skip", "Not now", "Continue without account", "Continue as guest", "Maybe later",
              "Later", "Get started", "Allow", "Continue", "OK", "Got it", "Done", "Dismiss"]

os.makedirs(OUT, exist_ok=True)
summary = []


def note(line):
    print(line, flush=True)
    summary.append(line)


def adb(*args, timeout=60, binary=False):
    r = subprocess.run(["adb", *args], capture_output=True, timeout=timeout)
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def shot(name):
    with open(f"{OUT}/{name}.png", "wb") as f:
        f.write(adb("exec-out", "screencap", "-p", binary=True))
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    xml = adb("shell", "cat", "/sdcard/ui.xml")
    with open(f"{OUT}/{name}.xml", "w") as f:
        f.write(xml)
    return xml


def nodes(xml):
    """(label, x, y, attrs) for every labelled node in a uiautomator dump."""
    out = []
    for tag in re.findall(r"<node [^>]*>", xml):
        attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', tag))
        label = attrs.get("text") or attrs.get("content-desc") or ""
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", attrs.get("bounds", ""))
        if label and m:
            x1, y1, x2, y2 = map(int, m.groups())
            out.append((label, (x1 + x2) // 2, (y1 + y2) // 2))
    return out


def type_text(value):
    """adb 'input text' with escaping for spaces and shell-special characters."""
    escaped = value.replace("%", "%%").replace(" ", "%s")
    escaped = escaped.replace("'", "'\\''")
    adb("shell", f"input text '{escaped}'")


def texts(xml):
    return " | ".join(dict.fromkeys(label for label, _, _ in nodes(xml)))


def tap(x, y):
    adb("shell", "input", "tap", str(x), str(y))


def get_url(url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}",
                                               "Accept": "application/vnd.github.raw+json",
                                               "User-Agent": "nuvio-emulator-test"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return 0, str(e)


def focused_label(xml):
    for tag in re.findall(r"<node [^>]*>", xml):
        if 'focused="true"' in tag:
            attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', tag))
            return attrs.get("text") or attrs.get("content-desc") or attrs.get("class", "")
    return ""


def hide_keyboard():
    """Closes the on-screen keyboard if (and only if) it is showing."""
    for _ in range(2):
        state = adb("shell", "dumpsys", "input_method")
        if "mInputShown=true" not in state and "isInputViewShown=true" not in state:
            return
        adb("shell", "input", "keyevent", "4")  # BACK closes the keyboard first
        time.sleep(1)


def dump():
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    return adb("shell", "cat", "/sdcard/ui.xml")


def sign_in(xml):
    """Signs in. Never screenshots or dumps text once the password has been typed."""
    email = os.environ.get("NUVIO_EMAIL", "").strip()
    password = os.environ.get("NUVIO_PASSWORD", "")
    if not email or not password:
        note("sign-in screen shown but NUVIO_EMAIL/NUVIO_PASSWORD secrets are not set")
        return False
    field = {l: (x, y) for l, x, y, *_ in nodes(xml)}
    if "Email" not in field or "Password" not in field:
        note("sign-in screen layout not recognised")
        return False

    # Email: tap the field, confirm it has focus, type.
    tap(*field["Email"]); time.sleep(1.5)
    type_text(email)
    hide_keyboard()  # so positions settle
    time.sleep(1.5)

    # Password: find the field again (layout may have moved), confirm focus before typing.
    xml = dump()
    pw = next(((x, y) for l, x, y, *_ in nodes(xml) if l == "Password"), None)
    if not pw:
        note("password field not found; not typing the password")
        return False
    tap(*pw); time.sleep(1.5)
    xml = dump()
    focus = focused_label(xml)
    if "Password" not in focus and "EditText" not in focus:
        note(f"password field didn't take focus (focus on: {focus[:30] if focus != email else 'email field'}); not typing")
        return False
    if focus.strip() == email:
        note("focus is still on the email field; not typing the password")
        return False
    type_text(password)
    hide_keyboard()
    time.sleep(1)
    xml = dump()  # used only to find the button; not saved
    btn = next(((x, y) for l, x, y, *_ in nodes(xml) if l == "Sign In"), None)
    if not btn:
        note("Sign In button not found after typing")
        return False
    tap(*btn)
    note("signed in with the test account; waiting for sync")
    time.sleep(20)
    return True


def get_past_first_run(prefix):
    for step in range(6):
        time.sleep(4)
        xml = shot(f"{prefix}_{step}")
        labels = nodes(xml)
        names = [l for l, _, _ in labels]
        note(f"[{prefix} {step}] screen: {texts(xml)[:400]}")
        if "Welcome Back" in names and "Sign In" in names:
            if sign_in(xml):
                continue
            return xml
        if any("watching" in n.lower() for n in names):
            # Profile picker: the configured profile, else the first tile.
            want = os.environ.get("NUVIO_PROFILE", "").strip().lower()
            profiles = [(l, x, y) for l, x, y in labels
                        if "watching" not in l.lower() and "manage" not in l.lower()]
            pick = next((p for p in profiles if p[0].strip().lower() == want), profiles[0] if profiles else None)
            if pick:
                note(f"  picking profile '{pick[0]}'")
                tap(pick[1], pick[2])
                continue
        hit = next(((l, x, y) for w in SKIP_WORDS for (l, x, y) in labels if l.strip().lower() == w.lower()), None)
        if hit:
            note(f"  tapping '{hit[0]}'")
            tap(hit[1], hit[2])
            continue
        return xml
    return xml


def main():
    apk = next(f for f in os.listdir(".") if f.endswith(".apk"))
    note(f"install: {adb('install', '-r', apk, timeout=300).strip().splitlines()[-1]}")
    adb("logcat", "-c")

    # First launch creates the app's data folders; then pre-fill the cloud settings.
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(15)
    get_past_first_run("01_first_run")
    adb("shell", "am", "force-stop", PKG)

    if REPO and TOKEN:
        entries = "".join(
            f'<string name="cloud_thumbs_repo_{p}">{REPO}</string>'
            f'<string name="cloud_thumbs_token_{p}">{TOKEN}</string>' for p in range(0, 8))
        xml = f"<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map>{entries}</map>"
        p = subprocess.run(["adb", "shell", f"run-as {PKG} sh -c 'mkdir -p shared_prefs && cat > shared_prefs/nuvio_player_settings.xml'"],
                           input=xml.encode(), capture_output=True, timeout=30)
        note(f"cloud settings pre-filled: {'ok' if p.returncode == 0 else p.stderr.decode()[:200]}")
    else:
        note("cloud settings: THUMBS_REPO/THUMBS_TOKEN secrets not set; skipping the cloud check")

    # Relaunch and open the movie page by deep link.
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(12)
    get_past_first_run("02_relaunch")
    key = f"m/{TITLE}"
    status_before, _ = get_url(f"https://api.github.com/repos/{REPO}/contents/thumbs/{key}/meta.json") if TOKEN else (0, "")
    note(f"title {TITLE}: thumbnails already in repo before test: {status_before == 200}")
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", f"nuvio://movie/{TITLE}", PKG)
    opened = time.time()
    time.sleep(10)
    xml = shot("03_movie_page")
    note(f"[movie page] {texts(xml)[:500]}")

    # Did the app ask the cloud job to prepare it?
    dispatched = None
    for _ in range(12):
        log = adb("logcat", "-d", "-s", "SeekPreview:I")
        m = re.search(r"cloud (?:prefetch|dispatch)[^\n]*", log)
        if m:
            dispatched = m.group(0)
            break
        time.sleep(2)
    note(f"app → cloud request: {dispatched or 'none seen'}")

    # Wait for the thumbnails (only meaningful when they weren't there before).
    if TOKEN and status_before != 200:
        landed = None
        for _ in range(36):
            code, body = get_url(f"https://api.github.com/repos/{REPO}/contents/thumbs/{key}/meta.json")
            if code == 200:
                landed = time.time() - opened
                meta = json.loads(body)
                note(f"cloud thumbnails ready {landed:.0f}s after the page opened "
                     f"(partial={meta.get('partial')}, frames={meta.get('frames')}, release={meta.get('release')})")
                break
            time.sleep(5)
        if landed is None:
            code, body = get_url(f"https://api.github.com/repos/{REPO}/contents/{key.replace('/', '_')}.json?ref=progress")
            note(f"cloud thumbnails not ready after 180s; latest progress: {body[:300] if code == 200 else code}")

    shot("04_end")
    with open(f"{OUT}/logcat_seekpreview.txt", "w") as f:
        f.write(adb("logcat", "-d", "-s", "SeekPreview:I"))
    with open(f"{OUT}/logcat_crash.txt", "w") as f:
        f.write(adb("logcat", "-d", "-b", "crash"))
    crashes = open(f"{OUT}/logcat_crash.txt").read()
    note(f"crashes: {'YES — see logcat_crash.txt' if PKG in crashes else 'none'}")
    with open(f"{OUT}/logcat_app.txt", "w") as f:
        pid = adb("shell", "pidof", PKG).strip()
        f.write(adb("logcat", "-d", f"--pid={pid}") if pid else "(app not running)")


try:
    main()
finally:
    text = "\n".join(summary)
    for secret in (TOKEN, os.environ.get("NUVIO_PASSWORD", ""), os.environ.get("NUVIO_EMAIL", "")):
        if secret:
            text = text.replace(secret, "***")
    with open(f"{OUT}/summary.txt", "w") as f:
        f.write(text + "\n")
