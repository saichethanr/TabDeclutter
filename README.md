# TabDeclutter

A Manifest V3 Chrome extension that fights tab hoarding without sending a single byte off your machine:

- **Topic groups**: tabs about the same subject on different websites (say, a Tokio tutorial, a blog post, and a Stack Overflow question about async Rust) are grouped together as `🔍 Rust async`. Topics are detected locally by comparing word profiles built from each page's title, headings, description, and frequent words.
- **Site groups**: other tabs from the same root domain (`github.com`, `gist.github.com`, …) are grouped by site. Catch-all sites (`google.com`, `youtube.com`, `stackoverflow.com`) get keyword sub-groups such as `YouTube · lofi`, and their remaining tabs share a plain `YouTube` group.
- **Page memory**: what each visited page is about is kept in IndexedDB on your device, so you can find pages by content, even after closing them.
- **Command bar**: describe what you remember ("rust article about pinning", "that piano video", "bread starter recipe"). Results cover open tabs and pages closed earlier, matching titles, URLs, page content, kinds of sites ("video", "spreadsheet", "email"), and typos. Words like PR, pull request, code, or issue rank GitHub tabs higher.
- **Stale tab nudges**: a tab that has spent more than 2 hours in the background is "stale". The toolbar badge shows the count, and a quiet notification is sent at most every 3 hours.
- **Overload detection**: auto groups with more than 7 tabs are flagged.
- **Archive & Safe Close**: writes the tabs' titles and URLs to a local history first, then closes them. Active, pinned, and audible tabs are never closed.

## Install

1. Download `TabDeclutter.zip` from the [latest release](https://github.com/saichethanr/TabDeclutter/releases/latest) and extract it (**Extract All** on Windows).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the extracted folder (the one containing `manifest.json`).
4. Pin TabDeclutter. Open it with the toolbar icon or `Ctrl+Shift+K` (`⌘⇧K` on macOS).

Requires Chrome 102 or later.

## Privacy

Reading page content needs access to all sites, so Chrome shows "Read and change all your data on all websites" at install. The extension only reads; nothing leaves the browser.

- Pages with a password field are never remembered. Incognito tabs are ignored.
- Only a summary is stored per page: title, URL, meta description, headings, and its 150 most frequent words. Full page text is not stored.
- The popup footer has **Pause** (stop remembering new pages) and **Clear** (delete all remembered pages).

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest. |
| `background.js` | Service worker: last-access tracking, page memory indexing, the topic and site grouping engine, badge, and notifications. |
| `popup.html` / `popup.js` | Dashboard, cleanup actions, page memory controls, and the command bar search. |
| `shared.js` | Storage keys, thresholds, text helpers, and the IndexedDB page memory used by both contexts. |
| `styles.css` | All styles; no remote assets, so it works under the strict extension CSP. |

## Behavior notes

- Only tabs that are ungrouped, just navigated, or sit in a topic or general catch-all group are re-evaluated. Tabs move from a site group to a topic group when a cross-site topic appears. A group left with one tab dissolves.
- User-created groups are never modified. A tab you drag out of an auto group stays out until it navigates elsewhere. Renaming or recoloring an auto group is preserved.
- "Archive & Safe Close" on an overloaded group closes its least-recently-used tabs until it is back to 7.
