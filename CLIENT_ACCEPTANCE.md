# Isolated client acceptance runbook

**Pending actual client testing.** Local protocol tests do not prove the Workspace Agent asks for real approval. All companies, invoices, amounts and mock fixtures below are invented public data. Never connect a live accounting app to this isolated test copy.

## Before starting

1. Deploy only after provider/account permissions and publication are authorized. Use only the allowlisted release package, the Free plan, one instance and no real credentials.
2. Connect only the isolated test agent to the verified HTTPS `/mcp` endpoint. Keep the working agent and its audience unchanged.
3. Configure the client's supported confirmation behavior to **Always ask** for both mutating tools. If that control or behavior cannot be verified, mark the human-confirmation test BLOCKED; a mock approval fixture is not a substitute.
4. Start on a fresh endpoint instance. Call `test_status`, record `instance_id`, then `list_simulated_expenses` for both companies. Both expense lists must be empty. Stop and reset if another tester already consumed fixtures.
5. Save client screenshots/call evidence privately. Do not publish client identities, agent IDs, URLs containing private IDs or chat content in the public source package.

Use the prompts below one stage at a time. Check client tool arguments and endpoint activity after each stage. Do not let one broad prompt approve every later stage.

## 1. Read and discover

Prompt: "This is a fake-data-only test. Call test_status, list_fake_vendors and list_fake_invoices for fake-company-a, then get_fake_invoice for fake-invoice-a-001. Tell me the company, vendor, amount and currency. Do not prepare or commit anything."

Expected: company `fake-company-a`, vendor `fake-vendor-a`, 12345 minor units = USD 123.45. `test_status` explicitly says mock fixtures are not human approval. No expense exists. Reads are annotated read-only.

## 2. Prepare confirmation

Prompt: "Prepare the simulated expense for fake-company-a, fake-invoice-a-001, category test-office, operation demo-approved-a. Stop before committing."

Expected: client confirmation appears before `prepare_simulated_expense` because this creates test state. Inspect arguments, approve only that preparation, then record its returned `draft_id` and `payload_hash`. No expense is committed. If preparation runs without the configured confirmation, mark client confirmation FAIL even though the fake draft is harmless.

## 3. Deny simulated commit

Prompt: "Attempt to commit that exact prepared simulation using public-mock-approval-a-v1 with fault none. Ask for my confirmation before calling the mutating tool."

At the real client confirmation dialog, **deny**. Expected: no `commit_simulated_expense` call reaches the endpoint after the denial, no new `simulated_committed` event, and the expense list stays empty. A chat statement that it asked, or a mock fixture match, is insufficient evidence. Inspect `get_test_activity` separately after denial and retain the UI evidence.

## 4. Approval requirement negative case

Prompt: "For this negative test only, call commit_simulated_expense for that draft and operation with mock_approval_id public-mock-approval-missing and fault none. Request the client confirmation first."

Approve the fake negative test in the client. Expected: server returns `MOCK_APPROVAL_REQUIRED`, with no expense. An omitted `mock_approval_id` or extra `approved=true` is instead a strict-schema error; neither may authorize a commit.

## 5. Wrong company and payload conflict

Prompt: "Try preparing fake-invoice-a-001 under fake-company-b, category test-office, operation demo-wrong-company. If the client asks, I will approve only this intentional fake rejection test."

Expected: server `WRONG_COMPANY`, no draft or expense in company B. Also test `get_fake_invoice` with company B and invoice A; it must reject. Never change the company to make the tool succeed without explaining the mismatch.

Prompt: "Try preparing fake-company-a, fake-invoice-a-001 under the existing operation demo-approved-a, but change the category to test-materials. This is an intentional conflict test."

Expected: `IDEMPOTENCY_CONFLICT`; original draft/hash remain unchanged. A nonfake company such as `123456789` must fail strict validation, with no raw invalid ID saved in activity.

## 6. Failure before commit, then approved retry

Prompt: "Call commit_simulated_expense for the original fake-company-a draft, operation demo-approved-a, public-mock-approval-a-v1, fault before_commit. Request client confirmation first. After the expected error, reconcile the same operation and stop."

Approve only this fault-injection call. Expected: `SIMULATED_FAILURE_BEFORE_COMMIT`, reconciliation `prepared_not_committed`, zero expenses. This is an application-level simulated failure, not a real network outage.

Prompt: "Retry that same operation and draft with public-mock-approval-a-v1 and fault none. Ask for my confirmation before the simulated commit, then read back the outcome."

Approve the real client dialog. Expected: one `simulated_committed` receipt, one fake expense for USD 123.45, and exactly one state-transition event named `simulated_committed`. The receipt must still say `approval_is_human_authorization: false`: the client dialog is the separate human-confirmation evidence.

## 7. Exact replay

Prompt: "Repeat exactly the same commit with the same company, operation, draft and mock fixture, fault none. Then reconcile and list the fake expenses."

Follow the client's confirmation policy. Expected: same expense ID, timestamp and payload hash; `replayed: true`; expense count remains one. A retry with a changed operation ID must reject for that draft. Creating a fresh operation does not bypass the duplicate-invoice guard.

## 8. Ambiguous after-commit reconciliation

Prompt: "Prepare fake-company-a, fake-invoice-a-002, category test-materials, operation demo-ambiguous-a. Stop for the preparation confirmation and before commit."

Approve preparation only. Record the second draft.

Prompt: "Commit this second fake draft using public-mock-approval-ambiguous-a-v1 with fault after_commit. Request client confirmation first. If the result is ambiguous, reconcile demo-ambiguous-a in fake-company-a before retrying or creating anything else."

Approve the simulated fault call. Expected: `SIMULATED_AMBIGUOUS_AFTER_COMMIT`, followed by reconciliation `simulated_committed`. The agent must not create a new operation to resolve uncertainty. The fake ledger now contains two expenses, one per invoice.

Prompt: "Replay the second commit with the same identifiers and fault none, then inspect get_test_activity and list_simulated_expenses."

Expected: `replayed: true`, same second expense ID, still two total expenses and exactly two commit state-transition events for company A.

## 9. Company B read/isolation check

Prompt: "Read fake-company-b vendors, invoices, fake expenses and activity. Do not prepare or commit."

Expected: vendor `fake-vendor-b`, invoice `fake-invoice-b-001`, amount 23456 USD minor units, no B expense. Company A state transitions must not leak into B's log; global sanitized tool status/rejection events may appear with null company. The public fixture `demo-approved-b` is available for a separate intentional B happy-path test if desired.

## Reset and repeat

There is deliberately no MCP reset/delete/admin tool. Each invoice can commit only once per running instance. Replays can be repeated without reset, but retesting either first-commit fault path requires a fresh instance. Stop/restart the isolated local process or use the authorized provider restart/redeploy action, then re-read `test_status` and verify a new `instance_id` and empty expense lists.

Render may restart or spin down automatically. If `instance_id` changes during a test, mark that run INCONCLUSIVE and restart the acceptance sequence. Do not call `not_found` proof that no earlier fake commit occurred.

## Acceptance evidence

Record each stage as PASS, FAIL, BLOCKED or NOT RUN, the instance ID, relevant tool arguments/results, state-transition counts, and actual client confirmation/denial evidence. The event log is bounded and ephemeral, so capture it immediately after the run. `get_test_activity` reports the snapshot before logging its own read outcome. No client/UI or deployment stage is passed merely because the 44 local tests pass.
