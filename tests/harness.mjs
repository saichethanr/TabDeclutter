// Test harness: a local HTTPS server that plays every test website, and a headless Chrome with the
// extension loaded. All hostnames resolve to the local server, so tests never touch the network.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { genPage, pages, renderPage } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = join(here, 'out');
export const REPO = join(here, '..');
const SERVER_PORT = 8443;
const DEBUG_PORT = 9333;

/** Chrome for Testing (or Chromium): branded Chrome no longer accepts --load-extension. */
function chromeBinary() {
  if (process.env.CHROME) return process.env.CHROME;
  const browsers = join(process.env.HOME ?? '', '.agent-browser', 'browsers');
  if (existsSync(browsers)) {
    for (const dir of readdirSync(browsers).sort().reverse()) {
      if (existsSync(join(browsers, dir, 'chrome'))) return join(browsers, dir, 'chrome');
    }
  }
  return 'chromium';
}

export function startServer() {
  mkdirSync(OUT, { recursive: true });
  const key = join(OUT, 'key.pem');
  const cert = join(OUT, 'cert.pem');
  if (!existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=tabdeclutter-test'], { stdio: 'ignore' });
  }
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const host = (req.headers.host ?? '').split(':')[0];
    const query = url.searchParams.get('q') ?? url.searchParams.get('k') ?? url.searchParams.get('search_query') ?? '';
    const spec = pages[host + url.pathname] ?? (url.pathname.startsWith('/gen/') ? genPage(url.pathname) : null);
    const body = spec ? renderPage(spec, query) : '<title>blank</title>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(SERVER_PORT, '127.0.0.1', () => resolve(server)));
}

let current = null;
process.on('exit', () => current?.kill('SIGKILL'));

/** Starts a fresh Chrome profile with `extDir` loaded; resolves with { id, popup, stop }. */
export async function startChrome(extDir) {
  // A Chrome left over from a crashed run would answer on the same port: close it first.
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(1500);
  } catch {}
  const profile = join(OUT, 'profile');
  rmSync(profile, { recursive: true, force: true });
  const chrome = spawn(chromeBinary(), [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--load-extension=${extDir}`, `--host-resolver-rules=MAP * 127.0.0.1:${SERVER_PORT}`,
    '--ignore-certificate-errors', '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });
  current = chrome; // killed on exit too, when a test throws
  let id = null;
  for (let i = 0; i < 60 && !id; i++) {
    await sleep(250);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const ext = targets.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\/\w+\/(background|sw)\.js/.test(t.url) && !/glbjnf|nkeim/.test(t.url));
      id = ext?.url.split('/')[2];
    } catch {}
  }
  if (!id) throw new Error('Chrome or the extension did not start');
  // The popup page, opened as a tab, is where tests call chrome.* APIs.
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?chrome-extension://${id}/popup.html`, { method: 'PUT' });
  await sleep(800);
  const stop = async () => {
    chrome.kill('SIGTERM');
    await new Promise((r) => chrome.once('exit', r));
  };
  return { id, popup: `${id}/popup.html`, worker: `${id}/background.js`, pid: chrome.pid, stop };
}

/** Evaluates an async function body in the first DevTools target whose URL contains `match`. */
export async function evalIn(match, body) {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = targets.find((t) => t.url.includes(match));
  if (!target) throw new Error(`no DevTools target matching ${match}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', j);
  });
  const res = await new Promise((r) => {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) r(m);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (res.error || res.result?.exceptionDetails) throw new Error(JSON.stringify(res.error ?? res.result.exceptionDetails).slice(0, 600));
  return res.result.result.value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
