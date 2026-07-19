# Vibe security checklist

Use this checklist to review common missing guards in rapidly built web and SaaS applications. Adapt checks to the stack and record a coverage status for every applicable section.

## Contents

1. Object-level authorization
2. Data-layer exposure
3. Client-side authority
4. Resource and spend limits
5. Tokens and sessions
6. Policy correctness and writable authorization data
7. Object storage and signed URLs
8. Pre-auth paid and sensitive flows
9. Server-side request forgery
10. AI and tool-use boundaries
11. Secrets and production configuration
12. Input, injection, and browser boundaries
13. Payments, webhooks, and business logic
14. File uploads and parsing
15. Dependencies, deployment, and operations
16. Logging, privacy, and incident readiness
17. Severity rubric
18. Sources

Sections 1-10 are the launch-blocker pass derived from the two source posts, corrected and expanded into testable controls. Sections 11-16 add the surrounding baseline that commonly turns an isolated bug into a breach.

## 1. Object-level authorization

Inspect every endpoint or action that accepts an object identifier in a path, query, body, header, GraphQL variable, websocket message, or job payload.

- Enforce authorization on the server for every read and mutation; hiding UI is not a control.
- Scope database queries to both the object and the authorized tenant/user. Avoid fetching by global ID and filtering afterward.
- Cover list, search, export, bulk, attachment, history, and nested-resource endpoints, not only the detail page.
- Cover create, update, delete, restore, share, clone, and status-change operations independently.
- Check function-level authorization for admin, support, and internal routes even when no object ID is present.
- Treat sequential IDs and UUIDs the same. Unpredictable identifiers reduce guessing but do not authorize access.
- Test with user A's valid session and user B's object ID in a different tenant. Expect a non-disclosing denial and no side effect.

Common evidence: an ORM lookup by request-supplied ID with no owner/tenant predicate; a shared handler whose middleware authenticates but never authorizes; exports or storage downloads that bypass the main record guard.

## 2. Data-layer exposure

Inventory every table, view, function, realtime channel, database API, Firebase collection, and storage collection reachable by a client or public SDK key.

- Confirm row/document rules are enabled for every sensitive resource and operation.
- Flag unconditional public rules such as unintended `USING (true)`, `allow read, write: if true`, or equivalent wildcard grants.
- Verify anonymous and authenticated access separately. A publishable/anonymous client key is expected on some platforms; safety must come from effective policies.
- Check server SDKs and admin/service credentials that bypass client security rules. Keep them on trusted servers with least privilege.
- Review views, functions, security-definer code, realtime subscriptions, and generated APIs for bypasses.
- Commit and test policy definitions where the platform supports it; do not rely only on undocumented dashboard state.
- Test direct data API access without the application UI.

## 3. Client-side authority

Treat every browser/mobile value, hidden field, local-storage entry, feature flag, and client claim as attacker-controlled.

- Derive prices, product IDs, discounts, quotas, entitlements, roles, ownership, and workflow transitions from server-side records.
- Validate allowed state transitions on the server; do not accept `isAdmin`, `paid`, `ownerId`, `tenantId`, or similar authority fields from a client.
- Use allowlisted update DTOs to prevent mass assignment of protected fields.
- Verify payment completion from the provider, not a redirect query parameter or client callback.
- Keep authorization checks at the side-effect boundary even if middleware or the UI already checked.
- Test by replaying a local request with price, plan, role, owner, tenant, quantity, and status values altered.

## 4. Resource and spend limits

Inventory endpoints that consume paid APIs, CPU/GPU, memory, database work, storage, bandwidth, queue capacity, or fan-out.

- Apply endpoint-specific limits by authenticated principal and, where appropriate, IP, device, tenant, or API key. No single dimension is sufficient for every threat.
- Add hard per-user/per-tenant quotas and provider or application-wide spend caps. Alerts alone do not cap loss.
- Bound request bodies, uploads, page sizes, query complexity, batch sizes, concurrency, execution time, retries, and response sizes.
- Prevent unbounded GraphQL batching, recursive expansion, regex work, archive extraction, and image/document processing.
- Make expensive jobs idempotent and resistant to retry storms.
- Fail closed before the paid side effect when quota state is unavailable.
- Test the boundary, reset behavior, concurrency, and alternate routes to the same operation without making real paid calls.

