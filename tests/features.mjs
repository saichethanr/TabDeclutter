// Feature checks: focus mode, sleeping idle groups, sharing a group, prompt-first grouping, a
// blank chat joining the group of the tab it was opened from, and learning from dragged tabs.
// usage: node tests/features.mjs [extension dir]
import { REPO, evalIn, sleep, startChrome, startServer } from './harness.mjs';

const extDir = process.argv[2] ?? REPO;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const server = await startServer();

// ---------------------------------------------------------------- focus mode
{
  const chrome = await startChrome(extDir);
  const r = await evalIn(chrome.popup, `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const open = async (url) => (await chrome.tabs.create({ url, active: false })).id;
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await open('https://blank' + i + '-site.com/page'));
    await sleep(3000);
    const a = await chrome.tabs.group({ tabIds: ids.slice(0, 2) });
    const b = await chrome.tabs.group({ tabIds: ids.slice(2, 4) });
    const c = await chrome.tabs.group({ tabIds: ids.slice(4, 6) });
    await sleep(500);
    const state = async () => Object.fromEntries((await chrome.tabGroups.query({})).map((g) => [g.id === a ? 'A' : g.id === b ? 'B' : g.id === c ? 'C' : g.id, g.collapsed]));
    const out = {};
    for (const g of [a, b, c]) await chrome.tabGroups.update(g, { collapsed: true });
    await sleep(500);
    await chrome.tabGroups.update(b, { collapsed: false });
    await chrome.tabGroups.update(c, { collapsed: false }); // expanding C should collapse B
    await sleep(1500);
    out.afterExpandC = await state();
    await chrome.storage.local.set({ settings: { focusMode: false } });
    await sleep(300);
    await chrome.tabGroups.update(a, { collapsed: false }); // focus mode off: C stays open
    await sleep(1500);
    out.focusOff = await state();
    return out;`);
  await chrome.stop();
  check('focus mode: expanding a group collapses the others', r.afterExpandC.C === false && r.afterExpandC.B === true && r.afterExpandC.A === true, JSON.stringify(r.afterExpandC));
  check('focus mode off: other groups stay open', r.focusOff.A === false && r.focusOff.C === false, JSON.stringify(r.focusOff));
}

// ---------------------------------------------------------------- sleeping idle groups, sharing
{
  const chrome = await startChrome(extDir);
  const r = await evalIn(chrome.popup, `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const open = async (url) => (await chrome.tabs.create({ url, active: false })).id;
    const idle1 = await open('https://idle1-site.com/notes');
    const idle2 = await open('https://idle2-site.com/notes');
    const typed = await open('https://www.google.com/search?q=draft+email+wording');
    const busy1 = await open('https://busy1-site.com/notes');
    const elsewhere = await open('https://elsewhere-site.com/x');
    await sleep(4000);
    const idle = await chrome.tabs.group({ tabIds: [idle1, idle2, typed] });
    await chrome.tabGroups.update(idle, { title: 'Reading list' });
    // The popup tab itself is active; its group must never sleep.
    const self = await chrome.tabs.getCurrent();
    await chrome.tabs.update(self.id, { active: true });
    const busy = await chrome.tabs.group({ tabIds: [busy1, self.id] });
    await sleep(500);
    // Share: stub the clipboard and click the group's Share button in this popup.
    location.reload();
    return { idle, busy, idle1, idle2, typed, busy1, elsewhere };`).catch(() => null);
  await sleep(1500);
  // Type into the search box of the "typed" tab (a person editing something there).
  await evalIn('google.com/search', `const input = document.querySelector('input'); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); return true;`);
  const ids = await evalIn(chrome.popup, `
    const groups = await chrome.tabGroups.query({});
    const tabs = await chrome.tabs.query({});
    const byUrl = (part) => tabs.find((t) => t.url.includes(part))?.id;
    return { idle: groups.find((g) => g.title === 'Reading list').id, idle1: byUrl('idle1'), idle2: byUrl('idle2'), typed: byUrl('google.com'), busy1: byUrl('busy1'), elsewhere: byUrl('elsewhere') };`);
  const share = await evalIn(chrome.popup, `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && !document.querySelector('[data-share]'); i++) await sleep(100);
    let copied = null;
    navigator.clipboard.write = async (items) => { copied = {}; for (const item of items) for (const type of item.types) copied[type] = await (await item.getType(type)).text(); };
    const button = [...document.querySelectorAll('[data-share]')].find((b) => b.closest('li')?.textContent.includes('Reading list'));
    button?.click();
    await sleep(500);
    return { found: Boolean(button), copied, toast: document.getElementById('toast').textContent };`);
  check('share: copies the group as Markdown links', share.copied?.['text/plain']?.includes('Reading list') && /- \[.*\]\(https:\/\/idle1-site\.com\/notes\)/.test(share.copied['text/plain']), share.found ? share.copied?.['text/plain']?.split('\n').slice(0, 3).join(' / ') : 'no Share button');
  check('share: copies clickable links for Slack, email and Docs', /<a href="https:\/\/idle2-site\.com\/notes">/.test(share.copied?.['text/html'] ?? ''), share.toast);

  const slept = await evalIn(chrome.popup, `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await chrome.storage.local.set({ settings: { sleepGroups: true, sleepAfterMinutes: 0.02 } });
    await sleep(2000);
    // Any tab event runs the check; closing a tab keeps the popup tab active.
    const extra = await chrome.tabs.create({ url: 'https://extra-site.com/x', active: false });
    await sleep(500);
    await chrome.tabs.remove(extra.id);
    await sleep(6000);
    const get = async (id) => { const t = await chrome.tabs.query({}).then((ts) => ts.find((x) => x.id === id || x.url.includes(id))); return t; };
    const tabs = await chrome.tabs.query({});
    const find = (part) => tabs.find((t) => t.url.includes(part));
    const groups = Object.fromEntries((await chrome.tabGroups.query({})).map((g) => [g.title || 'busy', g.collapsed]));
    return { idle1: find('idle1').discarded, idle2: find('idle2').discarded, typed: find('google.com').discarded, busy1: find('busy1').discarded, groups };`);
  check('sleep: idle group tabs are unloaded', slept.idle1 && slept.idle2, JSON.stringify(slept));
  check('sleep: idle group is collapsed', slept.groups['Reading list'] === true);
  check('sleep: a tab you typed in is kept awake', slept.typed === false);
  check('sleep: the group with the active tab is kept awake', slept.busy1 === false);
  const woke = await evalIn(chrome.popup, `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Stop sleeping first: with the test's 1-second limit this popup's own group would sleep next.
    await chrome.storage.local.set({ settings: { sleepGroups: false } });
    const tab = (await chrome.tabs.query({})).find((t) => t.url.includes('idle1'));
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(3000);
    const now = (await chrome.tabs.query({})).find((t) => t.url.includes('idle1'));
    return { discarded: now.discarded, status: now.status };`);
  check('sleep: one click brings a tab back', woke.discarded === false && woke.status === 'complete', JSON.stringify(woke));
  await chrome.stop();
}

