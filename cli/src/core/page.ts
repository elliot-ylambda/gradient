import type { Finding, Severity } from "./findings.js";
import type { InsightsMetrics } from "./insights.js";
import { escapeHtml } from "./insights.js";
import { displayCommand } from "./hookBinary.js";

/**
 * The checkup page: everything a run found, on one local page you can click
 * through.
 *
 * Deliberately a `file://` page and not a server. An earlier design ran a
 * loopback HTTP server so the page could POST decisions back, which bought one
 * convenience — a submit button — at the price of a port, a capability token,
 * DNS-rebinding checks, and a process lifetime to manage. Clicking through and
 * copying one command costs the user a paste and removes all of it.
 *
 * Self-contained by requirement, not by habit: no external stylesheet, script,
 * font, or image, so it renders identically offline and can never phone home
 * with what it is displaying. Every string on it was mined from transcripts or
 * read out of the user's files, so all of it is escaped and none of it reaches
 * JavaScript — the script only ever handles finding ids, which are hex.
 */

export interface PageInput {
  runId: string;
  projectDir: string;
  targets: readonly string[];
  findings: readonly Finding[];
  metrics?: InsightsMetrics;
  /** Skills installed for the assistants, and what they cost every session. */
  contextCost?: { skills: number; chars: number };
  /** How to invoke gradient on this machine; the page's output is a command. */
  invocation?: string;
}

const SEVERITY_LABEL: Record<Severity, string> = { high: "high", medium: "medium", low: "low" };

const STYLE = `
:root{
  --bg:#fbfaf9; --panel:#fff; --ink:#1a1826; --muted:#6b6880; --line:#e6e3ee;
  --violet:#7c6cff; --coral:#ff7e6b; --amber:#c98a00; --green:#18864b;
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#0f0e14; --panel:#17161f; --ink:#eceaf5; --muted:#9a97ad; --line:#2a2836; }
}
*{box-sizing:border-box}
body{
  margin:0; padding:32px 20px 140px; background:var(--bg); color:var(--ink);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
}
.wrap{max-width:860px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px;letter-spacing:-0.01em}
.sub{color:var(--muted);font-size:13px;margin:0 0 24px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.metrics{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 28px;padding:0;list-style:none}
.metrics li{
  background:var(--panel);border:1px solid var(--line);border-radius:8px;
  padding:8px 12px;font-size:13px;
}
.metrics b{font-variant-numeric:tabular-nums;font-size:15px;display:block}
.metrics span{color:var(--muted)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin:28px 0 10px}
.card{
  background:var(--panel);border:1px solid var(--line);border-left-width:3px;
  border-radius:10px;padding:14px 16px;margin:0 0 10px;
}
.card[data-decision="accept"]{border-left-color:var(--green)}
.card[data-decision="deny"]{border-left-color:var(--muted);opacity:.55}
.card[data-severity="high"]{border-left-color:var(--coral)}
.card[data-severity="medium"]{border-left-color:var(--amber)}
.card[data-severity="low"]{border-left-color:var(--violet)}
.card[data-decision="accept"][data-severity]{border-left-color:var(--green)}
.head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.title{font-weight:600;flex:1;min-width:240px}
.chip{
  font-size:11px;text-transform:uppercase;letter-spacing:.06em;
  border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);
}
.detail{color:var(--muted);font-size:13.5px;margin:8px 0 0}
.evidence{
  margin:10px 0 0;padding:8px 10px;background:var(--bg);border-radius:6px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
  overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere;
}
.diff{margin:10px 0 0;font-size:12.5px;overflow-x:auto}
.diff pre{margin:0;padding:8px 10px;background:var(--bg);border-radius:6px;white-space:pre;overflow-x:auto}
.diff .del{color:var(--coral)}
.diff .add{color:var(--green)}
.actions{display:flex;gap:8px;margin:12px 0 0}
button{
  font:inherit;font-size:13px;padding:5px 12px;border-radius:7px;cursor:pointer;
  border:1px solid var(--line);background:var(--bg);color:var(--ink);
}
button[aria-pressed="true"]{border-color:currentColor;font-weight:600}
.accept[aria-pressed="true"]{color:var(--green)}
.deny[aria-pressed="true"]{color:var(--coral)}
footer{
  position:fixed;left:0;right:0;bottom:0;background:var(--panel);
  border-top:1px solid var(--line);padding:12px 20px;
}
.bar{max-width:860px;margin:0 auto;display:flex;gap:12px;align-items:center}
.bar code{
  flex:1;min-width:0;overflow-x:auto;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
  background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:8px 10px;
}
.empty{color:var(--muted);padding:20px 0}
`.trim();