## 5. Tokens and sessions

Prefer mature authentication libraries and hosted identity systems, while still validating their integration.

- Verify token signature/MAC with an explicit algorithm policy; reject unsigned or unexpected algorithms.
- Validate issuer, audience, expiry, not-before, subject, and token purpose. Do not accept an access token where an ID, reset, email-verification, or refresh token is expected.
- Keep signing keys and privileged tokens out of clients. Rotate exposed credentials and assume repository history or built artifacts may retain them.
- Use short-lived access tokens, protected refresh tokens, rotation/reuse detection where supported, logout invalidation, and revocation for high-risk events.
- Protect cookie sessions with `Secure`, `HttpOnly`, and an appropriate `SameSite` policy; add CSRF defenses to cookie-authenticated state changes.
- Regenerate session identifiers after login or privilege changes; prevent fixation and cross-tenant session confusion.
- Make reset and verification tokens random, single-use, short-lived, rate-limited, and bound to the intended account/action without leaking account existence.
- Review OAuth/OIDC redirect URI validation, `state`, nonce, and PKCE as applicable.

## 6. Policy correctness and writable authorization data

An enabled RLS/rules engine is not proof that its policies are safe.

- Write an explicit access matrix for anonymous, user, tenant member, owner, admin, and service roles across select/insert/update/delete.
- Check both visibility predicates (`USING` or equivalent) and write predicates (`WITH CHECK` or equivalent).
- Do not base authorization on owner, role, tenant, email, approval, or plan fields the same user can modify.
- Inspect policies that join or call another table/view/function. The dependency must be protected and evaluated with the intended execution identity.
- Remember that permissive policies can combine with OR semantics; one broad grant can defeat a narrow policy.
- Review default privileges, new-table behavior, views, RPC/functions, triggers, and service-role clients.
- Prevent users from choosing a tenant/owner during insert unless membership is independently verified.
- Add negative policy tests for anonymous, cross-user, cross-tenant, privilege escalation, and every mutation type.

## 7. Object storage and signed URLs

Classify each bucket/container and object prefix as intentionally public or private.

- For private data, deny anonymous list, read, write, overwrite, and delete. Verify both bucket policy and per-object ACL/rules.
- Separate public assets from private uploads instead of relying on unguessable names in one public bucket.
- Authorize before issuing a signed URL; bind it to the exact object/action, keep expiry short, and avoid signing user-supplied arbitrary keys.
- Ensure list/search APIs apply the same tenant and ownership checks as downloads.
- Use generated storage keys and prevent path traversal, prefix escape, overwrite, and cross-tenant key selection.
- Review CDN/cache behavior so authenticated responses or signed URLs are not cached publicly.
- Test anonymous enumeration, a known private object URL, cross-tenant access, upload, overwrite, and deletion.

## 8. Pre-auth paid and sensitive flows

Map everything callable before login or before email/phone/payment verification: signup, login, password reset, OTP, invite, contact, demo, image generation, URL preview, search, and trials.

- Rate-limit by multiple abuse signals as appropriate; per-user limits do not help before login or when accounts are cheap.
- Add global and provider-side caps for email, SMS, AI, scraping, enrichment, and other metered services.
- Prevent account farming with verified contact methods, delayed grants, human challenges, device/risk checks, or business-specific controls.
- Make authentication errors non-enumerating while preserving useful internal logs.
- Limit resend, reset, OTP guesses, invite creation, referral rewards, trial credits, reservations, and promotional redemptions.
- Place cheap validation and abuse checks before paid work.
- Test limits without sending real messages or consuming paid credits.

## 9. Server-side request forgery

Find every server-side URL consumer: import-by-URL, unfurl/preview, avatar/image fetch, screenshot/PDF generation, webhook tester, proxy, feed reader, redirect checker, and AI/browser tool.

