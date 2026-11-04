# Client 1 Agile Backlog — Direct Integration First

## Product goal

SwiftCollab helps the client coordinate work across Google Workspace, Notion,
Jira, Airtable, and Discord. It prepares actions, requires approval for writes,
executes reliably, and records who approved and what happened.

## Operating rules

- Deliver one thin, end-to-end workflow slice at a time.
- Write or update automated tests in the same change as the feature.
- Use sandbox/test accounts and test data until the client accepts the flow.
- Every external write needs explicit approval, an idempotency key, and an audit record.
- Do not use Composio for these core client workflows; build direct adapters behind the integration-provider contract.
- A story is done only when automated checks and the manual staging checklist pass.

## Definition of done

Each story includes implementation, authorization checks, input validation,
structured errors with no secret logging, tests, audit events for writes, a
manual test case, OAuth-scope documentation, and rollback behaviour.

## Release roadmap

| Release | Outcome | Client value |
|---|---|---|
| R0 — Foundation | Secure organization, user, session, and provider base | Safe customer boundary |
| R1 — Interview scheduling | Sheets → Calendar/Meet → Gmail → Sheets, with approval | Removes manual scheduling work |
| R2 — Sales follow-up | Notion/Airtable → email draft → Jira/Notion task | Faster, consistent follow-up |
| R3 — Referral routing | Discord → matching → approval → reply/log | Removes manual referral triage |
| R4 — Pilot hardening | Monitoring, staging, load/security tests, support runbooks | Controlled client rollout |

## Sprint 0 — Foundation and test environment

**Goal:** safely connect one client organization using direct Google OAuth.

| ID | Story | Acceptance criteria | Test coverage |
|---|---|---|---|
| SC-001 | Add organizations, memberships, roles, and invitations | Owner/admin/member/viewer roles; every client record belongs to an organization; owners and admins can invite people by email; invitees create or sign in to their own account and accept a time-limited invitation | Tenant-isolation, invitation, and role-permission tests |
| SC-002 | Remove shared `default` assistant identity | Assistant and connection routes reject anonymous production requests | API authentication tests |
| SC-003 | Secure sessions and tokens | No JWT fallback; hashed rotating refresh tokens; Redis rate limits | Auth/session tests |
| SC-004 | Add migration workflow | Ordered migrations; no production schema creation at startup | Fresh DB migration test |
| SC-005 | Build direct Google OAuth lifecycle | State + PKCE; encrypted token storage; reconnect/revoke | OAuth callback tests |
| SC-006 | Add test fixtures and staging configuration | Separate test OAuth client, mailbox, calendar, and Sheet | Manual smoke checklist |

**Sprint exit demo:** an organization admin connects a dedicated Google test
account, sees its status, disconnects it, and cannot access another
organization’s connection.

**SC-001 access rule:** administrators never create or know another user’s
password. Invited users sign up or sign in themselves, then accept their
time-limited organization invitation. Viewer access is read-only: viewers
cannot create, approve, edit, or send external actions.

## Sprint 1 — Mock interview scheduling: read and propose

**Goal:** read candidate assignments from a Sheet and propose a schedule. No
external writes occur yet.

| ID | Story | Acceptance criteria | Test coverage |
|---|---|---|---|
| SC-101 | Read interview rows from Google Sheets | Validate Sheet selection and map candidate/interviewer/status fields | Adapter mock tests |
| SC-102 | Check interviewer availability | Respect timezone, working hours, busy events, and duration | Calendar fixture tests |
| SC-103 | Generate scheduling proposal | Show candidate, interviewer, proposed time, and conflict reason | Planner contract tests |
| SC-104 | Show proposal review UI | User can choose, edit, or reject a proposed time | Browser E2E test |

**Sprint exit demo:** a user selects a test interview row and receives a clear,
non-writing schedule proposal.

## Sprint 2 — Mock interview scheduling: approve and execute

**Goal:** execute an approved schedule reliably.

| ID | Story | Acceptance criteria | Test coverage |
|---|---|---|---|
| SC-201 | Create approval record | Proposal is frozen and approved by an authorized user | Approval API tests |
| SC-202 | Create Calendar event and Meet link | Event is created exactly once with attendees | Idempotency + adapter tests |
| SC-203 | Send Gmail confirmations | Email uses the approved preview and correct recipients | Gmail API mock tests |
| SC-204 | Update scheduling Sheet | Row is Scheduled only after successful event/email steps | Partial-failure/retry tests |
| SC-205 | Record audit trail | Actor, approval, provider IDs, timestamps, and outcome are stored | Audit-log integration test |

**Sprint exit demo:** approve one test interview; Calendar/Meet, Gmail, Sheet,
and audit history show the expected result exactly once.

## Sprint 3 — Post-sales-call follow-up

| ID | Story | Acceptance criteria |
|---|---|---|
| SC-301 | Read selected Notion meeting notes | Only authorized workspace pages are retrieved |
| SC-302 | Retrieve Airtable customer context | Correct customer is selected; missing data is explicit |
| SC-303 | Create editable email and task preview | No send/create occurs before approval |
| SC-304 | Send email and create Jira/Notion tasks | Each approved action is idempotent and audited |

## Sprint 4 — Discord referral routing

| ID | Story | Acceptance criteria |
|---|---|---|
| SC-401 | Receive and verify Discord events | Signature/event validation; no reply loop |
| SC-402 | Match request to Airtable/Sheets/Notion data | Explain selected match and confidence |
| SC-403 | Present a proposed route and message | User can edit, approve, or reject |
| SC-404 | Post reply and log outcome | Reply and tracking update are idempotent and audited |

## Sprint 5 — Pilot hardening

- Mandatory Temporal execution for write workflows.
- Managed PostgreSQL, Redis, secrets manager, and separate staging environment.
- Error tracking, metrics, traces, alerts, dashboards, backups, and restore drills.
- Load test, security review, dependency/secrets scans, and client runbooks.

## Weekly agile cadence

1. Select only stories that fit the sprint.
2. Define acceptance examples before implementation.
3. Implement a small slice and its tests together.
4. Run automated and staging/manual tests with test data.
5. Demo the completed slice, record defects, then choose the next slice.

## Current sprint

**Sprint 0 is active.** Start with **SC-001: organizations, memberships, and
roles**. It is required before secure direct OAuth or any client workflow.
