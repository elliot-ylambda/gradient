# Gate measurements

The scripts that decided whether a planned feature got built. Each is
self-contained, reads only local transcripts under `~/.claude/projects`, writes
nothing, and prints the numbers quoted in
[the dogfood log](../2026-07-30-gradient-dogfood-log.md).

They are kept because a verdict without its measurement is just an opinion with
a date on it — and because both of these will need re-running if the corpus
changes shape.

| Script | Question | Verdict |
| --- | --- | --- |
| `gate-3.4-collision.mjs` | When two sessions run concurrently in one directory, do they edit the same file? | 6 distinct files ever, 2 of them `MEMORY.md`. Not built. |
| `gate-3.3-context.mjs` | What actually consumes the context in sessions that compact? | Diffuse — median 26% for the largest source, 2/78 sessions above 40%. Not built. |

## Two traps both scripts exist to avoid

**Replay inflation.** A resumed session inherits its parent's events verbatim,
timestamps included, so a fork and its parent look like two agents doing the same
thing in the same millisecond. `gate-3.4` counts a pair as one lineage when half
its `(timestamp, file)` edit events are byte-identical. Skipping that step
reported 82 collisions instead of 6. This bug has now been found three times
(F13, F20, and here); assume it is present in any cross-session count until the
dedupe is written.

**Characters are not tokens.** `gate-3.3` measures growth in
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` between
consecutive assistant turns, not in the size of the tool output text. Measured in
characters, base64 images dominate everything — the first pass reported `*.png`
as 45% of all context in compacted sessions, and it vanished from the table
entirely once measured in tokens.

Run either directly; both take a couple of minutes over ~2,000 sessions:

```sh
node docs/superpowers/plans/measurements/gate-3.4-collision.mjs
node docs/superpowers/plans/measurements/gate-3.3-context.mjs
```