- Prefer a narrow allowlist of required schemes, hosts, ports, and paths. Reject userinfo and ambiguous/malformed URL forms.
- Resolve DNS and block loopback, private, link-local, multicast, reserved, and cloud metadata destinations for every address family.
- Revalidate every redirect and protect against DNS rebinding; parsing a hostname once is insufficient.
- Apply outbound network/egress controls so application validation is not the only barrier.
- Do not forward ambient credentials or arbitrary request headers. Use a minimal HTTP client identity.
- Bound connection/read timeouts, redirects, response bytes, decompression, and content types.
- Isolate browser/rendering workers and deny access to internal networks and file schemes.
- Test only against controlled local fixtures unless deployed testing is explicitly authorized.

## 10. AI and tool-use boundaries

Treat user prompts, retrieved documents, web pages, emails, tool output, and model output as untrusted data.

- Test direct and indirect prompt injection; do not treat a successful refusal to one phrase as proof of safety.
- Never rely on the system prompt to enforce authorization, confidentiality, financial limits, or destructive-action policy.
- Authorize every tool call server-side using the authenticated user and target object. Do not trust model-generated user IDs, tenant IDs, roles, or scopes.
- Give model tools least-privilege credentials and a narrow allowlist of actions and parameters.
- Require deterministic validation and human confirmation for destructive, external-communication, financial, permission-changing, or privacy-sensitive actions.
- Keep secrets out of prompts, retrieval corpora, model-visible logs, and tool results. Assume system prompts can be exposed.
- Apply tenant/document ACLs before retrieval; prevent cross-tenant vector search and poisoning of shared knowledge sources.
- Validate model output before placing it in HTML/Markdown, SQL, shell commands, URLs, templates, or downstream APIs.
- Defend rendered Markdown/HTML against exfiltration links, active content, and unsafe URL schemes.
- Add input/output limits, per-user quotas, global spend caps, audit logs, and regression evals for tool misuse and data disclosure.

## 11. Secrets and production configuration

- Search source, tracked environment files, fixtures, logs, generated assets, mobile bundles, source maps, and CI configuration for credentials and private keys.
- Distinguish intentionally publishable client identifiers from secrets; never assume an environment variable is server-only because of its name.
- Confirm privileged database, auth, cloud, payment, and AI keys cannot enter a client bundle.
- Use separate least-privilege credentials per environment and service. Document rotation and revocation.
- Treat a committed live secret as an incident: revoke/rotate first, then remove it from current code and consider history exposure.
- Disable debug mode, verbose errors, test accounts, seed credentials, development auth bypasses, and diagnostic/admin endpoints in production.
- Restrict database, cache, queue, metrics, admin, and internal service network exposure.
- Review CORS, trusted proxies, host handling, TLS, and production security headers.

## 12. Input, injection, and browser boundaries

- Validate type, length, range, format, and business meaning on the server at every untrusted boundary.
- Use parameterized database APIs; inspect raw SQL, dynamic filters/order clauses, NoSQL operators, and search syntax.
- Avoid shell execution with user input. If unavoidable, use argument arrays and strict allowlists; never build a command string.
- Prevent path traversal and unsafe archive extraction; constrain file access to a canonical root.
- Encode output for its HTML, attribute, JavaScript, CSS, URL, and template context. Sanitize allowed rich HTML with a maintained library.
- Add CSRF protection to cookie-authenticated state changes and validate origins for high-risk requests.
- Configure CORS with exact trusted origins; never combine wildcard origins with credentials.
- Validate redirects and callback URLs against a strict allowlist.
- Apply an appropriate CSP plus HSTS, `nosniff`, frame protections, and referrer policy as defense in depth.
- Avoid exposing stack traces, queries, filesystem paths, secrets, or internal service details in client errors.

## 13. Payments, webhooks, and business logic

- Resolve price and entitlement from server-side catalog data; allowlist provider price/product IDs.
- Verify webhook signatures against the raw request body, reject stale/replayed events, and store event IDs for idempotency.
- Grant paid access from verified provider state, not a success-page redirect.
- Enforce quantity, inventory, discount, refund, credit, coupon, referral, and trial rules transactionally on the server.
- Protect against double-spend and race conditions with database constraints, atomic updates, idempotency keys, or locks as appropriate.
- Authenticate outbound webhook configuration and prove destination ownership for sensitive payloads.
- Keep webhook and integration secrets scoped, rotatable, and out of logs.
- Test duplicate, reordered, delayed, forged, and partially failed events locally.

