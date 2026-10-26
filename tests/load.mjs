// CPU and responsiveness under a heavy, realistic tab mix: article tabs, endless feeds, tabs that
// flash their title, huge pages and live dashboards, with a page memory of N remembered pages.
// Measures CPU seconds of Chrome's processes over a fixed window and the round-trip time of a
// browser API call (what freezes when Chrome "stops responding").
// usage: node tests/load.mjs [extension dir] [--memory 3000] [--articles 40] [--seconds 60]
import { readdirSync, readFileSync } from 'node:fs';
import { REPO, evalIn, sleep, startChrome, startServer } from './harness.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const extDir = args[0] && !args[0].startsWith('--') ? args[0] : REPO;
const memory = opt('memory', 3000);
const articles = opt('articles', 40);
const seconds = opt('seconds', 60);

/** CPU seconds and resident memory of every process of this Chrome instance. */
function processes(rootPid) {
  const all = {};
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      all[pid] = { ppid: stat[1], cpu: (Number(stat[11]) + Number(stat[12])) / 100, rssMB: (Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096) / 1e6,
        type: cmd.includes('--extension-process') ? 'extension' : (cmd.match(/--type=([a-z-]+)/)?.[1] ?? 'browser') };
    } catch {}
  }
  const mine = {};
  const isMine = (pid) => pid === String(rootPid) || (all[pid] && all[pid].ppid !== '0' && all[pid].ppid !== pid && isMine(all[pid].ppid));
  for (const pid of Object.keys(all)) if (isMine(pid)) mine[pid] = all[pid];
  return mine;
}

const server = await startServer();
const chrome = await startChrome(extDir);

if (memory) {
  // Fill page memory with realistic records (150 words each) straight into IndexedDB.
  await evalIn(chrome.popup, `
    const db = await new Promise((r, j) => { const q = indexedDB.open('tabdeclutter', 1); q.onupgradeneeded = () => { const s = q.result.createObjectStore('pages', { keyPath: 'url' }); s.createIndex('lastVisited', 'lastVisited'); }; q.onsuccess = () => r(q.result); q.onerror = j; });
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const vocab = Array.from({ length: 20000 }, (_, i) => 'w' + i.toString(36) + 'x');
    const pick = () => vocab[Math.floor(Math.pow(rnd(), 2.5) * vocab.length)];
    const tx = db.transaction('pages', 'readwrite'); const store = tx.objectStore('pages');
    for (let i = 0; i < ${memory}; i++) {
      const kw = [...new Set(Array.from({ length: 220 }, pick))].slice(0, 150);
      store.put({ url: 'https://site' + (i % 300) + '.example.com/page/' + i, title: kw.slice(0, 6).join(' '), host: 'site' + (i % 300) + '.example.com', favIconUrl: '',
        description: 'A page about ' + kw.slice(0, 12).join(' '), headings: kw.slice(3, 9).join(' · '), intent: '', keywords: kw, keywordCounts: kw.map((_, r) => Math.max(1, Math.round(40 / (1 + r)))),
        firstSeen: Date.now() - i * 60000, lastVisited: Date.now() - i * 60000 });
    }
    await new Promise((r) => (tx.oncomplete = r));
    return true;`);
}

const urls = [
  ...Array.from({ length: articles }, (_, i) => `https://t${i % 40}.news${i % 7}.com/gen/${i}`),
  ...Array.from({ length: 5 }, (_, i) => `https://feed${i}.social.com/home`),
  ...Array.from({ length: 3 }, (_, i) => `https://mail${i}.webmail.com/inbox`),
  ...Array.from({ length: 2 }, (_, i) => `https://ref${i}.bigdocs.org/manual`),
  ...Array.from({ length: 2 }, (_, i) => `https://trade${i}.dashboard.io/live`),
];
await evalIn(chrome.popup, `for (const url of ${JSON.stringify(urls)}) { await chrome.tabs.create({ url, active: false }); await new Promise((r) => setTimeout(r, 100)); } return true;`);
await sleep(10000); // let the pages load; measure the steady state that follows

const before = processes(chrome.pid);
const latency = await evalIn(chrome.popup, `
  const lat = []; const end = Date.now() + ${seconds * 1000};
  const tabs = (await chrome.tabs.query({})).filter((t) => /^https/.test(t.url));
  let k = 0, nextSwitch = Date.now();
  while (Date.now() < end) {
    // Switch tabs every 3 s like a person would; leaving a tab triggers a re-read.
    if (Date.now() >= nextSwitch) { chrome.tabs.update(tabs[k++ % tabs.length].id, { active: true }); nextSwitch += 3000; }
    const a = performance.now(); await chrome.tabs.query({ active: true }); lat.push(performance.now() - a);
    await new Promise((r) => setTimeout(r, 200));
  }
  lat.sort((a, b) => a - b);
  return { p50: +lat[Math.floor(lat.length * 0.5)].toFixed(1), p95: +lat[Math.floor(lat.length * 0.95)].toFixed(1), max: +lat[lat.length - 1].toFixed(1) };`);
const after = processes(chrome.pid);
await chrome.stop();
server.close();

const cpu = (type) => +Object.entries(after).filter(([, p]) => !type || p.type === type).reduce((a, [pid, p]) => a + p.cpu - (before[pid]?.cpu ?? 0), 0).toFixed(2);
console.log(JSON.stringify({
  extension: extDir, memoryPages: memory, tabs: urls.length, seconds,
  cpuSeconds: { allChrome: cpu(), extension: cpu('extension'), browser: cpu('browser'), pages: cpu('renderer') },
  extensionMemoryMB: +Object.values(after).filter((p) => p.type === 'extension').reduce((a, p) => a + p.rssMB, 0).toFixed(0),
  apiLatencyMs: latency,
}, null, 1));
