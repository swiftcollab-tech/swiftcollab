# SwiftCollab Production Foundation Backlog

This backlog is the delivery order for turning SwiftCollab from a pilot into a
multi-tenant B2B product. No customer data or live write actions should be
handled at production scale until Phase 1 is complete.

## Phase 0 — Stabilize the pilot

- [ ] Make every assistant, connection, and execution request authenticated.
- [ ] Remove the shared `default` integration identity from production paths.
- [ ] Make every write action require an explicit confirmation and create a
      durable audit record.
- [ ] Make Redis and Temporal required in staging and production.
- [ ] Replace startup schema creation with versioned database migrations.
- [ ] Create a regression suite for login, OAuth connection, Gmail draft/send,
      approvals, retries, and idempotency.

## Phase 1 — Identity and tenant isolation

- [ ] Add `organizations`, `organization_members`, and role-based access
      control (`owner`, `admin`, `member`, `viewer`).
- [ ] Add `organization_id` to every customer-owned record and enforce it in
      every query. Use PostgreSQL row-level security where the deployment model
      supports it.
- [ ] Bind each external connection to both an organization and a user.
- [ ] Require a production JWT secret; never use a fallback secret.
- [ ] Hash and rotate refresh tokens; add CSRF protection to cookie endpoints.
- [ ] Move login and API rate limiting to Redis.
- [ ] Deliver reset-password emails; never expose reset tokens in responses.

## Phase 2 — Reliable integrations

- [ ] Route integrations through the vendor-neutral provider contract.
- [ ] Keep Composio as the broad-coverage provider.
- [ ] Implement direct Google Workspace OAuth as the first alternative
      provider, using authorization-code flow, PKCE, state validation, and
      encrypted refresh-token storage.
- [ ] Store only provider connection references in workflow payloads and logs;
      never log OAuth tokens or API secrets.
- [ ] Add connection health checks, reconnect UX, webhook verification, and
      provider-specific error handling.

## Phase 3 — Durable workflows and AI safety

- [ ] Run all multi-step or write workflows through Temporal; no direct write
      fallback in production.
- [ ] Use an outbox pattern for outbound events and notifications.
- [ ] Enforce idempotency keys, step-level retry policies, and compensating
      actions where possible.
- [ ] Add per-organization spend limits, model routing, prompt/version logs,
      and human approval policies.
- [ ] Build permission-aware retrieval before adding broad RAG search.

## Phase 4 — Verification and release readiness

- [ ] CI: lint, unit tests, API integration tests, browser E2E tests, and
      dependency/security scans on every pull request.
- [ ] Staging environment with separate OAuth clients, database, Redis, and
      test accounts.
- [ ] Load-test realistic workflows and concurrency before each scale increase.
- [ ] Add structured logs, error tracking, metrics, tracing, backups, restore
      drills, incident runbooks, data retention, and deletion workflows.

## Deployment gate

Production deployment is considered only after Phase 1, the critical parts of
Phase 2, and the Phase 4 release checks are complete.
