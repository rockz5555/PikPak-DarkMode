<div align="center">

<img src="docs/preview.png" alt="PikPak Dark Mode — theme panel shown in light and dark mode" width="100%">

# PikPak Dark Mode

A drop-in dark theme for the **PikPak desktop app** — theme-aware controls and a one-command installer that backs itself up.

![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6?style=flat-square)
![PowerShell](https://img.shields.io/badge/PowerShell-5.1%2B-5391FE?style=flat-square&logo=powershell&logoColor=white)
![PikPak](https://img.shields.io/badge/PikPak-desktop-ff4d6d?style=flat-square)
![Stars](https://img.shields.io/github/stars/rockz5555/PikPak-DarkMode?style=flat-square&color=8b5cf6)

[Quick start](#quick-start) · [Commands](#command-reference) · [How it works](#how-it-works) · [Troubleshooting](#troubleshooting) · [Support](#support)

</div>

---

## Why you'll like it

| Feature                  | What it does                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------ |
| **Real theme switching** | Light, Dark, and System modes, remembered across launches.                           |
| **Theme-aware panel**    | The switcher, author card, and donation button all adapt to the active theme.        |
| **Themed landing**       | The magnet-link card and folder picker follow the same light/dark theme.             |
| **Themed dialogs**       | Cloud-download progress and completion popups match the active theme too.            |
| **Safe by design**       | Timestamped backups before every change and an idempotent installer you can re-run.  |
| **One-command restore**  | `-Restore` removes the injection and the copied assets, leaving your backups intact. |
| **Zero dependencies**    | Plain PowerShell plus one CSS file and one JS file. No build step, no runtime.       |

## Quick start

1. Clone or download this repository.
2. Open **PowerShell** in the repository folder.
3. Run the installer:

   ```powershell
   .\apply-darkmode.ps1
   ```

4. Reopen PikPak — or let the script do it:

   ```powershell
   .\apply-darkmode.ps1 -Restart
   ```

That's it. Use the round button at the bottom-right of PikPak, or press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd>.

> Running into `running scripts is disabled on this system`? Use the bypass form:
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\apply-darkmode.ps1
> ```

## Command reference

Run these from the folder that contains `apply-darkmode.ps1`.

| What you want                       | Command                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| Install or update the theme         | `.\apply-darkmode.ps1`                                          |
| Install and relaunch PikPak         | `.\apply-darkmode.ps1 -Restart`                                 |
| Check the current status            | `.\apply-darkmode.ps1 -Status`                                  |
| Target a custom install folder      | `.\apply-darkmode.ps1 -InstallDir "D:\Apps\PikPak"`             |
| Target a custom folder and relaunch | `.\apply-darkmode.ps1 -InstallDir "D:\Apps\PikPak" -Restart`    |
| Remove the theme                    | `.\apply-darkmode.ps1 -Restore`                                 |
| Remove and relaunch PikPak          | `.\apply-darkmode.ps1 -Restore -Restart`                        |
| Skip self-elevation                 | `.\apply-darkmode.ps1 -NoElevate`                               |
| Bypass the execution policy         | `powershell -ExecutionPolicy Bypass -File .\apply-darkmode.ps1` |

### Parameters

| Parameter            | Type   | Description                                                                                                                                                 |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-InstallDir <path>` | String | Folder that contains `PikPak.exe`. Auto-detected from the registry and common install paths when omitted. Works with `-Status`, `-Restore`, and `-Restart`. |
| `-Status`            | Switch | Prints the detected install folder, app version, UI file, whether the theme is applied, and the backup folder. Changes nothing.                             |
| `-Restart`           | Switch | Force-closes and relaunches PikPak after applying or restoring.                                                                                             |
| `-Restore`           | Switch | Removes the injected block and the copied theme assets. Backups are preserved.                                                                              |
| `-NoElevate`         | Switch | Internal flag used by the self-elevation relaunch. Skips the UAC relaunch; useful when the current shell is already elevated.                               |

### Status output

```text
PikPak Dark Mode status
  Install folder : C:\Program Files\PikPak
  App version    : 2.15.5
  UI file        : C:\Program Files\PikPak\resources\app\out\main-renderer\index.html
  Theme          : applied
  Backup folder  : C:\Users\you\PikPak-DarkMode\backups
```

### Notes

- Installing into `Program Files` triggers a **UAC prompt**. Cancelling it leaves PikPak untouched.
- Every run is **idempotent**: the old injection is replaced, never duplicated.
- `-Restart` force-closes PikPak, so finish any in-flight transfers first.
- Any flag combination works — for example `.\apply-darkmode.ps1 -Status -InstallDir "D:\Apps\PikPak"`.

## Theme controls

| Control                                           | Action                         |
| ------------------------------------------------- | ------------------------------ |
| Round button (bottom-right)                       | Opens the theme panel          |
| Light / Dark / System                             | Switches the active mode       |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> | Toggles between light and dark |
| <kbd>Esc</kbd>                                    | Closes the panel               |
| <kbd>Esc</kbd> or close button (landing popup)     | Closes the landing window      |

Your choice is stored in `localStorage` under `pikpak-theme` and restored on the next launch. The switcher hides itself on the player and file-manager routes so it never covers fullscreen content, and while a modal dialog is open. PikPak's separate window for external magnet links (`#/landing`) follows the saved mode but uses a compact, card-style layout that matches the main app: an inset artwork hero, a glass magnet pill, a gradient primary action, and a themed "Modify" folder picker that always fits the narrow window. The popup window itself is transparent, so the card floats on a small inset margin instead of painting a full-window black or white backdrop, and the artwork falls back to a soft light gradient in light mode and a deep one in dark mode. That popup never shows the floating switcher; use its own close button or <kbd>Esc</kbd> instead.

## How it works

1. Locates the PikPak install by checking the Windows registry and common folders.
2. Backs up `index.html` into `backups/`, with a matching version note.
3. Copies `theme/pikpak-darkmode.css` and `theme/pikpak-darkmode.js` next to the app's renderer.
4. Injects a small, clearly marked block into the app's `index.html`:

   ```html
   <!-- PIKPAK-DARKMODE:START - managed by apply-darkmode.ps1, do not edit -->
   ...
   <!-- PIKPAK-DARKMODE:END -->
   ```

5. Verifies the change. If verification fails, the backup is restored automatically.

Nothing else is touched. No system settings are changed, and no telemetry, analytics, or account data is collected. The only external request is the optional GitHub avatar image used in the panel.

## After a PikPak update

PikPak updates replace `index.html`, which removes the injection. Re-run the installer after each update:

```powershell
.\apply-darkmode.ps1 -Restart
```

Check `-Status` any time to confirm whether the theme is currently applied.

## Uninstall

```powershell
.\apply-darkmode.ps1 -Restore -Restart
```

This removes the injection and the copied theme assets. Backups in `backups/` are kept; delete that folder manually if you want them gone too.

## Troubleshooting

| Problem                                 | Fix                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Could not find a PikPak installation.` | Pass the folder that contains `PikPak.exe`: `.\apply-darkmode.ps1 -InstallDir "C:\Path\To\PikPak"`. |
| `expected UI file is missing`           | Confirm `resources\app\out\main-renderer\index.html` exists inside the folder you passed.           |
| Theme doesn't appear                    | Restart PikPak. If it still doesn't show, run `.\apply-darkmode.ps1 -Status`.                       |
| Theme disappeared after an app update   | PikPak replaced `index.html`. Re-run the installer.                                                 |
| Script won't run                        | Use `powershell -ExecutionPolicy Bypass -File .\apply-darkmode.ps1`.                                |
| Switcher invisible                      | It hides on player/file-manager and magnet-link (`#/landing`) routes and open dialogs by design, and can sit behind fullscreen video. |
| Magnet-link popup looks light           | The popup follows the saved mode. Switch the mode in the main window (or with Ctrl+Shift+D), then reopen the link. The popup has no floating switcher by design; use its close button or Esc. |
| Avatar is a gradient "N"                | GitHub couldn't be reached; the fallback is intentional and retries on the next launch.             |

## Theme API

The theme exposes a small API on `window.PikPakTheme`:

| Call                                            | Result                            |
| ----------------------------------------------- | --------------------------------- |
| `PikPakTheme.set('dark')`                       | Sets `light`, `dark`, or `system` |
| `PikPakTheme.get()`                             | Returns `{ mode, dark }`          |
| `PikPakTheme.toggle()`                          | Flips between light and dark      |
| `PikPakTheme.light()` / `.dark()` / `.system()` | Shorthand setters                 |
| `PikPakTheme.key`                               | The storage key (`pikpak-theme`)  |

## Project layout

```text
PikPak-DarkMode/
├─ apply-darkmode.ps1      # installer, status, and restore
├─ theme/
│  ├─ pikpak-darkmode.css  # all visual overrides
│  └─ pikpak-darkmode.js   # switcher, persistence, panel
├─ docs/
│  └─ preview.png          # project preview
└─ backups/                # generated: original index.html + version notes
```

## Support

<div align="center">

**Built by Nijoo**

[![GitHub](https://img.shields.io/badge/GitHub-rockz5555-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/rockz5555)
[![Project](https://img.shields.io/badge/Repo-PikPak--DarkMode-4f8bff?style=flat-square&logo=github&logoColor=white)](https://github.com/rockz5555/PikPak-DarkMode)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-0070ba?style=flat-square&logo=paypal&logoColor=white)](https://www.paypal.me/nizwer)

If this theme made your PikPak look better, a star on the repo or a small tip goes a long way.

</div>

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

<div align="center">
<sub>Not affiliated with PikPak or its developers. Use at your own risk.</sub>
</div>
