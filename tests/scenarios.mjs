// Test websites and scenarios. Each page spec describes how a fake site behaves: its title, the
// content it shows at first, content that arrives later (chat answers, search results), and scripts
// for heavy pages. `scenarios` lists the tabs to open and the grouping that a person would expect.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function renderPage(spec, query) {
  const later = spec.later || spec.byQuery?.[query] || (spec.search ? '<div>No results</div>' : '');
  const search = spec.search ? `<input type="search" name="q" value="${esc(query)}">` : '';
  const pw = spec.password ? '<form><input name="user"><input type="password" name="pw"></form>' : '';
  let script = '';
  if (later) {
    const retitle = spec.title0 ? `document.title = ${JSON.stringify(spec.title)};` : '';
    script += `<template id="later">${later}</template><script>setTimeout(() => { document.querySelector('main').innerHTML = document.getElementById('later').innerHTML; ${retitle} }, ${spec.delay ?? 0});</script>`;
  }
  if (spec.chunks) {
    script += `<script>const chunks = ${JSON.stringify(spec.chunks)}; setTimeout(() => { let i = 0; const id = setInterval(() => { const d = document.createElement('div'); d.innerHTML = chunks[i++]; document.querySelector('main').append(d); if (i >= chunks.length) clearInterval(id); }, 600); }, ${spec.delay ?? 0});</script>`;
  }
  if (spec.spa) {
    const s = spec.spa;
    script += `<script>setTimeout(() => { history.pushState(null, '', ${JSON.stringify(s.path)}); document.title = ${JSON.stringify(s.title)}; document.querySelector('main').innerHTML = ${JSON.stringify(s.html)}; }, ${s.delay});</script>`;
  }
  if (spec.script) script += `<script>${spec.script}</script>`;
  return `<!doctype html><html><head><title>${esc(spec.title0 || spec.title)}</title><meta name="description" content="${esc(spec.desc ?? '')}"></head>
<body><nav>${esc(spec.nav ?? '')} ${search}</nav><main>${pw}${spec.now ?? ''}</main>${script}</body></html>`;
}

export const pages = {};
export const scenarios = {};

