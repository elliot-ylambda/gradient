# Security policy

## Supported versions

Only the latest published `0.1.x` release receives security fixes. Upgrade from
`0.1.0` to `0.1.1` or newer: the original release has known isolation and
installed-entrypoint defects.

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Email
`contact@ylambda.com` with the affected version, a synthetic reproduction, the
impact you believe is possible, and whether you want public credit.

Do not include real credentials, private transcripts, or customer data.

## Security boundaries

Gradient reads local Claude Code transcript data and can send bounded excerpts
to either the local `claude` CLI or the Anthropic API. Project-only preference
mining can include bounded assistant questions. Common credential and PII
formats are redacted, but redaction is not a complete data-loss-prevention system.
Users should not scan or enable autopilot for material they are unwilling to
send to the configured model.

Transcript discovery, per-file and aggregate reads, parsed prompts, LLM
candidates, configuration, settings, caches, playbooks, and logs have hard
resource ceilings. User ignore patterns are restricted to a small
linear-looking regex subset. Paid autopilot attempts default to 10 and have an
absolute ceiling of 100 per session; repository configuration can only lower
that authority and budget.

Generated artifacts require explicit approval. Hooks are installed into local
Claude settings and require private per-project consent where applicable.
Observed behavior is not treated as authorization: paste/sequence artifacts are
advisory, preference rules exclude consequential approvals, and arbitrary model
content is not written into artifacts. Gradient does not store
`ANTHROPIC_API_KEY`.

Team bundles copy no raw transcript or cache files, but approved artifact text
may quote or derive from redacted prompts. Export requires repo-local provenance
plus a private exact-content approval tied to the current generator safety
version. Legacy, changed, sensitive-looking, and unapproved artifacts fail
closed. Export is bounded and atomically replaces only Gradient-owned bundle
trees; hook export is disabled because one user's approval cannot authorize a
hook on another user's machine. Secret scanning is best effort, so review every
bundle before sharing it.

Continuity is separately consented per project. It privately retains bounded,
redacted user intents (not assistant/tool-output prose) and returns them to
Claude as untrusted context on resume/compact. Redaction remains best-effort;
turn continuity off to revoke consent and delete the cached checkpoint.
