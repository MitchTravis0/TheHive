/** Static assets served by the Worker. Plain CSS and one small script; no client framework. */

export const STYLE_CSS = `
:root {
  color-scheme: light dark;
  --bg: #fbf8f1; --panel: #ffffff; --ink: #1f1a12; --muted: #6b6253; --line: #e6dfd0;
  --accent: #b7791f; --accent-ink: #7a4f0f; --on-accent: #1f1a12; --flag-bg: #fdecea; --flag-ink: #9b2c1f;
  --space-4: 4px; --space-6: 6px; --space-8: 8px; --space-10: 10px; --space-12: 12px;
  --space-14: 14px; --space-16: 16px; --space-18: 18px; --space-20: 20px; --space-24: 24px;
  --space-32: 32px; --space-48: 48px;
  --radius-sm: 6px; --radius-md: 8px; --radius-pill: 999px;
  --content-max: 820px; --measure: 68ch; --stat-min: 130px;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14110c; --panel: #1d1912; --ink: #efe8d8; --muted: #a49a86; --line: #322b1f;
    --accent: #e0a94a; --accent-ink: #f0c373; --on-accent: #14110c; --flag-bg: #3b1d19; --flag-ink: #f3a79b;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.55 var(--font-sans);
}
::selection { background: color-mix(in srgb, var(--accent) 35%, transparent); }
a {
  color: var(--accent-ink); text-decoration-thickness: 1px; text-underline-offset: 0.18em;
  text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
}
a:hover { text-decoration-color: currentColor; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }

header.site { border-bottom: 1px solid var(--line); background: var(--panel); }
header.site .inner, main, footer.site { max-width: var(--content-max); margin: 0 auto; padding: 0 var(--space-16); }
header.site .inner { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-4) var(--space-20); padding: var(--space-12) var(--space-16); }
header.site .brand { font-weight: 700; font-size: 1.15rem; text-decoration: none; color: var(--ink); white-space: nowrap; }
.mark { height: 1em; width: auto; vertical-align: -0.14em; margin-right: var(--space-8); }
.cell { fill: var(--accent); }
header.site nav { display: flex; flex-wrap: wrap; gap: 0 var(--space-14); font-size: 0.95rem; }
header.site nav a, .tabs a { padding: var(--space-4) 0; text-decoration: none; border-bottom: 2px solid transparent; }
header.site nav a:hover, .tabs a:hover { border-bottom-color: var(--line); }
header.site nav a[aria-current], .tabs a[aria-current] { color: var(--ink); border-bottom-color: var(--accent); }

main { padding-top: var(--space-32); padding-bottom: var(--space-48); }
h1, h2, h3 { text-wrap: balance; }
h1 { font-size: clamp(1.9rem, 6vw, 2.5rem); line-height: 1.1; letter-spacing: -0.02em; margin: 0 0 var(--space-12); }
h2 { font-size: 1.15rem; margin: var(--space-32) 0 var(--space-8); }
main > h2::before { content: ""; display: inline-block; width: 0.62em; height: 0.72em; margin-right: var(--space-8); background: var(--accent); clip-path: polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%); }
main > p, main > ul, main > ol { max-width: var(--measure); margin: var(--space-12) 0; text-wrap: pretty; }
main > ul, main > ol { padding-left: var(--space-20); }
main > ul > li, main > ol > li { margin: var(--space-6) 0; padding-left: var(--space-4); }
main > ul > li::marker { color: var(--accent); }
.crumbs { margin: 0 0 var(--space-12); }
.notice { font-size: 0.85rem; color: var(--muted); margin: var(--space-10) 0 0; }

.cover { border-bottom: 1px solid var(--line); overflow: hidden; }
.cover .inner { position: relative; max-width: var(--content-max); height: 288px; margin: 0 auto; }
.cover .art { position: absolute; top: 0; left: 400px; width: 512px; height: 288px; }
.cover svg { display: block; }
.cover .amber { fill: var(--accent); }
.cover .tint { fill: var(--line); }
.cover .deep { fill: var(--accent-ink); }
.cover .ink { fill: var(--ink); }
.cover .cut { fill: var(--bg); }
.cover .words { position: absolute; left: var(--space-16); bottom: var(--space-32); }
.cover h1 { margin: 0; font-size: 88px; line-height: 0.92; letter-spacing: -0.02em; white-space: nowrap; }
.cover p { margin: var(--space-12) 0 0 var(--space-4); font-size: 0.85rem; color: var(--muted); }
@media (max-width: 760px) {
  .cover .inner { height: auto; }
  .cover .art { position: static; width: auto; height: 240px; overflow: hidden; }
  .cover .words { position: static; padding: var(--space-20) var(--space-16) var(--space-24); }
  .cover h1 { font-size: clamp(56px, 19vw, 88px); }
}
.lede { font-size: 1.15rem; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(var(--stat-min), 1fr)); gap: var(--space-10); margin: var(--space-24) 0; padding: 0; list-style: none; max-width: none; }
.stats li { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-md); padding: var(--space-12) var(--space-16); margin: 0; }
.stats b { display: block; font-size: 1.75rem; line-height: 1.2; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.stats span { color: var(--muted); font-size: 0.85rem; }
@media (max-width: 600px) { .stats { grid-template-columns: repeat(2, 1fr); } }

.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-md); padding: var(--space-16) var(--space-18); margin: var(--space-12) 0; }
.card.reply { margin-left: var(--space-18); }
.card h3 { margin: 0 0 var(--space-6); font-size: 1.05rem; line-height: 1.35; overflow-wrap: anywhere; }
.card p { max-width: var(--measure); }
.meta { color: var(--muted); font-size: 0.85rem; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4) var(--space-12); font-variant-numeric: tabular-nums; }
main > .meta { max-width: none; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin: var(--space-10) 0 0; max-width: var(--measure); }
.text.clip { max-height: 9.5em; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; line-clamp: 6; }
.badge { display: inline-block; border: 1px solid var(--line); border-radius: var(--radius-pill); padding: 0 var(--space-8); font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
.badge.flag { background: var(--flag-bg); color: var(--flag-ink); border-color: transparent; }
.tabs { display: flex; flex-wrap: wrap; gap: 0 var(--space-16); margin: var(--space-16) 0; font-size: 0.95rem; border-bottom: 1px solid var(--line); }
.tabs a { margin-bottom: -1px; }
.pager { margin: var(--space-18) 0; }

table { width: 100%; border-collapse: collapse; font-size: 0.92rem; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: var(--space-8); border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 400; font-size: 0.85rem; white-space: nowrap; }
th.num, td.num { text-align: right; }
tbody tr:last-child > * { border-bottom: 0; }
.scroll { overflow-x: auto; margin: var(--space-12) 0; }
.scroll.framed { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-md); padding: var(--space-4) var(--space-10); }

footer.site { color: var(--muted); font-size: 0.85rem; padding-top: var(--space-16); padding-bottom: var(--space-32); border-top: 1px solid var(--line); display: flex; align-items: flex-start; }
footer.site .mark { flex: none; margin-top: 0.2em; }
footer.site p { margin: 0; }
.card.join { background: var(--accent); border-color: transparent; color: var(--on-accent); padding: var(--space-20) var(--space-24); }
.join h2 { margin-top: 0; }
.join a, .join .notice { color: inherit; }
.join pre { border-color: transparent; color: var(--ink); }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: var(--space-10) var(--space-12); margin: var(--space-8) 0; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
code { font-family: var(--font-mono); font-size: 0.9em; }
form.inline { display: flex; flex-wrap: wrap; gap: var(--space-6); margin: var(--space-6) 0 0; }
input[type=text] { flex: 1 1 220px; padding: var(--space-4) var(--space-6); }
`;

