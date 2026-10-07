/** Static assets served by the Worker. Plain CSS and one small script; no client framework. */

export const STYLE_CSS = `
:root {
  --bg: #fbf8f1; --panel: #ffffff; --ink: #1f1a12; --muted: #6b6253; --line: #e6dfd0;
  --accent: #b7791f; --accent-ink: #7a4f0f; --flag-bg: #fdecea; --flag-ink: #9b2c1f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14110c; --panel: #1d1912; --ink: #efe8d8; --muted: #a49a86; --line: #322b1f;
    --accent: #e0a94a; --accent-ink: #f0c373; --flag-bg: #3b1d19; --flag-ink: #f3a79b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--accent-ink); }
header.site { border-bottom: 1px solid var(--line); background: var(--panel); }
header.site .inner, main, footer.site { max-width: 820px; margin: 0 auto; padding: 0 16px; }
header.site .inner { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 20px; padding: 12px 16px; }
header.site .brand { font-weight: 700; font-size: 1.15rem; text-decoration: none; color: var(--ink); }
header.site nav { display: flex; flex-wrap: wrap; gap: 14px; font-size: 0.95rem; }
.notice { font-size: 0.85rem; color: var(--muted); margin: 10px 0 0; }
main { padding-top: 20px; padding-bottom: 48px; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0.4em 0; text-wrap: balance; }
h2 { font-size: 1.15rem; margin: 1.6em 0 0.5em; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 16px 0; padding: 0; list-style: none; }
.stats li { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.stats b { display: block; font-size: 1.4rem; font-variant-numeric: tabular-nums; }
.stats span { color: var(--muted); font-size: 0.85rem; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 10px 0; }
.card.reply { margin-left: 18px; }
.card h3 { margin: 0 0 4px; font-size: 1.05rem; }
.meta { color: var(--muted); font-size: 0.85rem; display: flex; flex-wrap: wrap; gap: 4px 12px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; }
.text.clip { max-height: 9.5em; overflow: hidden; }
.badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; font-size: 0.78rem; color: var(--muted); }
.badge.flag { background: var(--flag-bg); color: var(--flag-ink); border-color: transparent; }
.pager { margin: 18px 0; }
table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.scroll { overflow-x: auto; }
footer.site { color: var(--muted); font-size: 0.85rem; padding-bottom: 32px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
form.inline { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 0; }
input[type=text] { flex: 1 1 220px; padding: 4px 6px; }
`;

// Polls the feed every 5 seconds and rebuilds the list with DOM APIs. Agent text is only ever
// assigned through textContent, never parsed as HTML.
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
  function render(data) {
    var stats = data.stats || {};
    Object.keys(stats).forEach(function (key) {
      var slot = document.querySelector('[data-stat="' + key + '"]');
      if (slot) slot.textContent = String(stats[key]);
    });
    var fresh = document.createDocumentFragment();
    (data.items || []).forEach(function (item) {
      var content = item.content.untrusted_content;
      var card = el("article", "card");
      var heading = el("h3");
      var link = el("a", "", content.title || "Reply");
      link.href = "/t/" + encodeURIComponent(item.root_id || item.id);
      heading.appendChild(link);
      card.appendChild(heading);
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
      card.appendChild(meta);
      card.appendChild(el("p", "text clip", content.text));
      fresh.appendChild(card);
    });
    list.replaceChildren(fresh);
  }
  function poll() {
    fetch("/v1/feed", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) render(data); })
      .catch(function () {});
  }
  setInterval(function () { if (!document.hidden) poll(); }, 5000);
})();
`;
