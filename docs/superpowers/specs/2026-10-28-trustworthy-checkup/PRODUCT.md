# A trustworthy setup checkup

## Summary

Gradient checks the local instructions, skills, and observed habits used with
Claude Code and Codex. Its primary job is to show a small set of concrete setup
problems with evidence, let the user choose a fix, and make the result verifiable
and reversible. This implements the October 28 request to fix the product audit
and keep Gradient simple.

## Behavior

1. The main journey is check → inspect evidence → choose a fix → verify → undo.
   The existing report and `optimize` entry points remain. There is no account,
   daemon, model call, or network requirement for this journey.
2. Findings distinguish changes Gradient can apply from observations requiring
   judgment. Each explains the evidence and affected assistant. The page and JSON
   agree. An observation never offers an Apply action or reports a successful
   no-op; passing its ID explicitly produces a clear explanation.
3. A user can dismiss any finding. It remains dismissed while its evidence is
   unchanged, including during scheduled runs. Materially changed evidence may
   raise it again. Unknown IDs and stale changes are explained.
4. Observed usage comes from actual events. Missing or bounded history is never
   proof that a skill has never been used. Automatic and scheduled checks only propose changes; the legacy `--auto`
   flag no longer applies repairs. Gradient never automatically deletes a skill. Removal remains an explicit user decision, limited to owned files.
5. Applying a workflow records its files and supporting state. Undo reverses
   those writes, including generated skills, rules, hooks, and bookkeeping.
   A later user edit is preserved and reported as a conflict. A partial target
   failure cannot silently leave a successful-looking half-installation.
   The latest ten applied runs are retained independently of ten read-only
   reports. Run IDs cannot traverse outside the private run store. Changed
   evidence invalidates a previously reviewed apply.
6. Inspection includes the advertised Codex skill installer destination and
   active Claude plugin skills. Alternate configured roots and repository
   hierarchy are respected where supported. Skipped or unsupported surfaces are
   stated; Gradient never claims it audited every assistant configuration.
7. Skill inventory and advice respect assistant-specific discovery, instruction
   precedence, current Claude AGENTS.md fallback, and documented extension keys.
   A rule in separate assistant contexts is not called duplicate context cost.
   Description characters are an inventory measure, not measured tokens saved.
8. Native features are recommended before redundant generated workflows.
   Gradient does not promise better compaction, memory, code review, permission
   policy, or generic skill creation than the assistants. Already-enabled
   features do not generate repeated enablement suggestions.
9. Optional background features remain opt-in compatibility features. Their
   current Claude hook implementation is clearly labeled; Codex-only activation
   refuses with a useful explanation rather than claiming to be running.
   This does not imply that Codex itself lacks native hooks.
10. Feature status reflects the current repository and installed hooks. Turning
    a feature off makes leftover callbacks inert. SessionEnd schedules a
    propose-only check at most daily per project; SessionStart surfaces the
    highest-priority undismissed cached finding without starting another scan.
    Legacy global optimize consent requires explicit per-project re-enablement.
    Board and report read local Git/session state only; they do not fetch GitHub
    pull requests. Historical autopilot totals and latest-session decisions are
    labeled as cross-project observations, separate from current-project consent.
11. Schedule output is valid for its platform, quotes paths, and resolves the
    actual Node and runner paths. Schedules run propose-only checks. Printing a
    schedule does not install it.
12. A skill always runs its own bundled runner, including custom installation
    destinations. An incomplete install fails clearly instead of searching for
    a stale unrelated copy. Existing commands remain compatible.
13. Homepage, README, skills, and docs describe the same scope and limitations.
    They show a reproducible illustrative check/fix/verify example, identified as
    a fixture, and avoid presenting historical transcript counts as user value.
    Installation is prominent on desktop and mobile, Node's minimum version is
    explicit, and social previews have an image.
14. Local history remains local. No real user settings, enabled features, or
    private transcript content are changed or published by the verification
    workflow. Optional model-backed features disclose that separate boundary.
    Assistant-managed memory imports remain inspectable but read-only, with
    both finding and executor guards against changes.

## Scope

Fix the confirmed audit issues in existing code; reuse the current finding,
snapshot, and packaging architecture. Do not add an agent framework, cloud
service, new automation engine, automatic prose rewriting, or speculative
productivity score. Preserve optional existing functionality while making the
checkup the primary experience.