// ---------------------------------------------------------------- prompt-first and opener inheritance
{
  const chrome = await startChrome(extDir);
  const r = await evalIn(chrome.popup, `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const open = async (url, extra = {}) => (await chrome.tabs.create({ url, active: false, ...extra })).id;
    await open('https://g1-lessons.net/lesson');
    await open('https://g3-lessons.net/lesson');
    await sleep(6000);
    const chat = await open('https://chatgpt.com/c/stream1');
    const start = Date.now();
    let joinedAt = null;
    // The prompt appears 3 s after load; the answer then streams for about 20 s.
    while (Date.now() - start < 26000) {
      await sleep(500);
      const t = await chrome.tabs.get(chat);
      if (t.groupId !== -1 && !joinedAt) joinedAt = Date.now() - start;
    }
    const t = await chrome.tabs.get(chat);
    const prompt = { joinedAfterMs: joinedAt, group: t.groupId === -1 ? null : (await chrome.tabGroups.get(t.groupId)).title };

    const so = await open('https://stackoverflow.com/questions/111/tokio-spawn-borrowed-value-does-not-live-long-enough');
    await open('https://blog-site.org/rust-async-await');
    await sleep(8000);
    const blank = await open('https://chatgpt.com/', { openerTabId: so });
    await sleep(8000);
    const b = await chrome.tabs.get(blank);
    const s = await chrome.tabs.get(so);
    const opener = { sameGroup: b.groupId !== -1 && b.groupId === s.groupId, group: s.groupId === -1 ? null : (await chrome.tabGroups.get(s.groupId)).title };
    return { prompt, opener };`);
  await chrome.stop();
  check('prompt-first: a chat joins its topic before the answer finishes', r.prompt.joinedAfterMs !== null && r.prompt.joinedAfterMs < 15000 && /guitar/i.test(r.prompt.group ?? ''), JSON.stringify(r.prompt));
  check("opener: a blank chat opened from a tab joins that tab's group", r.opener.sameGroup, JSON.stringify(r.opener));
}

// ---------------------------------------------------------------- learning from corrections
{
  const chrome = await startChrome(extDir);
  const r = await evalIn(chrome.popup, `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const open = async (url) => (await chrome.tabs.create({ url, active: false })).id;
    const g2url = 'https://g2-lessons.net/lesson';
    for (const path of ['g1', 'g3']) await open('https://' + path + '-lessons.net/lesson');
    let g2 = await open(g2url);
    const phone = await open('https://tech-site.com/apple-iphone-review');
    await sleep(8000);
    const topic = (await chrome.tabs.get(g2)).groupId;
    const title = topic === -1 ? null : (await chrome.tabGroups.get(topic)).title;
    // The user drags g2 out, later closes it and opens the same page again.
    await chrome.tabs.ungroup(g2);
    await sleep(2000);
    await chrome.tabs.remove(g2);
    await sleep(500);
    g2 = await open(g2url);
    await sleep(8000);
    const reopened = (await chrome.tabs.get(g2)).groupId;
    // The user drags the unrelated phone review into the guitar group; another guitar page then
    // makes the group re-evaluate its members.
    await chrome.tabs.group({ groupId: topic, tabIds: [phone] });
    await sleep(2000);
    const g4 = await open('https://g4-lessons.net/lesson');
    await sleep(8000);
    const hints = Object.values((await chrome.storage.local.get('pairHints')).pairHints ?? {});
    return { title, topic, reopened, phone: (await chrome.tabs.get(phone)).groupId, g4: (await chrome.tabs.get(g4)).groupId,
      apart: hints.filter((h) => !h.together).length, together: hints.filter((h) => h.together).length };`);
  await chrome.stop();
  check('learning: a page dragged out of a topic stays out when opened again', r.topic !== -1 && r.reopened !== r.topic, JSON.stringify(r));
  check('learning: a page dragged into a topic stays in', r.phone === r.topic && r.g4 === r.topic);
}

server.close();
console.log(`\nFEATURES ${results.filter(Boolean).length}/${results.length}`);
