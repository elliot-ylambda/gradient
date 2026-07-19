---
name: vibe-security-check
description: Audit web and SaaS applications for common security footguns in rapidly built or AI-generated ("vibe-coded") code. Use for pre-launch security checks, app security reviews, tenant-isolation audits, or requests to inspect auth, RLS, storage, payments, rate limits, SSRF, JWTs, uploads, webhooks, and AI tool use. Produce an evidence-backed defensive report; do not use for offensive testing or compliance certification.
---

# Vibe Security Check

Audit an authorized application from the attacker-facing boundaries inward. Find missing guards around working features, verify findings with safe evidence, and leave the user with a prioritized remediation plan.

## Guardrails

- Treat the checked-out repository as authorized for read-only review and local, non-destructive tests.
- Get explicit authorization before sending crafted requests to a deployed environment, testing accounts that are not the user's, or touching third-party infrastructure.
- Default to review-only. Do not edit application code or configuration unless the user also asks for fixes.
- Never print a complete secret, token, credential, private record, or sensitive log line. Redact values and report only the file and line needed to rotate or remove them.
- Avoid real paid API calls, emails, SMS messages, purchases, destructive actions, and irreversible state changes. Use mocks, emulators, fixtures, or local services.
- Follow repository instructions and preserve unrelated work. Do not install scanners or dependencies without permission.
- Describe this as a focused security review, not a penetration test, guarantee, or compliance certification.

## Choose the depth

- Use a **comprehensive check** by default. Cover every applicable section in [references/checklist.md](references/checklist.md).
- Use the **launch-blocker pass** only when the user asks for a quick, ten-minute, or source-post-only check. Cover checklist sections 1-10 and explicitly list the broader sections as not reviewed.
- If the application handles regulated, financial, health, identity, child, or other high-impact data, recommend a qualified independent security review in addition to this check.

## Audit workflow

### 1. Establish scope

1. Read repository instructions and inspect the working-tree state.
2. Identify the languages, frameworks, deployment configuration, and test commands.
3. Inventory trust boundaries: clients, APIs, databases, auth providers, storage, queues, webhooks, admin surfaces, paid services, URL fetchers, file parsers, and AI models or tools.
4. Identify protected assets and roles: anonymous users, normal users, tenant members, owners, support staff, admins, service accounts, and background jobs.
5. Ask only for material facts that cannot be discovered, such as whether a bucket is intentionally public or whether safe staging credentials are available. Continue with static review while waiting.

### 2. Trace controls, not keywords

Read [references/checklist.md](references/checklist.md) before the substantive review. Start at route registration, middleware, schemas, migrations, authorization policies, storage rules, environment templates, and infrastructure configuration. Then trace each sensitive action end to end:

`untrusted input -> authentication -> authorization -> validation -> side effect -> response/log`

Searches are leads, not findings. Confirm which code is reachable, whether a shared guard actually covers the route, and whether a later layer bypasses it. Treat client code as attacker-controlled.

### 3. Verify safely

- Run relevant existing tests, linters, type checks, and already-configured security or dependency checks.
- Prefer existing lockfile-aware audit commands. Do not upgrade packages or mutate lockfiles during review.
- Use local tests or emulators for negative cases. When practical, test with two ordinary users in different tenants plus one privileged user.
- Exercise read, create, update, delete, bulk, export, search, websocket, background-job, and file paths separately; a guard on one operation proves nothing about another.
- For database or storage policies, test the effective anonymous, authenticated, cross-tenant, owner, and service-role behavior. Do not infer dashboard state that is absent from the repository.
- If runtime verification is unavailable, say exactly what remains unverified and give the user a safe manual test.

### 4. Record coverage

Assign one status to every applicable checklist area:

- **Finding**: direct evidence shows a security weakness.
- **Verified control**: a negative test or equivalent evidence demonstrates the control.
- **No issue found**: reviewed evidence did not reveal a problem, but no decisive runtime test was available.
- **Not verified**: required code, environment state, credentials, or runtime access was unavailable.
- **Not applicable**: the feature or trust boundary does not exist.

Never convert “no matching text found” into “verified control.” Never say the application is secure because no findings were confirmed.

## Report format

Lead with the outcome, then provide:

1. **Executive summary** — confirmed finding counts by severity, the highest-risk themes, and review limitations.
2. **Attack-surface map** — the stack and sensitive boundaries actually reviewed.
3. **Findings** — sorted by severity, each with:
   - stable ID and concise title
   - severity: critical, high, medium, or low
   - confidence: confirmed, high, medium, or low
   - affected file and line, route, policy, or resource
   - evidence and reachable abuse case
   - likely impact
   - smallest safe remediation
   - regression test or verification steps
4. **Coverage table** — one row per checklist section with its status and evidence.
5. **Manual follow-ups** — dashboard, cloud, DNS, billing-cap, credential-rotation, or deployed-header checks that source review could not establish.

Use the severity rubric in the checklist. Keep evidence reproducible and redact sensitive values. Consolidate repeated instances with the same root cause while listing all affected locations.

## Fix mode

When the user asks to remediate findings:

1. Start with confirmed critical and high findings.
2. Add a failing regression test or policy test before the fix when the repository supports it.
3. Make the smallest server-side or policy-layer change that closes the abuse case.
4. Re-run the exploit-shaped negative test and the relevant normal-flow tests.
5. Do not weaken a control merely to make a test pass. Document any finding that needs an infrastructure or credential change outside the repository.
