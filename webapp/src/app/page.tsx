import { Nav } from "@/components/Nav";
import { CopyCommand } from "@/components/CopyCommand";
import { ScanTerminal } from "@/components/ScanTerminal";

const REPO = "https://github.com/elliot-ylambda/gradient";
const NPM = "https://www.npmjs.com/package/gradient";

export default function Home() {
  return (
    <>
      <span id="top" />
      <Nav />

      <main>
        {/* ---------------- hero ---------------- */}
        <section className="hero">
          <div className="wrap hero-grid">
            <div>
              <p className="eyebrow">Open source · for Claude Code power users</p>
              <h1 className="h1">
                The prompts you keep retyping into{" "}
                <span className="grad-text">Claude Code</span>, compiled into commands.
              </h1>
              <p className="lead">
                <strong>gradient</strong> reads your own session history, finds what
                you repeat, and generates the automations to stop — slash commands,
                hooks, and loops. It only ever <strong>suggests</strong>: you review
                and approve each one, and nothing runs without you.
              </p>

              <div className="hero-actions" id="install">
                <CopyCommand command="npx gradient scan" />
                <a className="btn-ghost" href={REPO}>
                  Star on GitHub <span className="arrow">→</span>
                </a>
              </div>

              <div className="hero-meta">
                <span>
                  <b>Read-only</b> on your code
                </span>
                <span>
                  <b>No API key</b> — reuses your claude auth
                </span>
                <span>
                  <b>MIT</b> licensed
                </span>
              </div>
            </div>

            <ScanTerminal />
          </div>
        </section>

        {/* ---------------- how it works ---------------- */}
        <section className="section" id="how">
          <div className="wrap">
            <div className="section-head">
              <p className="eyebrow">How it works</p>
              <h2 className="section-title">
                Three steps, and you stay in control of the last two.
              </h2>
              <p className="section-sub">
                A pipeline of small, read-only stages. The model only ever sees short
                candidate snippets — never your whole transcripts.
              </p>
            </div>

            <div className="steps">
              <div className="step">
                <span className="num">01 / scan</span>
                <h3>Read your history</h3>
                <p>
                  <code>scan</code> reads your local Claude Code transcripts, strips
                  out Claude Code&apos;s own injected scaffolding, and clusters what you
                  actually typed by frequency. Fully read-only.
                </p>
              </div>
              <div className="step">
                <span className="num">02 / review</span>
                <h3>Weigh the evidence</h3>
                <p>
                  Each suggestion arrives ranked, with the receipts: how many times you
                  ran it, across how many sessions, and a confidence label — so you only
                  automate what&apos;s actually a habit.
                </p>
              </div>
              <div className="step">
                <span className="num">03 / apply</span>
                <h3>Generate the artifact</h3>
                <p>
                  Approve, and <code>gradient</code> writes it: a{" "}
                  <code>.claude/commands/*.md</code>, a settings hook, or a ready-to-run{" "}
                  <code>/loop</code> line. Every artifact is tracked and reversible.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------- what it generates ---------------- */}
        <section className="section" id="generates">
          <div className="wrap">
            <div className="section-head">
              <p className="eyebrow">What it generates</p>
              <h2 className="section-title">Three kinds of automation, from one scan.</h2>
            </div>

            <div className="cards">
              <article className="card">
                <span className="kind">Slash command</span>
                <h3>Your rituals, named</h3>
                <p>
                  Repeated multi-step prompts become a single command in{" "}
                  <code>.claude/commands/</code>.
                </p>
                <div className="ex">
                  <b>found:</b> &ldquo;push, open a PR, review it&rdquo; ×14 → /ship
                </div>
              </article>

              <article className="card">
                <span className="kind">Hook</span>
                <h3>The right reflex, automatic</h3>
                <p>
                  Patterns that should fire on an event become a hook that calls a tested{" "}
                  <code>gradient</code> subcommand — never raw inline shell.
                </p>
                <div className="ex">
                  <b>found:</b> /compact ×143 → a PreCompact <code>checkpoint</code>
                </div>
              </article>

              <article className="card">
                <span className="kind">Loop</span>
                <h3>The nudge you keep giving</h3>
                <p>
                  A recurring prod — &ldquo;continue,&rdquo; &ldquo;what&apos;s
                  next?&rdquo; — becomes a ready-to-run <code>/loop</code> line you
                  choose to start.
                </p>
                <div className="ex">
                  <b>found:</b> &ldquo;continue&rdquo; ×150 across 44 sessions
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* ---------------- trust / privacy ---------------- */}
        <section className="section">
          <div className="wrap">
            <div className="trust">
              <p className="trust-lead">
                It reads your history, so it&apos;s built to earn that.
              </p>
              <div>
                <div className="tt">Stays on your machine</div>
                <div className="td">
                  Clustering is local and LLM-free. Only short candidate snippets ever
                  reach a model, never whole transcripts — and a redaction pass strips
                  secrets and keys first.
                </div>
              </div>
              <div>
                <div className="tt">No new credentials</div>
                <div className="td">
                  The default backend shells out to your existing <code>claude</code>{" "}
                  CLI auth. No API key to set. An Anthropic-key backend is there if you
                  want it.
                </div>
              </div>
              <div>
                <div className="tt">You hold the switch</div>
                <div className="td">
                  gradient suggests and generates, but you enable. Nothing
                  auto-schedules, nothing runs behind your back.
                </div>
              </div>
              <div>
                <div className="tt">Always reversible</div>
                <div className="td">
                  Every generated artifact is recorded in a manifest, so{" "}
                  <code>gradient remove</code> is a clean uninstall — no orphaned files.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------------- quickstart ---------------- */}
        <section className="section">
          <div className="wrap">
            <div className="section-head">
              <p className="eyebrow">Quickstart</p>
              <h2 className="section-title">From history to your first command in two lines.</h2>
            </div>
            <pre className="quick">
              <span className="t-prompt">$ </span>npx gradient scan
              {"        "}<span className="t-dim"># read history, propose automations</span>
              {"\n"}
              <span className="t-prompt">$ </span>npx gradient review
              {"      "}<span className="t-dim"># walk suggestions, approve the keepers</span>
              {"\n\n"}
              <span className="t-dim">  # works even with no model available —</span>
              {"\n"}
              <span className="t-dim">  # exact-repeat habits become commands without an LLM.</span>
            </pre>
          </div>
        </section>
      </main>

      {/* ---------------- footer ---------------- */}
      <footer className="footer">
        <div className="wrap footer-inner">
          <a className="wordmark" href="#top">
            <span className="mark" aria-hidden="true" />
            gradient
          </a>
          <div className="footer-links">
            <a href={REPO}>GitHub</a>
            <a href={NPM}>npm</a>
            <a href="#how">How it works</a>
            <a href="#generates">Output</a>
          </div>
          <small>MIT · built for Claude Code</small>
        </div>
      </footer>
    </>
  );
}
