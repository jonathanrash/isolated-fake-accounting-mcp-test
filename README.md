# Isolated fake accounting MCP test

**Simulation only. Not production-ready. No live company data, credentials, accounting API, Intuit endpoint, payments, or external runtime calls.** Every vendor, invoice, company and amount is an invented public fixture. Do not enter any real or confidential data.

This small Node.js service uses the official `@modelcontextprotocol/sdk` (pinned 1.32.0) and Zod (pinned 4.6.5). The lockfile pins their transitive dependencies. It implements stateless MCP Streamable HTTP in JSON-response mode, using a new SDK server/transport per request and a shared, bounded, **in-memory fake ledger** per process.

## Start and verify

Node.js 22–24 is required; local verification used Node 24.19.0.

```sh
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm audit --omit=dev
npm start
```

- Default endpoint: `http://127.0.0.1:3337/mcp`
- Health: `http://127.0.0.1:3337/health`
- Set `PORT` to change the port
- Local binding is 127.0.0.1 by default
- `GET /mcp` returns HTTP 405 by design: this stateless service has no unsolicited SSE stream
- `POST /mcp` supports initialization, notifications, discovery and tool calls through the SDK
- There is no legacy SSE endpoint, OAuth, account creation or credential storage

```sh
# Start a separate temporary local instance, exercise it, and print synthetic evidence:
node scripts/demo.js > demo-activity.json

# Exercise an already authorized test endpoint (never point this at real accounting):
node scripts/demo.js http://127.0.0.1:3337/mcp
```

The demo verifies a read, wrong-company rejection, missing approval, changed-payload conflict, pre-commit failure and retry, successful commit, exact replay, ambiguous post-commit failure, reconciliation, and exactly two fake expenses. It runs 17 calls on a fresh instance. The program closes its temporary instance when finished. A repeat against an already-used endpoint skips first-commit fault injection; use a fresh instance to retest those fault branches.

## The nine tools

| Tool | Effects |
|---|---|
| `test_status` | Reads limitations, instance ID and public mock fixtures |
| `list_fake_vendors` | Reads one company's invented vendors |
| `list_fake_invoices` | Reads one company's invented invoices |
| `get_fake_invoice` | Reads one invoice and checks company ownership |
| `prepare_simulated_expense` | Creates a fake in-memory draft; marked mutating |
| `commit_simulated_expense` | Commits a fake in-memory expense; marked mutating |
| `reconcile_operation` | Reads the current instance's operation outcome |
| `list_simulated_expenses` | Reads one company's fake expenses |
| `get_test_activity` | Reads the bounded sanitized activity log |

All tools are closed-world. Both mutating tools are annotated `readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: true`. Annotations are hints to clients, **not enforcement of an actual human approval UI**. The client must separately require confirmation for mutations.

Every tool schema rejects unknown fields. `approved=true`, arbitrary amounts, caller-supplied vendor changes, URLs and credentials are not inputs. Amount, vendor, invoice number and currency are derived from fixed invoices, never supplied by the model.

## Fake fixtures and approvals

Only the exact server-side allowlisted companies `fake-company-a` and `fake-company-b` exist. Nonfake IDs and cross-company invoice/draft operations are rejected. There is no configurable live-company fallback.

| Fake invoice | Company | Amount (minor units) | Category | Operation | Public mock fixture |
|---|---|---:|---|---|---|
| `fake-invoice-a-001` | `fake-company-a` | 12345 USD | `test-office` | `demo-approved-a` | `public-mock-approval-a-v1` |
| `fake-invoice-a-002` | `fake-company-a` | 6789 USD | `test-materials` | `demo-ambiguous-a` | `public-mock-approval-ambiguous-a-v1` |
| `fake-invoice-b-001` | `fake-company-b` | 23456 USD | `test-office` | `demo-approved-b` | `public-mock-approval-b-v1` |

**These IDs are deliberately public test fixtures. They are not secrets, authorization credentials, evidence of a person's approval, or a security boundary.** A model can read them from `test_status`. Their only role is to test that commit logic requires a server-known fixture bound to the exact company, operation, draft, canonical payload hash, invoice and amount. Missing or mismatched fixtures reject. No MCP tool or HTTP route can mint a mock approval, and no model-controlled Boolean can grant approval.

The automated test harness can also mint ephemeral local mock grants directly on its isolated in-process store for expiry and mismatch tests. That method is not exposed over the network. The service has no operator HTTP/Unix interface and requires no operator credential. `MOCK_APPROVAL_FIXTURES=disabled` disables public fixtures, leaving remote commits unavailable. Neither grant mechanism tests a real human approval.

## Idempotency and fault behavior

