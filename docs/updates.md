# How the in-app updater works

The theme lives inside PikPak's renderer, which is sandboxed: it can render and
fetch, but it cannot write to `resources\app\out\main-renderer\`. So the updater
is split into two halves that share one contract — a manifest.

```
                check                       diff                      download
  renderer  ──────────▶  GitHub manifest  ──────────▶  changed files only  ────┐
  (sandbox)                                                                     │
                                                                                ▼
                                                                    SHA-256 verified
                                                                                │
                    ┌───────────────────────────────────────────────────────────┘
                    ▼
             local update helper  ──▶  backup ──▶  temp file ──▶ atomic swap ──▶ restart
             (127.0.0.1, token)
```

## 1. The two manifests

| File | Written by | Describes |
| --- | --- | --- |
| `update/manifest.json` | `tools/build-update.ps1` | The latest release: version, changelog, and a SHA-256 + size for every asset. |
| `theme/pikpak-darkmode.version.js` | `tools/build-update.ps1` (installer) and the helper (after an update) | What this machine actually has, loaded with a plain `<script>` tag so the sandbox never needs `file://` fetches. |

Both are generated from the real files by the same script, so they cannot
disagree. `version.js` is a JS assignment rather than JSON because a `file://`
page cannot `fetch()` a sibling JSON file — but it *can* load a script.

```js
window.PIKPAK_DARKMODE_VERSION = {
  "version": "1.0.0",
  "bootstrap": 2,
  "released": "2026-11-04",
  "files": {
    "pikpak-darkmode.css": { "sha256": "…", "size": 51234 },
    "pikpak-darkmode-updater.js": { "sha256": "…", "size": 18744 }
  }
};
```

`bootstrap` is the revision of the injected loader block. When a release needs a
new `<script>` or a new permission, bump `-Bootstrap` and the card tells the
user to re-run the installer once. Assets can still be updated normally.

## 2. Version check

- Source: `https://raw.githubusercontent.com/rockz5555/PikPak-DarkMode/main/update/manifest.json`,
  with jsDelivr as a fallback mirror and `?v=<timestamp>` to defeat the 5-minute
  cache.
- Cadence: once per 6 hours, 5 seconds after launch, so startup is never blocked.
  `localStorage` holds `lastCheck`; a failed check never surfaces as an error
  unless the user asked for it from the panel.
- Comparison: semver-style, pre-release aware (`1.2.0-beta.1 < 1.2.0`). No
  version, no prompt.
- Skipping: `skippedVersion` persists, so that release is never offered again —
  a strictly newer release is.

## 3. The delta

`planUpdate(localFiles, remoteFiles)` walks the released file table once:

- hash equal → skip the file entirely (this is the delta)
- hash missing or different → queue for download
- file exists locally but not in the release → reported as removed

The UI states the saving up front ("2 of 4 files · 38 KB instead of 96 KB"), and
the download loop fetches only queued files, sequentially, streaming each body
so progress is real bytes rather than a timer.

Every file is hashed with `crypto.subtle.digest('SHA-256')` **after** download and
compared with the manifest before anything is staged. A mismatch aborts the
whole update — all-or-nothing.

## 4. Applying safely

The renderer posts the staged bytes to the helper:

```http
POST http://127.0.0.1:48179/apply
{
  "token": "…",                       // injected at install time
  "version": "1.1.0",
  "manifest": { … },                  // release manifest
  "restart": true,
  "files": [ { "name": "pikpak-darkmode.css", "sha256": "…", "data": "<base64>" } ]
}
```

The helper then, in order:

1. **Authorizes** — token must match `agent.json`; CORS preflight allowed.
2. **Whitelists** — names must match `^pikpak-darkmode[a-z0-9.-]*\.(?:css|js)$`
   and cannot escape the theme folder (no separators, no traversal).
3. **Re-verifies** — recomputes SHA-256 server-side; a mismatch returns
   `hash-mismatch` and writes nothing.
4. **Stages** — decodes into `%LOCALAPPDATA%\PikPak-DarkMode\staging\<version>`.
5. **Backs up** — copies the current `pikpak-darkmode*` files to
   `%LOCALAPPDATA%\PikPak-DarkMode\backups\<timestamp>-v<old>`.
6. **Swaps** — writes a `.tmp` file beside the target, then moves it into place,
   so a crash can never leave a half-written stylesheet.
7. **Rewrites** `pikpak-darkmode.version.js` from the new manifest, which keeps
   the next delta honest.