const script = (invocation: string) => `
(function(){
  var out = document.getElementById("cmd");
  var copy = document.getElementById("copy");
  function render(){
    var accept = [], deny = [];
    document.querySelectorAll(".card").forEach(function(card){
      var d = card.getAttribute("data-decision");
      if (d === "accept") accept.push(card.getAttribute("data-id"));
      if (d === "deny") deny.push(card.getAttribute("data-id"));
    });
    var parts = [${JSON.stringify(`${invocation} optimize`)}];
    if (accept.length) parts.push("--apply " + accept.join(","));
    if (deny.length) parts.push("--deny " + deny.join(","));
    out.textContent = parts.length > 1 ? parts.join(" ") : "choose the changes you want, then copy the command";
    copy.disabled = parts.length === 1;
  }
  document.addEventListener("click", function(event){
    var button = event.target.closest("button[data-act]");
    if (!button) return;
    var card = button.closest(".card");
    var next = button.getAttribute("data-act");
    var current = card.getAttribute("data-decision");
    card.setAttribute("data-decision", current === next ? "" : next);
    card.querySelectorAll("button[data-act]").forEach(function(b){
      b.setAttribute("aria-pressed", String(b.getAttribute("data-act") === card.getAttribute("data-decision")));
    });
    render();
  });
  copy.addEventListener("click", function(){
    var text = out.textContent;
    // file:// is not a secure context in every browser, so the async clipboard
    // API may not exist. Fall back to a selection copy rather than failing.
    function fallback(){
      var area = document.createElement("textarea");
      area.value = text; document.body.appendChild(area); area.select();
      try { document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(area);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else { fallback(); }
    copy.textContent = "copied";
    setTimeout(function(){ copy.textContent = "copy"; }, 1200);
  });
  render();
})();
`.trim();

function metricRow(label: string, value: number): string {
  return `<li><b>${value}</b><span>${escapeHtml(label)}</span></li>`;
}

/** A change rendered as a diff. Text only — these strings came from the user's
 *  files and from transcripts, and must never become markup. */
function renderChanges(finding: Finding): string {
  if (finding.changes.length === 0) {
    return finding.suggestion
      ? `<div class="detail">Installs a new artifact for ${escapeHtml(finding.targets.join(" and "))}.</div>`
      : "";
  }
  const lines: string[] = [];
  for (const change of finding.changes) {
    lines.push(`<div class="mono" style="color:var(--muted);font-size:12px">${escapeHtml(change.path)}</div>`);
    const body: string[] = [];
    if (change.before !== undefined) body.push(`<span class="del">- ${escapeHtml(change.before)}</span>`);
    if (change.after !== undefined) body.push(`<span class="add">+ ${escapeHtml(change.after)}</span>`);
    if (body.length === 0) body.push(`<span class="del">${escapeHtml(change.op)}</span>`);
    lines.push(`<div class="diff"><pre>${body.join("\n")}</pre></div>`);
  }
  return lines.join("");
}

function renderCard(finding: Finding): string {
  return [
    `<article class="card" data-id="${escapeHtml(finding.id)}" data-severity="${finding.severity}" data-decision="">`,
    `<div class="head">`,
    `<span class="title">${escapeHtml(finding.title)}</span>`,
    `<span class="chip">${escapeHtml(SEVERITY_LABEL[finding.severity])}</span>`,
    `<span class="chip mono">${escapeHtml(finding.id)}</span>`,
    `</div>`,
    `<p class="detail">${escapeHtml(finding.detail)}</p>`,
    `<div class="evidence">${escapeHtml(finding.evidence)}</div>`,
    renderChanges(finding),
    `<div class="actions">`,
    `<button class="accept" type="button" data-act="accept" aria-pressed="false">accept</button>`,
    `<button class="deny" type="button" data-act="deny" aria-pressed="false">deny</button>`,
    `</div>`,
    `</article>`,
  ].join("");
}

export function renderPage(input: PageInput): string {
  const byFamily = new Map<string, Finding[]>();
  for (const finding of input.findings) {
    const group = byFamily.get(finding.family) ?? [];
    group.push(finding);
    byFamily.set(finding.family, group);
  }

  const metrics = input.metrics;
  const tiles = metrics ? [
    metricRow("prompts", metrics.prompts),
    metricRow("nudges", metrics.nudges),
    metricRow("interrupts", metrics.interrupts),
    metricRow("context deaths", metrics.continuations),
    metricRow("compacts", metrics.compacts),
    metricRow("error pastes", metrics.errorPastes),
  ].join("") : "";
  const cost = input.contextCost
    ? metricRow(`skill description chars, every session`, input.contextCost.chars) +
      metricRow("skills installed", input.contextCost.skills)
    : "";

  const groups = [...byFamily.entries()]
    .map(([family, findings]) =>
      `<h2>${escapeHtml(family)}</h2>${findings.map(renderCard).join("")}`)
    .join("");

  const body = input.findings.length === 0
    ? `<p class="empty">Nothing to change — your setup matches how you actually work.</p>`
    : groups;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>gradient checkup</title>
<style>${STYLE}</style></head><body><div class="wrap">
<h1>gradient checkup</h1>
<p class="sub mono">${escapeHtml(input.projectDir)} · ${escapeHtml(input.targets.join(" + "))} · run ${escapeHtml(input.runId)}</p>
${tiles || cost ? `<ul class="metrics">${tiles}${cost}</ul>` : ""}
${body}
</div>
<footer><div class="bar">
<code id="cmd"></code>
<button id="copy" type="button">copy</button>
</div></footer>
<script>${script(input.invocation ?? displayCommand())}</script>
</body></html>
`;
}