An operation is scoped by company and operation ID. Preparation replays an identical canonical payload; changed payload conflicts. Commit verifies the mock fixture and returns the original receipt on identical replay. A second operation cannot commit an invoice already committed in that running instance. Commit is synchronous between verification and mutation, avoiding an interleaving duplicate inside this one process; 20 concurrent identical client calls produce one mutation and 19 replays in tests.

`fault: before_commit` simulates failure before mutation, with no expense and no consumed grant. Reconcile first, then retry the same operation with `fault: none`.

`fault: after_commit` simulates an acknowledgment lost after mutation. The tool returns an ambiguous error; reconcile the **same operation ID**, then replay only that original operation if needed. The example is a semantic fault simulation, not a real dropped TCP connection or real upstream API timeout.

## State, logging and security limits

- All drafts, receipts, mock grants and activity are ephemeral; restart/spin-down clears them and changes `instance_id`
- Reconciliation `not_found` means absent **in this running instance**, not proof that a previous instance never committed
- This is one public shared test instance; concurrent testers can consume the same fake invoice fixtures
- Maximum 1,000 prepared operations, 1,000 recent activity entries and 100 returned activity entries per lookup
- Repeated requests and fault injection can grow only bounded state; there is no production rate limiting
- Activity records state transitions and sanitized tool outcomes: fixed known tool name (or `unknown_tool`), exact allowlisted company (or null), success/rejected and fixed error code
- Raw request bodies, headers, arbitrary IDs, invalid company values, URL fields and invalid payloads are never stored in activity. Global unscoped rejection/status events appear with each company's log
- Reading `get_test_activity` adds its own tool-call event after the returned snapshot; the snapshot cannot contain that same call's outcome yet
- All tool results include `instance_id`, including SDK schema/unknown-tool errors
- Host and Origin allowlists, 16 KiB MCP bodies, strict schemas, timeouts and loopback default are tested. Missing Origin is allowed for native/server MCP clients
- Public transport is deliberately unauthenticated because only public synthetic state exists. Do not reuse this design for real data or authentication
- No persistence, signed approvals, real user identity, multi-process coordination, durable audit proof, upstream QBO behavior or production exactly-once guarantee is provided

## Prepared Render deployment, not deployed

`render.yaml` describes one **Free** Node web service, `npm ci --ignore-scripts`, `npm start`, `/health`, and disabled automatic deploys. Render supplies `PORT` and `RENDER_EXTERNAL_HOSTNAME`; `HOST=0.0.0.0` is allowed only when a valid public hostname is configured. No database, disk, paid add-on, new secret, or outbound accounting connection is required.

Deployment, repository publication, provider sign-in, account terms and any security approval are separate operator actions. This package does not perform them. Keep the live Bookkeeping agent unchanged; use only the isolated test copy and existing authorized test audience. See `CLIENT_ACCEPTANCE.md` for staged prompts and evidence criteria.

As checked in official Render docs on 2026-10-04, Free web services can sleep after 15 idle minutes and lose local state on restart/spin-down. They have no shell/one-off jobs, so hosted tests use pre-seeded public fixtures. Free-plan usage limits still apply, and accounts with payment methods can incur bandwidth/build overages. The owner must review current pricing, usage caps and account settings before deployment; this repository does not guarantee a zero bill.

## Publication boundary

Only files in `publication-allowlist.json` may be copied into a new public repository. Use:

```sh
npm run package:release
```

This creates a new local `release/` directory with only explicit synthetic source, tests, public docs, scripts and lock/config files, plus SHA-256 hashes. The command refuses to overwrite an existing release directory. Do not publish the working directory wholesale. `evidence/`, client setup records, `.env`, logs and `node_modules/` are excluded. Nothing in `evidence/` is approved for publication.

## Verification scope

The local suite covers official-SDK MCP initialization/discovery, fixture reads, strict validation, company isolation, mock approval mismatch/expiry, fake mutation, replay/conflict/duplicate defense, 20-way concurrent replay, both synthetic fault stages, reconciliation, restart, Origin/Host rejection, malformed/oversized HTTP, and sanitized audit outcomes. `npm run test:coverage` reports coverage of loaded library modules, not proof against every possible defect. No production-readiness claim is made.

Actual client confirmation dialogs, denial handling, client reasoning, real deployment/TLS/cold starts, account permissions and Workspace Agent publication have **not** been tested by these local tests. Those results must be collected separately, never inferred from the fake server's mock approval.

## Official references

- [Official MCP TypeScript SDK server guide](https://ts.sdk.modelcontextprotocol.io/server)
- [MCP Streamable HTTP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render Node version selection](https://render.com/docs/node-version)
- [Render Free service limitations](https://render.com/docs/free)
