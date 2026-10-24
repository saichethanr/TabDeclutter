# TabDeclutter

A Manifest V3 Chrome extension that fights tab hoarding without sending a single byte off your machine:

- **Auto-grouping**: tabs from the same root domain (`github.com`, `gist.github.com`, …) are grouped automatically. Catch-all sites (`google.com`, `youtube.com`, `stackoverflow.com`) are split into keyword sub-groups such as `YouTube · lofi` or `Stack Overflow · python`.
- **Stale tab nudges**: a tab that has spent more than 2 hours in the background is "stale". The toolbar badge shows the count, and a quiet notification is sent at most every 3 hours.
- **Overload detection**: auto groups with more than 7 tabs are flagged.
- **Command bar**: type what you remember ("where is my PR for the Mythos vulnerability") and press Enter to jump to the tab. Words like PR, pull request, code, or issue rank GitHub tabs higher.
- **Archive & Safe Close**: writes the tabs' titles and URLs to a local history first, then closes them. Active, pinned, and audible tabs are never closed. Reopen archived tabs from "Recently archived".

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin TabDeclutter. Open it with the toolbar icon or `Ctrl+Shift+K` (`⌘⇧K` on macOS).

Requires Chrome 102 or later.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: permissions `tabs`, `tabGroups`, `storage`, `notifications`. |
| `background.js` | Service worker: last-access tracking, the grouping engine, badge, and notifications. |
| `popup.html` / `popup.js` | Dashboard, cleanup actions, and the command bar search. |
| `shared.js` | Storage keys, thresholds, and helpers used by both contexts. |
| `styles.css` | All styles; no remote assets, so it works under the strict extension CSP. |

## Behavior notes

- State lives in `chrome.storage.local` (`tabAccess`, `autoGroups`, `archive`) because MV3 service workers stop when idle.
- Only tabs that are ungrouped or that just navigated are placed. User-created groups are never modified. A tab you drag out of an auto group stays out until it navigates somewhere else. Renaming or recoloring an auto group is preserved.
- "Archive & Safe Close" on an overloaded group closes its least-recently-used tabs until it is back to 7.
