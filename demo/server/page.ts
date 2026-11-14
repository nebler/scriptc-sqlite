// The demo's one page: live stats from /api/stats, search over /api/links,
// and a button that runs /api/bench in the server process.
export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>links: a native TypeScript backend</title>
<style>
  :root { color-scheme: light dark; --bg: #fcfcfb; --fg: #0b0b0b; --muted: #5d5c58; --line: #e2e1dc; --card: #f4f3f0; --accent: #2a78d6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141413; --fg: #f0efec; --muted: #a3a29b; --line: #2e2e2c; --card: #1c1c1b; --accent: #5598e7; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 17px; margin: 32px 0 8px; }
  p { color: var(--muted); margin: 0 0 12px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 16px 0; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .tile .k { font-size: 12px; color: var(--muted); }
  .tile .v { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
  input, button { font: inherit; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
  input { width: 100%; }
  button { cursor: pointer; background: var(--accent); color: #fff; border: 0; }
  button:disabled { opacity: .6; cursor: default; }
  .row { display: flex; gap: 8px; }
  ul { list-style: none; padding: 0; margin: 8px 0; }
  li { padding: 8px 0; border-bottom: 1px solid var(--line); }
  li a { color: var(--accent); text-decoration: none; }
  .meta { font-size: 12px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  th { font-size: 12px; color: var(--muted); font-weight: 600; }
  code { background: var(--card); padding: 1px 5px; border-radius: 4px; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>links</h1>
  <p>A web backend in one native binary: TypeScript compiled by <a href="https://scriptc.dev">scriptc</a>, with
  <a href="https://hono.dev">Hono</a> for routing and <a href="https://github.com/nebler/scriptc-sqlite">scriptc-sqlite</a>
  (SQLite compiled in) for storage. No Node.js at run time.</p>

  <div class="tiles" id="tiles"></div>
  <p class="meta" id="note"></p>

  <h2>Search</h2>
  <div class="row"><input id="q" placeholder="try: native sqlite, fast compile, hono" autocomplete="off"></div>
  <p class="meta" id="took"></p>
  <ul id="results"></ul>

  <h2>Add a link</h2>
  <div class="row"><input id="url" placeholder="https://..."><input id="title" placeholder="title"><button id="add">Add</button></div>
  <p class="meta" id="added"></p>

  <h2>Benchmark, in this process</h2>
  <p>Inserts and reads 100,000 rows in an in-memory database, through node:sqlite's API and through this package's typed API.</p>
  <button id="bench">Run</button>
  <div id="benchout"></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function stats() {
  const s = await (await fetch("/api/stats")).json();
  const tile = (k, v) => '<div class="tile"><div class="k">' + k + '</div><div class="v">' + v + "</div></div>";
  $("tiles").innerHTML =
    tile("Ready after start", s.bootMs + " ms") + tile("Memory (resident)", s.rssMiB ? s.rssMiB + " MiB" : "n/a") +
    tile("Links stored", s.links.toLocaleString("en-US")) + tile("Requests served", s.requests.toLocaleString("en-US"));
  $("note").textContent = s.runtime + " · SQLite " + s.sqlite + " · up " + s.uptimeS + " s" +
    (s.seedMs ? " · seeded 20,000 sample links in " + s.seedMs + " ms at start" : "");
}
async function find() {
  const r = await (await fetch("/api/links?q=" + encodeURIComponent($("q").value))).json();
  $("took").textContent = r.links.length + " results in " + r.ms + " ms (server side)";
  $("results").innerHTML = r.links.map((l) =>
    '<li><a href="/r/' + l.id + '">' + esc(l.title) + '</a><div class="meta">' + esc(l.url) + " · " + l.clicks + " clicks</div></li>").join("");
}
let timer; $("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(find, 120); });
$("add").addEventListener("click", async () => {
  const res = await fetch("/api/links", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: $("url").value, title: $("title").value }) });
  const j = await res.json();
  $("added").textContent = res.ok ? "Added #" + j.id + " (stored on this instance)" : j.error;
  if (res.ok) { $("q").value = ""; find(); stats(); }
});
$("bench").addEventListener("click", async () => {
  $("bench").disabled = true; $("bench").textContent = "Running...";
  const b = await (await fetch("/api/bench?n=100000")).json();
  const rows = (label, o) => Object.entries(o).map(([k, v], i) =>
    "<tr><td>" + (i === 0 ? label : "") + "</td><td><code>" + k + "</code></td><td>" + v + " ms</td></tr>").join("");
  $("benchout").innerHTML = "<table><tr><th>" + b.rows.toLocaleString("en-US") + " rows</th><th>API</th><th>time</th></tr>" +
    rows("insert", b.insert) + rows("read", b.read) + "</table>";
  $("bench").disabled = false; $("bench").textContent = "Run again"; stats();
});
stats(); find(); setInterval(stats, 5000);
</script>
</body>
</html>`;
