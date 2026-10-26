// Grouping accuracy: opens each scenario's tabs in a fresh browser and checks the groups against
// what a person would expect. Also counts "moves": times a tab changed group after it was first
// grouped (fewer is calmer).
// usage: node tests/accuracy.mjs [extension dir] [scenario name filter...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, REPO, evalIn, sleep, startChrome, startServer } from './harness.mjs';
import { localFiles, scenarios } from './scenarios.mjs';

const args = process.argv.slice(2);
const extDir = args[0] && !args[0].startsWith('S') ? args.shift() : REPO;
const filters = args;

mkdirSync(join(OUT, 'files'), { recursive: true });
for (const [name, html] of Object.entries(localFiles)) writeFileSync(join(OUT, 'files', name), html);
const fileUrl = (url) => url.replace('file://FILES/', `file://${OUT}/files/`);

const server = await startServer();
let passed = 0;
let total = 0;
let moves = 0;
for (const [name, scn] of Object.entries(scenarios)) {
  if (filters.length && !filters.some((f) => name.includes(f))) continue;
  const chrome = await startChrome(extDir);
  const tabs = Object.fromEntries(Object.entries(scn.tabs).map(([n, u]) => [n, fileUrl(u)]));
  const result = await evalIn(chrome.popup, `
    const tabs = ${JSON.stringify(tabs)};
    const openers = ${JSON.stringify(scn.openers ?? {})};
    const ids = {};
    // Openers first, so the tabs opened from them can name them.
    const order = Object.keys(tabs).sort((a, b) => (openers[a] ? 1 : 0) - (openers[b] ? 1 : 0));
    for (const n of order) {
      const opener = openers[n] ? ids[openers[n]] : undefined;
      ids[n] = (await chrome.tabs.create({ url: tabs[n], active: false, ...(opener ? { openerTabId: opener } : {}) })).id;
      if (opener) await new Promise((r) => setTimeout(r, 300));
    }
    const history = {};
    const end = Date.now() + ${scn.wait ?? 25000};
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1000));
      for (const [n, id] of Object.entries(ids)) {
        const t = await chrome.tabs.get(id).catch(() => null);
        if (!t) continue;
        const h = (history[n] ??= []);
        if (h[h.length - 1] !== t.groupId) h.push(t.groupId);
      }
    }
    const titles = Object.fromEntries((await chrome.tabGroups.query({})).map((g) => [g.id, g.title]));
    const out = {};
    for (const [n, id] of Object.entries(ids)) {
      const t = await chrome.tabs.get(id).catch(() => null);
      const grouped = (history[n] ?? []).filter((g) => g !== -1);
      out[n] = { gid: t?.groupId ?? -1, group: t && t.groupId !== -1 ? titles[t.groupId] : null, moves: Math.max(0, (history[n] ?? []).slice((history[n] ?? []).indexOf(grouped[0])).length - 1) };
    }
    return out;`);
  await chrome.stop();

  const checks = [];
  for (const [members, label] of scn.together ?? []) {
    const gids = new Set(members.map((m) => result[m].gid));
    const title = result[members[0]].group ?? '';
    const ok = gids.size === 1 && !gids.has(-1) && (!label || title.toLowerCase().includes(label.toLowerCase()));
    checks.push({ ok, text: `together${label ? ` as "${label}"` : ''}: ${members.join(', ')}` });
  }
  // Apart means "not in the same topic group"; sharing a plain site group is fine.
  for (const [a, b] of scn.apart ?? []) {
    const ok = result[a].gid === -1 || result[a].gid !== result[b].gid || !/^\p{Extended_Pictographic}/u.test(result[a].group ?? '');
    checks.push({ ok, text: `apart: ${a} / ${b}` });
  }
  if (scn.noTopics) {
    const topics = [...new Set(Object.values(result).map((r) => r.group).filter((g) => /^\p{Extended_Pictographic}/u.test(g ?? '')))];
    checks.push({ ok: !topics.length, text: `no topic groups${topics.length ? ` (got ${topics.join(', ')})` : ''}` });
  }
  const scnMoves = Object.values(result).reduce((a, r) => a + r.moves, 0);
  const ok = checks.filter((c) => c.ok).length;
  passed += ok;
  total += checks.length;
  moves += scnMoves;
  console.log(`\n## ${name}: ${ok}/${checks.length}   (moves: ${scnMoves})`);
  const groups = {};
  for (const [n, r] of Object.entries(result)) (groups[r.group ?? 'ungrouped'] ??= []).push(n);
  for (const [g, ns] of Object.entries(groups)) console.log(`   [${g}] ${ns.join(' | ')}`);
  for (const c of checks) if (!c.ok) console.log(`   FAIL ${c.text}`);
}
server.close();
console.log(`\nSCORE ${passed}/${total}   moves ${moves}`);
