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
to either the local `claude` CLI or the Anthropic API. Common credential formats
are redacted, but redaction is not a complete data-loss-prevention system.
Users should not scan or enable autopilot for material they are unwilling to
send to the configured model.

Generated artifacts require explicit approval. Hooks are installed into local
Claude settings and require private per-project consent where applicable.
Gradient does not store `ANTHROPIC_API_KEY`.