// Each test site gets its own root domain ("reptiles.example.com" would make every site one site).
const own = (hostPath) => hostPath.replace(/^([a-z0-9-]+)\.example\.(com|org|net|es|mx|in)\//, '$1-site.$2/');

function add(scn, name, url, spec) {
  const [scheme, rest] = url.split('://');
  const fixed = `${scheme}://${own(rest)}`;
  if (spec && scheme === 'https') pages[own(rest.split('?')[0])] = spec;
  (scenarios[scn] ??= { tabs: {}, together: [], apart: [] }).tabs[name] = fixed;
}
const page = (hostPath, spec) => (pages[own(hostPath)] = spec);

const chat = (title, turns, delay = 5000) => ({
  title, title0: 'ChatGPT', desc: 'ChatGPT helps you get answers, find inspiration and be more productive. It is free to use and easy to try.',
  nav: 'New chat Search chats Library GPTs Projects', now: '<div>Ask anything</div>', delay,
  later: turns.map(([q, a]) => `<article><h5>You said:</h5><div data-message-author-role="user">${esc(q)}</div><h6>ChatGPT said:</h6><div data-message-author-role="assistant">${a}</div><div>Copy Edit Read aloud Good response Bad response Share</div></article>`).join('') + '<div>ChatGPT can make mistakes. Check important info.</div>',
});
const art = (title, body, desc = '', nav = 'Home News Sport About') => ({ title, desc, nav, now: body });
const serp = (title, byQuery, delay = 2500) => ({ title, desc: '', nav: 'All Images Videos News Maps', now: '', delay, search: true, byQuery });

// ------------------------------------------------------------------ S1: chats and searches that load late
let s = 'S1 late-loading chats & searches';
add(s, 'gpt F chord', 'https://chatgpt.com/c/f1', chat('Learning the F chord', [
  ['I keep failing at the F chord, my strings buzz. How do I fix it?', '<p>The F major barre chord is one of the first big hurdles when you learn guitar, so buzzing is normal.</p><h3>Index finger</h3><p>Roll your index finger onto its bony side so the barre presses all six strings at the first fret, close to the fret wire.</p><h3>Thumb</h3><p>Place your thumb behind the neck and use arm weight rather than squeezing.</p><h3>Practice</h3><p>Play the chord one string at a time to find the buzzing string. Try a mini F chord on four strings first. A high action at the nut makes barre chords harder; a guitar tech can lower it.</p>'],
  ['What about using a capo?', '<p>A capo lets you avoid the F barre chord by playing C shapes higher up the fretboard, but keep practicing barre chords on guitar.</p>']]));
add(s, 'gpt acoustic', 'https://chatgpt.com/c/a1', chat('Best acoustic for beginners', [
  ['I want to buy my first acoustic. Budget is around 300 dollars.', '<p>Around 300 dollars you can get a very playable acoustic guitar.</p><ul><li>Yamaha FG800: solid spruce top, the classic beginner guitar.</li><li>Fender CD-60S: comfortable neck.</li><li>Epiphone DR-100: affordable.</li></ul><p>Playability matters most: low string action and a comfortable neck make chords easier. Light gauge strings are easier to press. Get a tuner, a capo and picks.</p>']]));
add(s, 'gpt goa', 'https://chatgpt.com/c/g1', chat('Weekend trip plan for Goa', [
  ['Plan a 2 day weekend in Goa', '<h3>Day 1: North Goa</h3><p>Calangute and Baga beaches, lunch at a beach shack, sunset at Fort Aguada, evening in Anjuna.</p><h3>Day 2</h3><p>Basilica of Bom Jesus in Old Goa, a spice plantation, then Palolem beach.</p>']]));
add(s, 'gpt python', 'https://chatgpt.com/c/p1', chat('Python list comprehension help', [
  ['How do I filter a list with a list comprehension?', '<p>Use a condition: evens = [n for n in numbers if n % 2 == 0]. Comprehensions are faster and more readable than a for loop with append in Python. The same syntax works for dict comprehensions.</p>']]));
add(s, 'gpt pasta', 'https://chatgpt.com/c/c1', chat('Easy pasta carbonara recipe', [
  ['Give me a quick carbonara recipe', '<p>Spaghetti, eggs, pecorino romano, guanciale, black pepper. Boil the pasta, fry the guanciale, whisk eggs with pecorino, toss off the heat until creamy.</p>']]));
page('shop.example.com/search', { title: 'ShopKart: Online Shopping Site', desc: '', nav: 'Categories Deals Cart Account', now: '<div>Loading results…</div>', delay: 3000, search: true, byQuery: {
  'guitar strings': "<h2>Results</h2><div>D'Addario EXL110 nickel wound electric guitar strings</div><div>Elixir Nanoweb phosphor bronze acoustic guitar strings, light gauge</div><div>Ernie Ball Super Slinky guitar strings 3 pack</div><div>Martin acoustic guitar strings for beginners, easy to press for strumming chords</div>",
  'running shoes': '<h2>Results</h2><div>Nike Revolution 6 road running shoes for men</div><div>ASICS Gel-Contend cushioned running shoes</div><div>Adidas Duramo lightweight running shoes for jogging and marathon training</div>',
  'laptop for students': '<h2>Results</h2><div>Acer Aspire 5 laptop, 16 GB RAM, 512 GB SSD, 15.6 inch display</div><div>Lenovo IdeaPad Slim 3 student laptop with long battery life</div><div>HP 15 laptop, Intel Core i5, lightweight for college</div>' } });
add(s, 'shop strings', 'https://shop.example.com/search?k=guitar+strings');
add(s, 'shop shoes', 'https://shop.example.com/search?k=running+shoes');
page('www.youtube.com/results', { title: 'YouTube', desc: 'Enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on YouTube.', nav: 'Home Shorts Subscriptions', now: '', delay: 3000, search: true, byQuery: {
  'beginner guitar lessons': '<div>Your FIRST guitar lesson: easy chords for beginners</div><div>Learn guitar in 30 days: lesson 1, hold a pick and play your first chord</div><div>5 beginner guitar mistakes: fretting, strumming and practice tips</div>',
  'sourdough shaping': '<div>How to shape sourdough bread, boule and batard</div><div>Sourdough shaping for beginners: surface tension and banneton proofing</div>',
  'photosynthesis explained': '<div>Photosynthesis explained: light reactions and the Calvin cycle</div><div>Chlorophyll and how plants make glucose from sunlight</div>' } });
add(s, 'yt guitar lessons', 'https://www.youtube.com/results?search_query=beginner+guitar+lessons');
const ASK = { title: 'AskBot', desc: 'AskBot answers anything.', nav: 'New question History', now: '<div>Thinking…</div>', delay: 4000 };
add(s, 'askbot tuning', 'https://ai.example.net/ask/1', { ...ASK, chunks: [
  '<p>You asked: how do I tune my guitar by ear?</p>', '<p>Start with the low E string using a reference pitch from a piano or a tuning app.</p>',
  '<p>Use the fifth fret method: press the fifth fret of the low E string and match the open A string.</p>', '<p>Repeat for D and G. For the B string use the fourth fret of the G string.</p>',
  '<p>New guitar strings stretch for a few days, so retune often. Tune up to the note so strings stay stable on the tuning pegs.</p>'] });
add(s, 'askbot beaches', 'https://ai.example.net/ask/2', { ...ASK, chunks: [
  '<p>You asked: which beaches in Goa are quiet?</p>', '<p>South Goa beaches are calmer than the north. Palolem and Agonda suit a relaxed trip.</p>',
  '<p>Butterfly beach near Palolem is reachable by boat. Cola beach has a lagoon.</p>', '<p>Galgibaga is a turtle nesting beach. Avoid Calangute and Baga if you want quiet, those north Goa beaches are crowded.</p>'] });
scenarios[s].together = [[['gpt F chord', 'gpt acoustic', 'shop strings', 'yt guitar lessons', 'askbot tuning'], 'Guitar'], [['gpt goa', 'askbot beaches'], 'Goa']];
scenarios[s].apart = [['shop strings', 'shop shoes'], ['gpt python', 'gpt F chord'], ['gpt pasta', 'gpt goa'], ['gpt python', 'gpt pasta']];

// ------------------------------------------------------------------ S2: research across sites
s = 'S2 cross-site research';
add(s, 'gpt is CC best', 'https://chatgpt.com/c/cc1', chat('Is Claude Code the best coding agent?', [
  ['is claude code the best coding agent?', '<p>Claude Code is an agentic coding tool from Anthropic that runs in your terminal. Compared with Cursor and GitHub Copilot, Claude Code edits files across a repository, runs commands and handles large refactors. Many developers rate Claude Code as one of the best coding agents for big codebases, while Cursor is preferred for inline editing.</p>']], 2500));
add(s, 'pplx who made CC', 'https://www.perplexity.ai/search/who-created-claude-code', { title: 'who created claude code', desc: 'Perplexity is a free AI-powered answer engine.', nav: 'Home Discover Spaces', now: '', delay: 2500,
  later: '<div>Claude Code was created by Anthropic, the AI company behind the Claude models. Anthropic released Claude Code in 2025 as a command line coding agent. Boris Cherny started the Claude Code project inside Anthropic. Claude Code works in the terminal and can edit code, run tests and make commits.</div>' });
add(s, 'blog rust async', 'https://blog.example.org/rust-async-await', art('Understanding async/await in Rust', "<h1>Understanding async/await in Rust</h1><p>An async fn in Rust returns a future. Futures are lazy: nothing happens until an executor polls them. Tokio is the most popular async runtime; it provides the executor, timers and async IO.</p><h2>Pinning</h2><p>Futures that borrow from themselves must be pinned. Pin guarantees the future does not move in memory while it is polled.</p><h2>Spawning tasks</h2><p>Use tokio::spawn to run futures concurrently. Spawned tasks must be 'static and Send, so share state with Arc and Mutex.</p>"));
add(s, 'SO tokio', 'https://stackoverflow.com/questions/111/tokio-spawn-borrowed-value-does-not-live-long-enough', art('rust - tokio::spawn borrowed value does not live long enough - Stack Overflow', "<h1>tokio::spawn borrowed value does not live long enough</h1><p>I call tokio::spawn with an async block that uses a borrowed String and the Rust compiler says the future must be 'static. How do I share data between async tasks in tokio?</p><h2>Answer</h2><p>Spawned futures can outlive the current function, so they cannot borrow. Wrap the data in an Arc, clone the Arc and move it into the async block. If tasks need to mutate it, use tokio::sync::Mutex. Alternatively use a scoped approach with join! when the futures do not need to be spawned.</p>", '', 'Questions Tags Users'));
add(s, 'docs tokio tutorial', 'https://tokio.rs/tokio/tutorial/spawning', art('Spawning | Tokio - An asynchronous Rust runtime', "<h1>Spawning</h1><p>Tokio tasks are asynchronous green threads. They are created by passing an async block to tokio::spawn. The spawn function returns a JoinHandle which the caller may use to interact with the spawned task.</p><h2>'static bound</h2><p>When you spawn a task on the Tokio runtime, its type's lifetime must be 'static. The spawned task must not contain any references to data owned outside the task. Use Arc to share data between tasks.</p><h2>Send bound</h2><p>Tasks spawned by tokio::spawn must implement Send, because the Tokio runtime may move them between threads while they are suspended at an .await.</p>", '', 'Tokio Docs Blog'));
add(s, 'recipe sourdough starter', 'https://recipes.example.com/sourdough-starter', art('How to make a sourdough starter from scratch', '<h1>Sourdough starter from scratch</h1><p>Mix 50 g flour and 50 g water in a jar. Feed the sourdough starter every day by discarding half and adding fresh flour and water. After about a week the starter doubles within hours of feeding and smells pleasantly sour.</p><h2>Baking</h2><p>Use an active starter to bake sourdough bread with a long cold fermentation, stretch and folds, and an open crumb. Keep the starter in the fridge between bakes.</p>', '', 'Recipes Baking Dinner'));
add(s, 'yt sourdough shaping', 'https://www.youtube.com/results?search_query=sourdough+shaping');
add(s, 'castiron decoy', 'https://kitchen.example.net/season-cast-iron', art('How to season a cast iron skillet', '<h1>Seasoning cast iron</h1><p>Wash the skillet, dry it on the stove and rub a thin layer of oil over every surface. Bake it upside down in a hot oven for an hour so the oil polymerizes. Repeat three times for a non-stick surface. Avoid soaking the pan; a seasoned skillet can bake cornbread and sear steak. Remove rust with steel wool before re-seasoning.</p>', '', 'Kitchen Gear Guides'));
add(s, 'GH PR', 'https://github.com/acme/webapp/pull/42', art('Fix login redirect loop by alice · Pull Request #42 · acme/webapp', '<p>This pull request fixes the redirect loop after login when the session cookie expires, and adds tests for the auth middleware.</p><p>Files changed 4 Commits 3 Checks passed</p>', '', 'Code Issues Pull requests Actions'));
add(s, 'GH issue', 'https://github.com/acme/webapp/issues/7', art('Dark mode colors are wrong in settings · Issue #7 · acme/webapp', '<p>The settings page uses the wrong contrast for buttons in dark mode. Steps to reproduce: enable dark mode and open settings.</p>', '', 'Code Issues Pull requests Actions'));
scenarios[s].together = [[['gpt is CC best', 'pplx who made CC'], 'Claude'], [['blog rust async', 'SO tokio', 'docs tokio tutorial'], null], [['recipe sourdough starter', 'yt sourdough shaping'], 'Sourdough'], [['GH PR', 'GH issue'], null]];
scenarios[s].apart = [['castiron decoy', 'recipe sourdough starter'], ['castiron decoy', 'blog rust async'], ['GH PR', 'SO tokio']];

// ------------------------------------------------------------------ S3: same word, different meaning
s = 'S3 homonyms';
add(s, 'python snake facts', 'https://wildlife.example.org/animals/burmese-python', art('Burmese python | Wildlife facts', '<h1>Burmese python</h1><p>The Burmese python is one of the largest snakes in the world. This constrictor lives in the swamps and grasslands of Southeast Asia, eats birds and mammals, and can reach five metres. Females lay eggs and coil around them to keep them warm. Invasive pythons now threaten wildlife in the Florida Everglades.</p>'));
add(s, 'python snake care', 'https://reptiles.example.com/forum/ball-python-care', art('Ball python care sheet for new owners', '<h1>Ball python care</h1><p>Ball pythons need an enclosure with a warm side at 32 C and a cool side at 26 C, humidity around 60 percent, and two hides. Feed your snake a thawed mouse or rat every one to two weeks. Shedding problems usually mean the humidity is too low. These pythons are docile snakes and good reptiles for beginners.</p>'));
add(s, 'python lang docs', 'https://docs.python.org/3/tutorial/datastructures.html', art('5. Data Structures — Python 3 documentation', '<h1>Data Structures</h1><p>This chapter describes lists, tuples, sets and dictionaries in Python. List methods include append, extend, insert, remove, pop and sort. List comprehensions provide a concise way to create lists. Dictionaries map keys to values; loop over items() to get both.</p>', '', 'Python Docs Tutorial Library'));
add(s, 'python lang tutorial', 'https://realpython.example.com/python-dicts', art('Dictionaries in Python – Real Python', '<h1>Dictionaries in Python</h1><p>A Python dictionary stores key value pairs. Create one with curly braces, read values with get, and loop with items(). Dict comprehensions build a dictionary from any iterable. Since Python 3.7 dictionaries keep insertion order.</p>', '', 'Tutorials Courses Quizzes'));
add(s, 'jaguar animal', 'https://wildlife.example.org/animals/jaguar', art('Jaguar | Wildlife facts', '<h1>Jaguar</h1><p>The jaguar is the largest big cat in the Americas. It hunts deer, capybara and caiman in the rainforest of the Amazon and the wetlands of the Pantanal, and it swims well. Jaguars have a powerful bite that pierces turtle shells. Habitat loss is the biggest threat to the species.</p>'));
add(s, 'jaguar animal 2', 'https://natgeo.example.com/animals/mammals/jaguar', art('Jaguar, facts and photos', '<h1>Jaguars</h1><p>Jaguars are solitary cats that roam the rainforest and Pantanal wetlands. Their spotted coat with rosettes is camouflage. A jaguar ambushes prey such as caiman and capybara near rivers. Conservation corridors help jaguars move between forests.</p>'));
add(s, 'jaguar car', 'https://cars.example.com/reviews/jaguar-f-pace', art('2026 Jaguar F-Pace review: price, specs and driving', '<h1>Jaguar F-Pace review</h1><p>The Jaguar F-Pace is a luxury SUV with a 2.0 litre engine and a plug-in hybrid option. It handles well, the interior is comfortable, and the infotainment is improved. Fuel economy is average for the class. Prices start at 58,000 dollars; rivals include the Porsche Macan and BMW X3.</p>', '', 'Reviews New cars Used cars'));
add(s, 'apple iphone', 'https://tech.example.com/apple-iphone-review', art('Apple iPhone 18 review: battery and camera', "<h1>iPhone 18 review</h1><p>Apple's new iPhone has a brighter display, a faster chip and two days of battery life. The camera improves low light photos and video. iOS adds new privacy features. The price starts at 899 dollars.</p>", '', 'Phones Laptops Reviews'));
add(s, 'apple pie', 'https://recipes.example.com/apple-pie', art('Classic apple pie recipe', '<h1>Classic apple pie</h1><p>Slice six apples, toss with sugar, cinnamon and lemon juice, and fill a buttery pie crust. Cover with a lattice crust and bake at 200 C for 50 minutes until golden and bubbling. Serve the pie warm with vanilla ice cream.</p>', '', 'Recipes Baking Dinner'));
scenarios[s].together = [[['python snake facts', 'python snake care'], null], [['python lang docs', 'python lang tutorial'], null], [['jaguar animal', 'jaguar animal 2'], null]];
scenarios[s].apart = [['python snake facts', 'python lang docs'], ['python snake care', 'python lang tutorial'], ['jaguar car', 'jaguar animal'], ['apple iphone', 'apple pie']];

// ------------------------------------------------------------------ S4: search engines
s = 'S4 search engines';
page('www.google.com/search', serp('Google Search', {
  'best guitar amp for beginners': '<div>Best beginner guitar amps 2026: Fender Champion, Boss Katana, Yamaha THR</div><div>Practice amp buying guide for electric guitar: watts, modeling and headphones</div><div>Reddit: what amp should a beginner guitar player buy?</div>',
  'goa beach hotels': '<div>Beach resorts in Goa: Taj Fort Aguada, W Goa Vagator</div><div>Cheap hotels near Palolem beach, South Goa</div><div>Best areas to stay in Goa for beaches and nightlife</div>',
  'python sort list of dicts': '<div>Sort a list of dictionaries by a value in Python: sorted with key lambda</div><div>Python operator itemgetter for sorting dicts</div>',
  'things to do in lisbon': '<div>Top attractions in Lisbon: Belém Tower, Alfama, Tram 28</div><div>Lisbon travel guide: neighbourhoods, food and day trips</div>' }));
page('www.bing.com/search', serp('Bing', { 'guitar amp reviews': '<div>Boss Katana 50 MkII review: the best guitar amp for the money</div><div>Fender Mustang LT25 guitar amp review for beginners</div><div>Top modeling amps compared</div>' }));
page('duckduckgo.com/', serp('DuckDuckGo', { 'cheap flights to goa': '<div>Cheap flights to Goa from Mumbai and Delhi, Dabolim and Mopa airports</div><div>Book Goa flight tickets, beach holiday deals</div>' }));
add(s, 'google guitar amp', 'https://www.google.com/search?q=best+guitar+amp+for+beginners');
add(s, 'bing amp reviews', 'https://www.bing.com/search?q=guitar+amp+reviews');
add(s, 'ddg goa flights', 'https://duckduckgo.com/?q=cheap+flights+to+goa');
add(s, 'google goa hotels', 'https://www.google.com/search?q=goa+beach+hotels');
add(s, 'google python sort', 'https://www.google.com/search?q=python+sort+list+of+dicts');
scenarios[s].together = [[['google guitar amp', 'bing amp reviews'], null], [['ddg goa flights', 'google goa hotels'], 'Goa']];
scenarios[s].apart = [['google python sort', 'google guitar amp'], ['google python sort', 'google goa hotels'], ['google guitar amp', 'google goa hotels']];

// ------------------------------------------------------------------ S5: unrelated pages (no topic should form)
s = 'S5 unrelated news';
const NEWS = [['election', 'Election results: ruling party loses majority', 'Votes were counted overnight and the ruling party lost its parliamentary majority. Coalition talks begin on Monday as the opposition leader claims a mandate for change.'],
  ['football', 'Striker completes record transfer to Madrid', 'The striker signed a five year contract after a record fee was agreed. He scored 31 league goals last season and will wear the number nine shirt.'],
  ['climate', 'Climate summit agrees new emissions targets', 'Delegates agreed to cut emissions faster and fund adaptation in poorer countries. Campaigners said the deal on coal and methane does not go far enough.'],
  ['markets', 'Stock markets fall as interest rates rise', 'Shares fell sharply after the central bank raised interest rates again to fight inflation. Bank and technology stocks led the losses.'],
  ['quake', 'Earthquake of magnitude 6.8 strikes the coast', 'Rescue teams are searching collapsed buildings after the earthquake. Aftershocks continued through the night and a tsunami warning was lifted.'],
  ['film', 'Film review: a slow but beautiful space drama', 'The director returns with a quiet space drama about an astronaut alone on a station. The cinematography is stunning even if the pacing drags.'],
  ['health', 'Study links poor sleep to heart disease', 'Researchers followed 20,000 adults for ten years and found that fewer than six hours of sleep raised the risk of heart disease and stroke.'],
  ['phone', 'Hands on with the new folding phone', 'The folding phone has a larger hinge-free screen and a lighter body. Battery life is better than last year but the price is still high.']];
NEWS.forEach(([k, t, b], i) => {
  const host = i < 5 ? 'news.example.co.uk' : ['daily.example.com', 'times.example.in', 'herald.example.org'][i - 5];
  add(s, `news ${k}`, `https://${host}/article/${k}`, art(`${t} - News`, `<h1>${t}</h1><p>${b}</p><p>Share this article. Related topics. More stories.</p>`, 'The latest news, analysis and opinion.'));
});
scenarios[s].noTopics = true;

// ------------------------------------------------------------------ S6: single-page apps
s = 'S6 SPA navigation';
add(s, 'gpt new chat -> guitar', 'https://chatgpt.com/', { title: 'ChatGPT', desc: 'ChatGPT helps you get answers.', nav: 'New chat Search chats', now: '<div>What can I help with?</div>',
  spa: { delay: 4000, path: '/c/spa-guitar', title: 'Guitar strings for beginners', html: "<div data-message-author-role='user'>which guitar strings should a beginner use on an acoustic guitar?</div><div data-message-author-role='assistant'><p>Light gauge phosphor bronze strings are easiest for beginners on an acoustic guitar. They are gentler on fingertips and make chords easier. Change guitar strings every three months.</p></div>" } });
add(s, 'gpt acoustic', 'https://chatgpt.com/c/a1');
add(s, 'gpt guitar -> goa', 'https://chatgpt.com/c/switch', { ...chat('Guitar practice routine', [['give me a daily guitar practice routine', '<p>Warm up with chromatic exercises on the guitar, practice chord changes between G, C and D, then strum along to a song. Finish with a few minutes of guitar scales.</p>']], 1000),
  spa: { delay: 16000, path: '/c/switch-goa', title: 'Goa trip with friends', html: "<div data-message-author-role='user'>plan a Goa beach trip with friends</div><div data-message-author-role='assistant'><p>Stay in North Goa near Anjuna and Vagator beaches for cafes and nightlife. Rent scooters, visit Chapora fort and spend a day at Palolem beach in South Goa.</p></div>" } });
add(s, 'gpt goa', 'https://chatgpt.com/c/g1');
scenarios[s].together = [[['gpt new chat -> guitar', 'gpt acoustic'], 'Guitar'], [['gpt guitar -> goa', 'gpt goa'], 'Goa']];
scenarios[s].apart = [['gpt guitar -> goa', 'gpt acoustic']];
scenarios[s].wait = 34000;
scenarios[s].final = { 'gpt new chat -> guitar': 'https://chatgpt.com/c/spa-guitar', 'gpt guitar -> goa': 'https://chatgpt.com/c/switch-goa' };

// ------------------------------------------------------------------ S7: one big site plus a small one
s = 'S7 same-site docs';
for (const [k, [t, b]] of Object.entries({
  tutorial: ['An Informal Introduction to Python', 'Numbers, strings and lists in the Python interpreter. Use print to show values and slicing to get substrings.'],
  controlflow: ['More Control Flow Tools', 'if statements, for loops over sequences, range, break and continue, and defining functions with def in Python.'],
  modules: ['Modules', 'A module is a file containing Python definitions. Use import to load modules and packages from the standard library.'],
  errors: ['Errors and Exceptions', 'Syntax errors and exceptions. Handle exceptions with try and except, raise your own, and clean up with finally.'],
  classes: ['Classes', 'Classes bundle data and functionality. Define methods, use __init__, inheritance and private variables in Python.'],
  stdlib: ['Brief Tour of the Standard Library', 'The os, glob, sys, re, math, datetime and json modules in the Python standard library.'] })) {
  add(s, `pydocs ${k}`, `https://docs.python.org/3/tutorial/${k}.html`, art(`${t} — Python 3 documentation`, `<h1>${t}</h1><p>${b}</p>`, 'The official Python documentation.', 'Python Docs Tutorial Library Reference'));
}
add(s, 'mdn grid', 'https://developer.mozilla.org/en-US/docs/Web/CSS/grid', art('grid - CSS | MDN', '<h1>grid</h1><p>The grid CSS shorthand property sets all explicit and implicit grid properties: grid-template-rows, grid-template-columns and grid-auto-flow.</p>', 'Resources for developers, by developers.', 'References Guides Plus'));
add(s, 'mdn promise', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise', art('Promise - JavaScript | MDN', '<h1>Promise</h1><p>A Promise represents the eventual completion or failure of an asynchronous operation in JavaScript. Use then, catch and async await.</p>', 'Resources for developers, by developers.', 'References Guides Plus'));
scenarios[s].together = [[['pydocs tutorial', 'pydocs controlflow', 'pydocs modules', 'pydocs errors', 'pydocs classes', 'pydocs stdlib'], null]];
scenarios[s].apart = [['pydocs classes', 'mdn promise'], ['pydocs modules', 'mdn grid']];

// ------------------------------------------------------------------ S8: Spanish pages
s = 'S8 Spanish pages';
add(s, 'es paella 1', 'https://cocina.example.es/receta-paella-valenciana', art('Receta de paella valenciana tradicional', '<h1>Paella valenciana</h1><p>Para hacer una paella valenciana necesitas arroz bomba, pollo, conejo, judías verdes, garrofón, tomate, azafrán y aceite de oliva. Sofríe la carne en la paellera, añade el tomate y el agua, y cuece el arroz sin remover durante veinte minutos hasta que se forme el socarrat.</p>', '', 'Recetas Postres Contacto'));
add(s, 'es paella 2', 'https://recetas.example.mx/paella-de-mariscos', art('Cómo preparar paella de mariscos', '<h1>Paella de mariscos</h1><p>La paella de mariscos lleva arroz, gambas, mejillones, calamares, azafrán y un buen caldo de pescado. Dora el marisco, retíralo y sofríe el arroz en la paellera antes de añadir el caldo. Coloca el marisco encima los últimos minutos.</p>', '', 'Inicio Recetas Videos'));
add(s, 'es futbol 1', 'https://deportes.example.es/real-madrid-gana-el-clasico', art('El Real Madrid gana el clásico ante el Barcelona', '<h1>El Real Madrid gana el clásico</h1><p>El Real Madrid venció 2-1 al Barcelona en el Bernabéu con un gol de Mbappé en el minuto 88. El entrenador elogió la defensa y el equipo es líder de la liga con tres puntos de ventaja.</p>', '', 'Fútbol Baloncesto Tenis'));
add(s, 'es futbol 2', 'https://marcador.example.com/liga/madrid-barcelona-cronica', art('Crónica del Madrid - Barcelona: Mbappé decide el clásico', '<h1>Mbappé decide el clásico</h1><p>Un partido intenso en el Bernabéu: el Barcelona empató tras el descanso, pero Mbappé marcó el gol de la victoria del Real Madrid. La liga queda a favor de los blancos.</p>', '', 'Liga Champions Fichajes'));
add(s, 'es tiempo', 'https://tiempo.example.es/madrid', art('El tiempo en Madrid para los próximos días', '<h1>El tiempo en Madrid</h1><p>Cielos despejados con temperaturas de hasta 31 grados. El fin de semana llegarán tormentas por la tarde y bajarán las temperaturas en la sierra.</p>', '', 'Previsión Mapas Radar'));
scenarios[s].together = [[['es paella 1', 'es paella 2'], 'Paella'], [['es futbol 1', 'es futbol 2'], null]];
scenarios[s].apart = [['es paella 1', 'es futbol 1'], ['es tiempo', 'es futbol 1'], ['es tiempo', 'es paella 2']];

// ------------------------------------------------------------------ S9: non-web tabs
s = 'S9 non-web tabs';
for (const [n, u] of [['file guitar notes', 'file://FILES/guitar-notes.html'], ['file guitar setlist', 'file://FILES/guitar-setlist.html'], ['file taxes', 'file://FILES/taxes.html'], ['file dashboard', 'file://FILES/dashboard.html'],
  ['chrome settings', 'chrome://settings/'], ['chrome history', 'chrome://history/'], ['chrome downloads', 'chrome://downloads/']]) add(s, n, u);
scenarios[s].together = [[['file guitar notes', 'file guitar setlist'], null], [['chrome settings', 'chrome history', 'chrome downloads'], null]];
export const localFiles = {
  'guitar-notes.html': '<!doctype html><title>Guitar chord notes</title><h1>Guitar chord notes</h1><p>G C D Em chords, F barre chord practice, capo on 2.</p>',
  'guitar-setlist.html': '<!doctype html><title>Guitar setlist for Friday gig</title><h1>Setlist</h1><p>Wonderwall (capo 2), Hotel California, Let it be. Guitar chords and strumming notes.</p>',
  'taxes.html': '<!doctype html><title>Tax return 2026 checklist</title><p>Salary slips, rent receipts, insurance premiums.</p>',
  'dashboard.html': '<!doctype html><title>Sales dashboard</title><h1>Dashboard</h1><p>Revenue, orders and churn this quarter.</p>',
};

// ------------------------------------------------------------------ S10: trip planning across booking sites
s = 'S10 trip planning';
add(s, 'flights lisbon', 'https://www.skyscanner.net/transport/flights/bom/lis/', art('Cheap flights from Mumbai to Lisbon | Skyscanner', '<h1>Mumbai to Lisbon flights</h1><p>Compare cheap flights from Mumbai to Lisbon. Return fares from 48,000 rupees with one stop in Dubai or Istanbul. Flight time around 14 hours. Best time to book is six weeks before departure.</p>', 'Compare cheap flights, hotels and car hire.', 'Flights Hotels Car hire'));
add(s, 'hotel lisbon', 'https://www.booking.com/hotel/pt/alfama-house.html', art('Alfama House, Lisbon – Updated 2026 Prices', '<h1>Alfama House</h1><p>Guesthouse in the Alfama district of Lisbon, 300 m from São Jorge Castle. Free WiFi, rooftop terrace with river views, breakfast included. Check-in from 14:00. Guests love the location near the tram 28 stop.</p>', 'Book your hotel online.', 'Stays Flights Car rentals Attractions'));
add(s, 'blog lisbon', 'https://wanderblog.example.com/lisbon-3-day-itinerary', art('Lisbon in 3 days: the perfect itinerary', '<h1>Lisbon in 3 days</h1><p>Day one: wander the Alfama, ride tram 28 and watch the sunset from a miradouro. Day two: Belém Tower, Jerónimos Monastery and pastel de nata at Pastéis de Belém. Day three: a day trip to Sintra. Tips on where to stay, the Lisboa card and getting from the airport.</p>', '', 'Destinations Itineraries Tips'));
add(s, 'gpt lisbon', 'https://chatgpt.com/c/lis1', chat('Lisbon trip packing and tips', [['what should I pack for Lisbon in October and is the Lisboa card worth it?', '<p>October in Lisbon is mild, around 22 C by day, with some rain, so pack layers, a light rain jacket and comfortable shoes for the hills and cobblestones. The Lisboa card is worth it if you ride trams and visit Belém museums on the same day.</p>']], 3000));
add(s, 'flights tokyo', 'https://www.skyscanner.net/transport/flights/bom/nrt/', art('Cheap flights from Mumbai to Tokyo | Skyscanner', '<h1>Mumbai to Tokyo flights</h1><p>Compare cheap flights from Mumbai to Tokyo Narita and Haneda. Return fares from 52,000 rupees, direct or with a stop in Bangkok. Flight time around 9 hours.</p>', 'Compare cheap flights, hotels and car hire.', 'Flights Hotels Car hire'));
add(s, 'laptop shop', 'https://shop.example.com/search?k=laptop+for+students');
add(s, 'laptop review', 'https://tech.example.com/best-student-laptops', art('The best laptops for students in 2026', '<h1>Best student laptops</h1><p>We tested 20 laptops for battery life, weight and keyboards. The MacBook Air is the best overall, the Acer Aspire 5 is the best budget laptop and the Lenovo IdeaPad Slim 3 has the longest battery life for college.</p>', '', 'Phones Laptops Reviews'));
scenarios[s].together = [[['flights lisbon', 'hotel lisbon', 'blog lisbon', 'gpt lisbon'], 'Lisbon'], [['laptop shop', 'laptop review'], 'Laptop']];
scenarios[s].apart = [['flights tokyo', 'flights lisbon'], ['laptop review', 'hotel lisbon']];

// ------------------------------------------------------------------ S11: tabs opened from a search (opener)
// The result pages share few words with each other; what connects them is the search they came from.
s = 'S11 opened from a search';
add(s, 'google lisbon', 'https://www.google.com/search?q=things+to+do+in+lisbon');
add(s, 'belem tickets', 'https://tickets.example.com/belem-tower', art('Belém Tower tickets and opening hours', '<h1>Belém Tower</h1><p>Skip-the-line tickets, opening hours 10:00 to 18:30, closed on Mondays. Audio guide available in six languages.</p>'));
add(s, 'nata bakeries', 'https://foodguide.example.com/best-pastel-de-nata', art('The 7 best pastel de nata bakeries', '<h1>Best pastel de nata</h1><p>Flaky custard tarts with cinnamon: Manteigaria, Pastéis de Belém and Aloma are our favourites. Go early to avoid the queue.</p>'));
add(s, 'alfama tour', 'https://tours.example.net/alfama-walking-tour', art('Alfama walking tour with a local guide', '<h1>Alfama walking tour</h1><p>Two hours through the oldest neighbourhood, fado houses, viewpoints and São Jorge Castle. Small groups, free cancellation.</p>'));
add(s, 'unrelated recipe', 'https://recipes.example.com/apple-pie');
scenarios[s].openers = { 'belem tickets': 'google lisbon', 'nata bakeries': 'google lisbon', 'alfama tour': 'google lisbon' };
scenarios[s].together = [[['google lisbon', 'belem tickets', 'nata bakeries', 'alfama tour'], 'Lisbon']];
scenarios[s].apart = [['unrelated recipe', 'nata bakeries']];

// ------------------------------------------------------------------ S12: studying for two subjects
s = 'S12 study topics';
add(s, 'wiki photosynthesis', 'https://en.wikipedia.org/wiki/Photosynthesis', art('Photosynthesis - Wikipedia', '<h1>Photosynthesis</h1><p>Photosynthesis is the process by which plants, algae and cyanobacteria convert light energy into chemical energy. Chlorophyll in the chloroplasts absorbs light; the light-dependent reactions make ATP and NADPH, and the Calvin cycle fixes carbon dioxide into glucose.</p>', 'From Wikipedia, the free encyclopedia', 'Main page Contents Random article'));
add(s, 'yt photosynthesis', 'https://www.youtube.com/results?search_query=photosynthesis+explained');
add(s, 'quiz photosynthesis', 'https://quizlet.example.com/photosynthesis-flashcards', art('Photosynthesis flashcards', '<h1>Photosynthesis flashcards</h1><p>Chloroplast, chlorophyll, stomata, light reactions, Calvin cycle, glucose, carbon dioxide, oxygen. 24 terms for biology class.</p>', '', 'Study Flashcards Learn'));
add(s, 'wiki french revolution', 'https://en.wikipedia.org/wiki/French_Revolution', art('French Revolution - Wikipedia', '<h1>French Revolution</h1><p>The French Revolution began in 1789 with the storming of the Bastille. The monarchy of Louis XVI was abolished, the Republic declared, and the Reign of Terror under Robespierre followed before Napoleon rose to power.</p>', 'From Wikipedia, the free encyclopedia', 'Main page Contents Random article'));
add(s, 'history french revolution', 'https://history.example.com/topics/french-revolution', art('French Revolution: causes, timeline and key figures', '<h1>The French Revolution</h1><p>Debt, bread prices and Enlightenment ideas led to the Estates-General in 1789. Key moments: the Tennis Court Oath, the Bastille, the execution of Louis XVI and the Terror. Robespierre and Napoleon shaped the Republic.</p>', '', 'Topics Shows This day'));
scenarios[s].together = [[['wiki photosynthesis', 'yt photosynthesis', 'quiz photosynthesis'], 'Photosynthesis'], [['wiki french revolution', 'history french revolution'], null]];
scenarios[s].apart = [['wiki photosynthesis', 'wiki french revolution']];

// ------------------------------------------------------------------ pages used by the feature and load tests
for (const [path, title] of [['g1', 'Guitar chords for beginners chart'], ['g2', 'How to change acoustic guitar strings'], ['g3', 'Guitar strumming patterns for beginners'], ['g4', 'Guitar capo chart and chords']]) {
  // Also on a site of its own (g1-lessons.net/lesson), for tests that need different sites.
  for (const hostPath of [`guitar.example.com/${path}`, `${path}-lessons.net/lesson`]) page(hostPath, art(title, `<h1>${title}</h1><p>Learn guitar chords, strumming and strings. Practice chord changes on your acoustic guitar every day with a capo and a metronome; beginners should start with G, C, D and E minor chords on guitar.</p>`));
}
page('forum.example.org/login', { title: 'Sign in to Guitar Forum', desc: '', nav: '', password: true, now: '<p>Members talk about guitar chords, strings and amps.</p>' });
const FEED = "let n = 0; setInterval(() => { const m = document.querySelector('main'); for (let i = 0; i < 30; i++) { const d = document.createElement('div'); d.textContent = 'Post ' + (++n) + ': someone shared thoughts about travel, food, music, football and technology with a long caption to read.'; m.append(d); } }, 3000);";
const FLASH = "let on = false; setInterval(() => { on = !on; document.title = on ? '(1) New message' : 'Inbox'; }, 2500);";
const HUGE = "const m = document.querySelector('main'); const f = document.createDocumentFragment(); for (let i = 0; i < 30000; i++) { const p = document.createElement('p'); p.textContent = 'Paragraph ' + i + ' of a very long reference document about astronomy, galaxies, telescopes and orbital mechanics.'; f.append(p); } m.append(f);";
const CHURN = "const m = document.querySelector('main'); const t = document.createElement('table'); m.append(t); setInterval(() => { t.innerHTML = Array.from({ length: 300 }, (_, i) => '<tr><td>TICK' + i + '</td><td>' + (Math.random() * 1000).toFixed(2) + '</td><td>' + (Math.random() > 0.5 ? 'up' : 'down') + '</td></tr>').join(''); }, 100);";
for (let i = 0; i < 5; i++) page(`feed${i}.social.com/home`, { title: `Home feed ${i}`, nav: 'Home Explore', now: '<div>Feed</div>', script: FEED });
for (let i = 0; i < 3; i++) page(`mail${i}.webmail.com/inbox`, { title: 'Inbox', nav: 'Inbox Sent', now: '<div>Messages: meeting notes, invoices, newsletters</div>', script: FLASH });
for (let i = 0; i < 2; i++) page(`ref${i}.bigdocs.org/manual`, { title: `Astronomy reference manual ${i}`, now: '', script: HUGE });
for (let i = 0; i < 2; i++) page(`trade${i}.dashboard.io/live`, { title: `Live market dashboard ${i}`, now: '<div>Prices</div>', script: CHURN });

// A chat where the user's prompt appears first and the answer streams for about 20 seconds.
page('chatgpt.com/c/stream1', { title: 'ChatGPT', nav: 'New chat Search chats', now: '<div>Ask anything</div>', script: `
  setTimeout(() => {
    const m = document.querySelector('main');
    m.innerHTML = '<div data-message-author-role="user">which guitar chords should a beginner learn first?</div><div id="answer" data-message-author-role="assistant"></div>';
    let i = 0; const words = 'Start with G C D and E minor on guitar then practice switching between them slowly with a metronome before adding strumming patterns '.split(' ');
    const id = setInterval(() => { document.getElementById('answer').textContent += words[i++ % words.length] + ' '; if (i > 200) clearInterval(id); }, 100);
  }, 3000);` });

// Generated articles for load tests: /gen/<n> on any host, about one of 30 subjects.
const SUBJECTS = ['guitar chord strings fret capo strum acoustic amp pick tuning', 'goa beach resort flight hotel palolem trip coast villa nightlife',
  'python list dict function class module import loop pandas numpy', 'rust tokio async future borrow lifetime crate cargo trait spawn',
  'sourdough starter flour dough bake bread crumb proof oven yeast', 'football striker goal league transfer coach match penalty season club',
  'election vote party parliament coalition minister ballot campaign poll senate', 'stock market shares inflation interest bank investor bond earnings dividend',
  'climate emissions carbon warming summit renewable solar coal methane policy', 'iphone camera battery display chip android screen charger phone launch',
  'marathon running shoes training pace race stride cushion runner mileage', 'kubernetes cluster pod container docker deployment helm node ingress service',
  'photography lens aperture shutter exposure portrait tripod camera sensor lighting', 'garden tomato soil compost seed watering plant prune harvest fertilizer',
  'chess opening gambit endgame checkmate bishop knight rook pawn tournament', 'react component hook state props render jsx redux router vite',
  'coffee espresso grinder roast beans latte brew barista crema filter', 'yoga pose breathing stretch flexibility meditation mat balance core vinyasa',
  'mortgage loan rate lender refinance deposit credit property buyer equity', 'piano keys scales sonata chords pedal sheet music practice pianist',
  'dog puppy training leash treat bark breed vet walk crate', 'bitcoin crypto wallet blockchain token exchange ethereum mining coin defi',
  'wedding venue dress guests catering ceremony bride invitation photographer cake', 'astronomy telescope galaxy planet nebula orbit star comet eclipse observatory',
  'fitness workout squat deadlift protein gym muscle reps strength cardio', 'japan tokyo kyoto ramen shinkansen temple sushi osaka visa ryokan',
  'excel spreadsheet formula pivot vlookup chart cell macro sheet column', 'podcast microphone audio episode recording editing host interview listeners mixer',
  'baby sleep feeding diaper newborn nap stroller crib toddler pediatrician', 'linux kernel bash terminal shell ubuntu package grep systemd permissions'].map((s) => s.split(' '));
const GENERAL = 'the a and of to in is for on with that this it as are be by from at an your you can more how what best new guide tips first time make use good great people year day way'.split(' ');
export function genPage(path) {
  let seed = [...path].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const subject = SUBJECTS[seed % SUBJECTS.length];
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const title = `${pick(subject)} ${pick(subject)} ${pick(subject)} guide`;
  const words = Array.from({ length: 350 }, () => (rnd() < 0.35 ? pick(subject) : rnd() < 0.7 ? pick(GENERAL) : pick(pick(SUBJECTS))));
  return { title: title.charAt(0).toUpperCase() + title.slice(1), nav: 'Home Blog About Contact', now: `<h1>${title}</h1><p>${words.join(' ')}</p>` };
}