8. **Restarts** PikPak only when the user chose *Apply and restart*.

If the install folder is writable (per-user PikPak installs), this happens
silently. If it is in `Program Files`, the helper stages the files and launches
one elevated child process (`-ApplyStaged`), so the user sees a single UAC
prompt instead of one per update.

## 5. The three choices

| Action | What happens |
| --- | --- |
| **Apply** | Install now, stay in the app. The card turns into "installed" with a *Reload now* button, and after a reload the theme shows a short "Updated to v1.1.0 · 2 files" confirmation. |
| **Apply and restart** | Install, then stop and relaunch `PikPak.exe`; the card shows "Restarting PikPak" and the window closes with the new theme already in place. |
| **Skip this version** | Never prompt for that version again. The panel shows "Skipped v1.1.0" and the status row can clear it with one click. |

`Apply` deliberately does not reload: reloading the renderer mid-transfer would
interrupt PikPak's own UI. The user decides when to reload.

## 6. UX details

- **Entrance** — 336 px glass card, `translateY(14px) scale(.97)` → rest over
  340 ms on a spring-ish curve; a slow gradient halo breathes behind the header.
- **Branded header** — the card titles itself *PikPak Dark Mode* (gradient
  wordmark) and puts the update state plus `v1.0.0 → v1.1.0` chips on the line
  below, so the origin of the prompt is never ambiguous.
- **Delta bar** — a two-tone 4 px bar: full length = release size, filled part =
  bytes we will actually fetch. The saving is stated in words right below.
- **Progress** — a three-step rail (Download → Verify → Install) that lights up
  as stages complete, a gradient bar with a travelling sheen, live bytes,
  transfer rate and ETA from a measured sliding window.
- **Success** — the badge morphs to green and the check mark draws itself
  (`stroke-dashoffset`), then the card fades after a few seconds.
- **Quiet by design** — hides on `#player`, `#file-manager`, `#/landing` and
  while a PikPak modal is open; Escape dismisses it; it never takes focus.
- **Reduced motion** — every animation is disabled by
  `prefers-reduced-motion: reduce`.
- **Ambient affordances** — a pulsing dot on the floating switcher, and a status
  row in the theme panel ("v1.0.0 · Up to date", "v1.1.0 available", "Skipped").

## 7. Failure handling

| Situation | Result |
| --- | --- |
| GitHub unreachable | Silent on auto-check; visible, retryable error on manual check. |
| Mirror 1 slow or blocked | Falls through to jsDelivr automatically. |
| Checksum mismatch | Update aborts before staging; existing theme untouched. |
| Helper not running | Buttons are visibly inert with the exact fix ("re-run `apply-darkmode.ps1`"). |
| UAC declined | `elevation-cancelled`; the card says nothing was changed. |
| Disk write failure | Temp file is discarded; the previous file is never deleted first. |
| User cancels | AbortController stops the stream; partial files are discarded. |

## 8. Releasing a version

```powershell
# 1. edit theme files as usual
# 2. regenerate both manifests from the real bytes
.\tools\build-update.ps1 -Version 1.1.0 -Notes "Themed the transfer list" "Faster first paint"
# 3. commit theme/ and update/ to main
```

Clients pick it up on their next launch (or immediately when they hit *Check for
updates*), download only the changed assets, and install.

## 9. Trying it locally

`tools/update-playground.ps1` does the whole setup in one command:

```powershell
.\tools\update-playground.ps1            # serves http://127.0.0.1:8787/
.\tools\update-playground.ps1 -Version 2.0.0 -Port 8790
```

It copies `theme/` into `.playground/`, appends a visible demo rule to that copy so
the fake release has a genuine one-file delta, writes
`.playground/update/manifest.json` advertising the next minor above the installed
version, starts the update helper if needed, and serves the folder with CORS headers
(a plain static server will not do: the renderer requests from a `file://` origin).
It copies this snippet to the clipboard:

```js
localStorage.setItem('ppdm-update-source', 'http://127.0.0.1:8787/'); PikPakUpdater.check({force:true, interactive:true});
```

The override is a base URL: `<base>update/manifest.json` and `<base>theme/<file>` are
the only paths read, so any static host works as long as it sends CORS headers.

To avoid the console entirely, let the installer record the source:

```powershell
.\apply-darkmode.ps1 -UpdateSource http://127.0.0.1:8787/
```

`PikPakUpdater.reset()` clears the check state, the skip marker and that override.