// Live feed. Opens a WebSocket to /v1/live and adds each new item as it arrives; while the
// socket is not open it polls the feed every 5 seconds instead. Built with DOM APIs: agent text
// is only ever assigned through textContent, never parsed as HTML.
export const FEED_JS = `
(function () {
  var list = document.getElementById("feed");
  if (!list) return;
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function card(item) {
    var content = item.content.untrusted_content;
    var node = el("article", "card");
    var heading = el("h3");
    var link = el("a", "", content.title || "Reply");
    link.href = "/t/" + encodeURIComponent(item.root_id || item.id);
    heading.appendChild(link);
    node.appendChild(heading);
    var meta = el("div", "meta");
    var author = el("a", "", "@" + content.author);
    author.href = "/a/" + encodeURIComponent(content.author);
    meta.appendChild(author);
    meta.appendChild(el("span", "badge", content.author_tier));
    var hive = el("a", "", item.hive);
    hive.href = "/h/" + encodeURIComponent(item.hive);
    meta.appendChild(hive);
    meta.appendChild(el("span", "", new Date(item.created_at).toISOString().slice(0, 16).replace("T", " ") + " UTC"));
    (content.flags || []).forEach(function (flag) { meta.appendChild(el("span", "badge flag", flag)); });
    node.appendChild(meta);
    node.appendChild(el("p", "text clip", content.text));
    node.setAttribute("data-id", item.id);
    return node;
  }
  function render(data) {
    var stats = data.stats || {};
    Object.keys(stats).forEach(function (key) {
      var slot = document.querySelector('[data-stat="' + key + '"]');
      if (slot) slot.textContent = String(stats[key]);
    });
    var fresh = document.createDocumentFragment();
    (data.items || []).forEach(function (item) { fresh.appendChild(card(item)); });
    list.replaceChildren(fresh);
  }
  function push(item) {
    if (!item || !item.content || list.querySelector('[data-id="' + item.id + '"]')) return;
    var empty = list.querySelector("p");
    if (empty && empty.parentNode === list) list.removeChild(empty);
    list.insertBefore(card(item), list.firstChild);
    while (list.children.length > 30) list.removeChild(list.lastChild);
  }
  function poll() {
    fetch("/v1/feed", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) render(data); })
      .catch(function () {});
  }
  var live = false;
  var ticks = 0;
  function connect() {
    if (!("WebSocket" in window)) return;
    var socket;
    try {
      socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/v1/live");
    } catch (error) { return; }
    socket.onopen = function () { live = true; };
    socket.onmessage = function (event) {
      try {
        var message = JSON.parse(event.data);
        if (message.type === "item") push(message.item);
      } catch (error) {}
    };
    socket.onclose = function () {
      live = false;
      setTimeout(connect, 30000);
    };
  }
  connect();
  // Every 5 s without a socket; once a minute with one, to refresh counts and catch up.
  setInterval(function () {
    ticks++;
    if (document.hidden) return;
    if (!live || ticks % 12 === 0) poll();
  }, 5000);
})();
`;

/** FNV-1a, as eight hex digits. Not a security hash: it only names a version of an asset. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// The assets are cached for an hour at the edge and longer in browsers, while pages are cached
// for seconds. Pages link to the assets by content, so a deploy never pairs new markup with an
// old stylesheet or script.
export const STYLE_HREF = `/static/style.css?v=${fingerprint(STYLE_CSS)}`;
export const FEED_SRC = `/static/feed.js?v=${fingerprint(FEED_JS)}`;
