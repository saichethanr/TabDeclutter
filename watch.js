// Injected into pages by TabDeclutter. It tells the extension when the page's content has changed
// and then settled (search results finished loading, more results scrolled in, a chat answer
// finished streaming), so the page is re-read for grouping and search. It never reads or sends the
// page's content itself; the service worker does that, the same way it does on page load.
(() => {
  if (globalThis.__tabDeclutterWatching) return;
  globalThis.__tabDeclutterWatching = true;

  const QUIET_MS = 2000; // the page must stop changing for this long
  const MIN_GAP_MS = 10000; // at most one re-read request per page in this time
  const MIN_CHANGE = 200; // characters; ignores ticking clocks and "2 minutes ago" labels

  const textLength = () => (document.querySelector('main, [role="main"]') ?? document.body)?.textContent.length ?? 0;
  let reportedLength = textLength();
  let lastReport = 0;
  let timer = 0;

  const settle = () => {
    if (Math.abs(textLength() - reportedLength) < MIN_CHANGE) return;
    const wait = lastReport + MIN_GAP_MS - Date.now();
    if (wait > 0) {
      timer = setTimeout(settle, wait);
      return;
    }
    reportedLength = textLength();
    lastReport = Date.now();
    try {
      chrome.runtime.sendMessage({ type: 'page-settled' }).catch(() => {});
    } catch {
      observer.disconnect(); // the extension was reloaded or removed
    }
  };

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(settle, QUIET_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
