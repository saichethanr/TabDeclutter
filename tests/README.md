# TabDeclutter tests

End-to-end checks that run the real extension in a headless Chrome against a local test server
that plays every website (chat apps, search engines, shops, booking sites, heavy pages). Nothing
touches the network. These files are not part of the extension zip.

Requirements: Node 22 or newer, `openssl`, and Chrome for Testing or Chromium (branded Chrome no
longer loads unpacked extensions from the command line). Set `CHROME=/path/to/chrome` if it is not
found automatically.

| Command | What it checks |
| --- | --- |
| `node tests/accuracy.mjs` | Grouping in 12 scenarios (late-loading chats, research across sites, homonyms, search engines, unrelated news, single-page apps, big doc sites, Spanish pages, non-web tabs, trip planning, tabs opened from a search, studying). Prints a score and how often tabs moved between groups. Add a name to run one scenario, for example `node tests/accuracy.mjs S10`. |
| `node tests/features.mjs` | Focus mode, sleeping idle groups, sharing a group, prompt-first grouping, a blank chat joining the group of the tab it was opened from, and learning from tabs dragged into or out of a topic. |
| `node tests/load.mjs` | CPU and responsiveness with a heavy tab mix and a full page memory. Options: `--memory 3000 --articles 40 --seconds 60`. |

Each command accepts an extension folder as its first argument (default: this repository), which
makes it easy to compare a change against an older copy.

Scenarios and test pages live in `scenarios.mjs`; each scenario lists its tabs and the groups a
person would expect (`together`, `apart`).
