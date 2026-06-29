type Row = {
  chip: "high" | "inferred" | "hook" | "loop";
  label: string;
  name: string;
  desc: string;
  evidence: string;
};

// Drawn from the spec's real dogfooding run (2,800+ transcripts, 4,992 prompts).
const ROWS: Row[] = [
  { chip: "high", label: "high", name: "/ship", desc: "push, open a PR, review it", evidence: "×14 · 9 sessions" },
  { chip: "high", label: "high", name: "/plan", desc: "write the implementation plan", evidence: "×11 · 7 sessions" },
  { chip: "hook", label: "hook", name: "precompact", desc: "checkpoint before /compact", evidence: "×143 · 31 sessions" },
  { chip: "loop", label: "loop", name: "continue", desc: "auto-continue until done", evidence: "×150 · 44 sessions" },
  { chip: "inferred", label: "infer", name: "/merge-main", desc: "merge main into this PR", evidence: "×6 · 5 sessions" },
];

export function ScanTerminal() {
  // staggered reveal index, incremented per line
  let i = 0;
  const line = () => i++;

  return (
    <div className="term" role="img" aria-label="Terminal showing the output of running npx gradient scan: it reads 2,841 transcripts and proposes five automations ranked by confidence.">
      <div className="term-bar">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
        <span className="term-title">gradient scan — zsh</span>
      </div>
      <div className="term-body">
        <span className="term-line reveal" style={{ ["--i" as string]: line() }}>
          <span className="t-prompt">$ </span>npx gradient scan
        </span>
        <span className="term-line reveal t-dim" style={{ ["--i" as string]: line() }}>
          gradient · analysis engine v0.1.0
        </span>
        <span className="term-line reveal" style={{ ["--i" as string]: line() }}>
          {"  "}<span className="t-muted">scanning</span> 2,841 transcripts · 1.0 GB · 4,992 prompts{"   "}<span className="t-ok">✓</span>
        </span>
        <span className="term-line reveal" style={{ ["--i" as string]: line() }}>
          {"  "}<span className="t-muted">filtering</span> injected scaffolding (×849, ×492){"        "}<span className="t-ok">✓</span>
        </span>
        <span className="term-line reveal" style={{ ["--i" as string]: line() }}>
          {"  "}<span className="t-muted">clustering</span> 4,992 prompts → 38 candidates{"        "}<span className="t-ok">✓</span>
        </span>
        <span className="term-line reveal t-dim" style={{ ["--i" as string]: line() }}>
          {" "}
        </span>
        <span className="term-line reveal t-name" style={{ ["--i" as string]: line() }}>
          {"  "}5 automations worth your time
        </span>
        <span className="term-line reveal t-dim" style={{ ["--i" as string]: line() }}>
          {" "}
        </span>
        {ROWS.map((r) => (
          <span key={r.name} className="term-line reveal" style={{ ["--i" as string]: line() }}>
            {"  "}
            <span className={`chip ${r.chip}`}>{r.label}</span>
            {"  "}
            <span className="t-name">{r.name.padEnd(12, " ")}</span>
            <span className="t-muted">{r.desc.padEnd(28, " ")}</span>
            <span className="t-dim">{r.evidence}</span>
          </span>
        ))}
        <span className="term-line reveal t-dim" style={{ ["--i" as string]: line() }}>
          {" "}
        </span>
        <span className="term-line reveal" style={{ ["--i" as string]: line() }}>
          {"  "}<span className="t-muted">review them →</span> <span className="t-prompt">npx gradient review</span>
        </span>
      </div>
    </div>
  );
}
