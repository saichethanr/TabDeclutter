// Injected into pages by TabDeclutter. It tells the extension when the page's content has changed
// and then settled (search results finished loading, more results scrolled in, a chat answer
// finished streaming), so the page is re-read for grouping and search. It never reads or sends the
// page's content itself; the service worker does that, the same way it does on page load.
(() => {
  if (globalThis.__tabDeclutterWatching) return;
  globalThis.__tabDeclutterWatching = true;

  const QUIET_MS = 2000; // the page must stop changing for this long
  const MAX_GAP_MS = 5 * 60 * 1000; // pages that never stop changing (endless feeds) back off to this
  const MIN_CHANGE = 200; // characters; ignores ticking clocks and "2 minutes ago" labels

  const textLength = () => (document.querySelector('main, [role="main"]') ?? document.body)?.textContent.length ?? 0;
  let reportedLength = textLength();
  let lastReport = 0;
  let gap = 10000; // minimum time between requests; doubles after each one
  let timer = 0;

  const settle = () => {
    // A big change, or a page that filled in from almost nothing ("Loading…" → a few results).
    const change = Math.abs(textLength() - reportedLength);
    if (change < MIN_CHANGE && !(change >= 40 && change >= reportedLength / 2)) return;
    const wait = lastReport + gap - Date.now();
    if (wait > 0) {
      timer = setTimeout(settle, wait);
      return;
    }
    reportedLength = textLength();
    if (lastReport) gap = Math.min(gap * 2, MAX_GAP_MS);
    lastReport = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'page-settled' }).catch(() => {});
    } catch {
      observer.disconnect(); // the extension was reloaded or removed
    }
  };

  // Changes right after the user does something (asks the next question, runs a search) are worth
  // reading promptly again; only the fact that they interacted is used, not what they typed.
  const resetGap = () => (gap = 10000);
  // Typing into a field also marks the tab as holding unsaved text, so it is never put to sleep.
  // Only the fact is reported, once per page, not what was typed.
  let typedOn = '';
  const onKey = (event) => {
    resetGap();
    const target = event.target;
    if (typedOn === location.href || !(target?.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target?.tagName ?? ''))) return;
    typedOn = location.href;
    try {
      chrome.runtime.sendMessage({ type: 'typed' }).catch(() => {});
    } catch {}
  };
  addEventListener('keydown', onKey, { capture: true, passive: true });
  addEventListener('pointerdown', resetGap, { capture: true, passive: true });

  // A message the user just sent in an AI chat says what the chat is about before the answer has
  // finished, so it is reported at once. Only sent messages count, never text still being typed.
  const SENT = '[data-message-author-role="user"], [data-testid="user-message"], user-query';
  let sentCount = document.querySelectorAll(SENT).length;
  let lastSentCheck = 0;
  const checkSent = () => {
    lastSentCheck = Date.now();
    const count = document.querySelectorAll(SENT).length;
    if (count <= sentCount) return;
    sentCount = count;
    try {
      chrome.runtime.sendMessage({ type: 'prompt-sent' }).catch(() => {});
    } catch {
      observer.disconnect();
    }
  };

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(settle, QUIET_MS);
    if (Date.now() - lastSentCheck > 1000) checkSent();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
