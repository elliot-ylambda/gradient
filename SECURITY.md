# Security policy

## Supported versions

Only the latest published release receives security fixes. Upgrade to `0.3.1`
or newer: `0.1.0` has known isolation and installed-entrypoint defects; the
unpublished `0.2.x`/`0.3.0` development line lacks the complete cross-target
filesystem, process-isolation, approval, clarification, attention-mining, and
notification hardening present in `0.3.1`.

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Email
`contact@ylambda.com` with the affected version, a synthetic reproduction, the
impact you believe is possible, and whether you want public credit.

Do not include real credentials, private transcripts, or customer data.

## Security boundaries

Gradient reads enabled local Claude Code and Codex transcript data and can send
bounded excerpts to a trusted local `claude`/`codex` CLI or the Anthropic API.
Codex subagent rollouts are excluded. Project-only preference mining can include
bounded assistant questions. Common credential and PII formats are redacted,
but redaction is not a complete data-loss-prevention system. Users should not
scan or enable autopilot for material they are unwilling to send to the
configured model.

Local model CLIs are resolved from the user's `PATH` and are part of the trusted
computing base. Do not run Gradient with a project-controlled or otherwise
untrusted `claude`, `codex`, `node`, or `git` executable on `PATH`. Explicitly
pinned Gradient backends fail closed when unavailable rather than switching
providers.

Transcript discovery, per-file and aggregate reads, parsed prompts, LLM
candidates, configuration, settings, caches, playbooks, and logs have hard
resource ceilings. User ignore patterns are restricted to a small
linear-looking regex subset. Paid autopilot attempts default to 10 and have an
absolute ceiling of 100 per session; repository configuration can only lower
that authority and budget.

Headless classifier children run in fresh private directories and receive
prompt data over stdin. Claude tools/customizations and Codex tools, apps,
plugins, hooks, browsing, project documents, rules, multi-agent features, and
session persistence are disabled. Codex also uses a read-only sandbox and
strict configuration; classifier calls have an absolute timeout and bounded
output. If an installed CLI does not support the required isolation flags, the
call fails and Gradient degrades to local advisory suggestions.

Generated artifacts require explicit approval. Claude and Codex writes reject
symlinked ancestors and untracked or incorrectly marked destinations. Hooks are installed into local
Claude settings and require private per-project consent where applicable.
Observed behavior is not treated as authorization: paste/sequence artifacts are
advisory, preference rules exclude consequential approvals, and arbitrary model
content is not written into artifacts. Clarification option bodies are rebuilt
locally from bounded labels and unresolved flagged suggestions cannot be
approved. Attention mining uses bounded, no-follow reads; desktop notification
hooks use only static text and absolute operating-system notifier paths.
Gradient does not store
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

These controls reduce known risks; they are not a guarantee that arbitrary
transcript text is non-sensitive or that a reviewed generated workflow is safe
for every future use. Keep packages current, inspect every review preview and
bundle, and retain normal human confirmation for consequential actions.