## 14. File uploads and parsing

- Allow only required file types; verify extension, detected type, and file signature rather than trusting the client Content-Type.
- Bound file count, individual and aggregate size, image dimensions, archive expansion, parser time, and storage use.
- Generate filenames/keys and store uploads outside executable web roots or on isolated object storage.
- Prevent overwrite, traversal, active content, polyglots, archive bombs, and parser-driven SSRF/XXE.
- Scan or sandbox risky formats when the threat model warrants it; keep parsers and image/document libraries updated.
- Authorize upload, processing status, download, replacement, and deletion independently.
- Serve downloads with safe content type, disposition, `nosniff`, and a restrictive content policy.
- Remove metadata or active content when users expect a transformed safe asset.

## 15. Dependencies, deployment, and operations

- Require a lockfile and review existing dependency-audit output, advisories, abandoned packages, and unnecessary high-risk dependencies.
- Pin CI actions and deployment inputs appropriately; protect release credentials from untrusted forks and pull requests.
- Review install/build scripts, generated code, container base images, infrastructure modules, and runtime plugins.
- Run services as non-root with least-privilege filesystem, IAM, database, network, and cloud permissions.
- Separate development, preview, staging, and production data and credentials.
- Ensure migrations preserve authorization controls and new tables/resources inherit a deny-by-default posture.
- Verify backups are encrypted, access-controlled, retention-limited, and restore-tested.
- Configure health checks, timeouts, safe retries, rollback, dependency update ownership, and vulnerability response.

## 16. Logging, privacy, and incident readiness

- Log authentication failures, authorization denials, admin actions, credential changes, payment/webhook decisions, policy changes, and security-control failures with useful correlation IDs.
- Never log passwords, session tokens, authorization headers, reset links, signing keys, full payment data, or unnecessary personal/model context.
- Prevent log injection and keep logs out of public storage and client responses.
- Alert on abuse, cost spikes, repeated denials, anomalous admin behavior, and secret use where supported.
- Restrict and audit log access; define retention and deletion consistent with data minimization.
- Return generic client errors while preserving redacted diagnostic detail internally.
- Document contacts and steps for credential rotation, data exposure, provider abuse, and rollback.

## 17. Severity rubric

Adjust severity for reachability, data sensitivity, privileges, blast radius, and compensating controls.

- **Critical**: unauthenticated remote code execution; broad authentication/admin bypass; public write or mass exposure of highly sensitive production data; live privileged secret with immediate broad compromise.
- **High**: cross-tenant sensitive read/write; exploitable privilege escalation; private storage exposure; payment/entitlement tampering; SSRF reaching credentials/internal control planes; AI tool path that can perform unauthorized high-impact actions.
- **Medium**: meaningful exploit requiring constraints or user interaction; stored XSS; CSRF on a sensitive action; unbounded paid endpoint with a practical cost/availability impact; webhook or session weakness with limited reach.
- **Low**: defense-in-depth gap or low-impact information exposure with no demonstrated sensitive action.

Do not inflate a hypothetical issue. Lower confidence or mark a manual follow-up when runtime configuration or reachability is unknown.

## 18. Sources

The launch-blocker framing originated in these two Reddit posts by AggravatingCounter84:

- [Security holes I find in almost every vibecoded app](https://www.reddit.com/r/SaaS/comments/1uoko0q/security_holes_i_find_in_almost_every_vibecoded/)
- [Security holes I find in every vibecoded app - part 2](https://www.reddit.com/r/SaaS/comments/1up6l62/security_holes_i_find_in_every_vibecoded_app_part/)

The corrected controls and broader baseline draw on primary security and platform guidance:

- [OWASP API Security Top 10: Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)
- [OWASP API Security Top 10: Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/)
- [OWASP API Security Top 10: Unrestricted Access to Sensitive Business Flows](https://owasp.org/API-Security/editions/2023/en/0xa6-unrestricted-access-to-sensitive-business-flows/)
- [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
- [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)
- [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [OWASP Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OWASP LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Firebase Security Rules](https://firebase.google.com/docs/rules)
- [Amazon S3 security best practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
