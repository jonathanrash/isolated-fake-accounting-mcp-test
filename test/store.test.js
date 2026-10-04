import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore, fingerprint, canonicalJson } from '../src/store.js';
import { PUBLIC_MOCK_APPROVALS } from '../src/fixtures.js';
const A = 'fake-company-a', B = 'fake-company-b';
const input = (operation_id = 'demo-approved-a', extra = {}) => ({ company_id: A, invoice_id: 'fake-invoice-a-001', category: 'test-office', operation_id, ...extra });
const code = expected => error => error.code === expected;
function prepared(store, args = input()) {
  const d = store.prepare(args);
  return { company_id: args.company_id, operation_id: args.operation_id, draft_id: d.draft_id };
}
function localApproved(store, args = input('demo-local')) {
  const p = prepared(store, args);
  return { ...p, mock_approval_id: store.mintLocalMockApproval(p).mock_approval_id };
}

test('canonical fingerprint is order independent and changes with consequential fields', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ amount: 1 }), fingerprint({ amount: 2 }));
  assert.equal(canonicalJson([1, 'x']), '[1,"x"]');
});
test('only exact fake companies accepted across all company-scoped domain methods', () => {
  const s = new FakeStore();
  for (const company_id of ['123456789', 'live-company', 'fake-company-c', '', null, 'FAKE-COMPANY-A']) {
    for (const act of [() => s.vendors(company_id), () => s.invoices(company_id), () => s.invoice(company_id, 'fake-invoice-a-001'), () => s.prepare(input('demo-x', {company_id})), () => s.commit({company_id}), () => s.reconcile(company_id, 'demo-x'), () => s.expenses(company_id), () => s.events(company_id)]) {
      assert.throws(act, code('NON_FAKE_COMPANY_REJECTED'));
    }
  }
  assert.equal(s.operations.size, 0);
  assert.equal(s.activity.length, 0);
});
test('fixture reads isolate companies and return copies', () => {
  const s = new FakeStore();
  assert.equal(s.vendors(A).length, 1);
  assert.equal(s.invoices(A).length, 2);
  assert.equal(s.invoices(B).length, 1);
  const i = s.invoice(A, 'fake-invoice-a-001'); i.amount_minor = 1;
  assert.equal(s.invoice(A, 'fake-invoice-a-001').amount_minor, 12345);
  assert.throws(() => s.invoice(B, 'fake-invoice-a-001'), code('WRONG_COMPANY'));
  assert.throws(() => s.invoice(A, 'fake-missing'), code('INVOICE_NOT_FOUND'));
});
test('preparing derives amount/currency/vendor from public fixed fixture', () => {
  const s = new FakeStore(), d = s.prepare(input());
  assert.equal(d.payload.amount_minor, 12345);
  assert.equal(d.payload.currency, 'USD');
  assert.equal(d.payload.vendor_id, 'fake-vendor-a');
  assert.equal(d.committed, false);
  assert.equal(s.expenses(A).length, 0);
  d.payload.amount_minor = 1;
  assert.equal(s.prepare(input()).payload.amount_minor, 12345);
});
test('prepare replays identical input and rejects changed category or invoice', () => {
  const s = new FakeStore(), a = s.prepare(input()), b = s.prepare(input());
  assert.equal(a.draft_id, b.draft_id);
  assert.equal(b.replayed, true);
  assert.equal(s.operations.size, 1);
  assert.throws(() => s.prepare(input('demo-approved-a', { category: 'test-materials' })), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => s.prepare(input('demo-approved-a', { invoice_id: 'fake-invoice-a-002' })), code('IDEMPOTENCY_CONFLICT'));
});
test('invalid category, missing invoice, wrong-company invoice, malformed operation reject', () => {
  const s = new FakeStore();
  assert.throws(() => s.prepare(input('demo-x', { category: 'real-travel' })), code('INVALID_CATEGORY'));
  assert.throws(() => s.prepare(input('demo-x', { invoice_id: 'missing' })), code('INVOICE_NOT_FOUND'));
  assert.throws(() => s.prepare(input('demo-x', { invoice_id: 'fake-invoice-b-001' })), code('WRONG_COMPANY'));
  for (const op of ['real-1', 'demo-', 'demo-https://foo', 'demo-' + 'x'.repeat(61), 12]) assert.throws(() => s.prepare(input(op)), code('INVALID_OPERATION'));
  assert.equal(s.operations.size, 0);
});
test('missing, invented or unrelated public mock approval cannot commit', () => {
  const s = new FakeStore(), p = prepared(s);
  for (const mock_approval_id of [undefined, 'approved=true', 'not-real']) assert.throws(() => s.commit({...p, mock_approval_id}), code('MOCK_APPROVAL_REQUIRED'));
  assert.throws(() => s.commit({...p, mock_approval_id: 'public-mock-approval-b-v1'}), code('MOCK_APPROVAL_MISMATCH'));
  assert.equal(s.expenses(A).length, 0);
});
test('all public mock fixtures are bound to exactly their public operation and payload', () => {
  const s = new FakeStore();
  for (const f of PUBLIC_MOCK_APPROVALS) {
    const p = prepared(s, f), receipt = s.commit({...p, mock_approval_id: f.mock_approval_id});
    assert.equal(receipt.status, 'simulated_committed');
    assert.equal(receipt.approval_is_human_authorization, false);
    assert.equal(receipt.approval_evidence_type, 'public_mock_fixture_not_human_approval');
  }
  assert.equal(s.expenses(A).length, 2); assert.equal(s.expenses(B).length, 1);
});
test('changing public fixture category rejects mock approval despite same invoice/amount', () => {
  const s = new FakeStore(), p = prepared(s, input('demo-approved-a', { category: 'test-materials' }));
  assert.throws(() => s.commit({...p, mock_approval_id: 'public-mock-approval-a-v1'}), code('MOCK_APPROVAL_MISMATCH'));
});
test('public mock fixture does not authorize a different operation ID', () => {
  const s = new FakeStore(), p = prepared(s, input('demo-other'));
  assert.throws(() => s.commit({...p, mock_approval_id: 'public-mock-approval-a-v1'}), code('MOCK_APPROVAL_MISMATCH'));
});
test('commit rejects wrong-company draft, unknown draft, changed operation and invalid fault', () => {
  const s = new FakeStore(), p = prepared(s);
  assert.throws(() => s.commit({...p, company_id: B}), code('WRONG_COMPANY'));
  assert.throws(() => s.commit({...p, draft_id: 'missing'}), code('DRAFT_NOT_FOUND'));
  assert.throws(() => s.commit({...p, operation_id: 'demo-other'}), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => s.commit({...p, fault: 'random'}), code('INVALID_FAULT'));
});
test('commit replay creates one expense and returns the same committed identity', () => {
  const s = new FakeStore(), p = {...prepared(s), mock_approval_id: 'public-mock-approval-a-v1'};
  const a = s.commit(p), b = s.commit(p);
  assert.equal(a.replayed, false); assert.equal(b.replayed, true);
  assert.equal(a.expense_id, b.expense_id); assert.equal(a.committed_at, b.committed_at);
  assert.equal(s.expenses(A).length, 1);
  assert.equal(s.events(A).filter(e => e.event === 'simulated_committed').length, 1);
});
test('duplicate invoice cannot be bypassed using a new operation and mock grant', () => {
  const s = new FakeStore();
  s.commit(localApproved(s, input('demo-one')));
  const p = localApproved(s, input('demo-two'));
  assert.throws(() => s.commit(p), code('DUPLICATE_INVOICE'));
  assert.equal(s.expenses(A).length, 1);
});
test('same operation name in different fake companies stays tenant-scoped', () => {
  const s = new FakeStore();
  s.commit(localApproved(s, input('demo-shared')));
  s.commit(localApproved(s, input('demo-shared', { company_id: B, invoice_id: 'fake-invoice-b-001' })));
  assert.notEqual(s.expenses(A)[0].expense_id, s.expenses(B)[0].expense_id);
  assert.equal(s.events(A).some(e => e.company_id === B), false);
});
test('before-commit fault leaves no expense and preserves mock approval for retry', () => {
  const s = new FakeStore(), p = localApproved(s);
  assert.throws(() => s.commit({...p, fault: 'before_commit'}), code('SIMULATED_FAILURE_BEFORE_COMMIT'));
  assert.equal(s.expenses(A).length, 0);
  assert.equal(s.reconcile(A, p.operation_id).status, 'prepared_not_committed');
  assert.equal(s.grants.get(p.mock_approval_id).consumed, false);
  assert.equal(s.commit(p).replayed, false);
  assert.equal(s.expenses(A).length, 1);
});
test('after-commit ambiguous error reconciles and replay never duplicates', () => {
  const s = new FakeStore(), p = localApproved(s);
  assert.throws(() => s.commit({...p, fault: 'after_commit'}), e => e.code === 'SIMULATED_AMBIGUOUS_AFTER_COMMIT' && e.details.outcome === 'unknown_to_caller');
  const r = s.reconcile(A, p.operation_id);
  assert.equal(r.committed, true); assert.equal(r.status, 'simulated_committed');
  assert.equal(s.commit({...p, fault: 'after_commit'}).replayed, true);
  assert.equal(s.expenses(A).length, 1);
  assert.equal(s.events(A).filter(e => e.event === 'simulated_committed').length, 1);
});
test('local mock grant is exact-bound, expires, and never represents human authorization', () => {
  let now = 1000; const s = new FakeStore({ now: () => now }), p = prepared(s, input('demo-local'));
  const grant = s.mintLocalMockApproval({...p, ttl_ms: 100});
  assert.equal(grant.approval_is_human_authorization, false);
  assert.equal(grant.amount_minor, 12345);
  now = 1100;
  assert.throws(() => s.commit({...p, mock_approval_id: grant.mock_approval_id}), code('MOCK_APPROVAL_EXPIRED'));
  for (const ttl_ms of [0, 300001, 1.5]) assert.throws(() => s.mintLocalMockApproval({...p, ttl_ms}), code('INVALID_TTL'));
});
test('already committed replay remains safe after local grant expiry', () => {
  let now = 1000; const s = new FakeStore({ now: () => now }), p = localApproved(s);
  s.commit(p); now += 400000;
  assert.equal(s.commit(p).replayed, true);
  assert.throws(() => s.mintLocalMockApproval(p), code('ALREADY_COMMITTED'));
});
test('replay with a second pre-minted approval is rejected', () => {
  const s = new FakeStore(), p = prepared(s, input('demo-local'));
  const a = s.mintLocalMockApproval(p), b = s.mintLocalMockApproval(p);
  s.commit({...p, mock_approval_id: a.mock_approval_id});
  assert.throws(() => s.commit({...p, mock_approval_id: b.mock_approval_id}), code('IDEMPOTENCY_CONFLICT'));
});
test('bounded operations allow replays at capacity but reject new operations', () => {
  const s = new FakeStore({ maxOperations: 1 }); s.prepare(input());
  assert.equal(s.prepare(input()).replayed, true);
  assert.throws(() => s.prepare(input('demo-new')), code('TEST_CAPACITY_REACHED'));
});
test('unknown operation and fresh instance disclose ephemeral reconciliation limits', () => {
  const old = new FakeStore(), fresh = new FakeStore();
  old.commit(localApproved(old));
  assert.notEqual(old.instanceId, fresh.instanceId);
  const r = fresh.reconcile(A, 'demo-local');
  assert.equal(r.status, 'not_found'); assert.match(r.warning, /restart/);
  assert.equal(fresh.expenses(A).length, 0);
});
test('public approval fixtures can be disabled and status states the limitation', () => {
  const s = new FakeStore({ publicMockApprovals: false }), p = prepared(s);
  assert.equal(s.status().public_mock_fixtures.length, 0);
  assert.throws(() => s.commit({...p, mock_approval_id: 'public-mock-approval-a-v1'}), code('MOCK_APPROVAL_REQUIRED'));
});
test('audit records only validated synthetic fields and retains bounded recent events', () => {
  const s = new FakeStore();
  for (let i = 0; i < 1100; i++) s.prepare(input());
  assert.equal(s.activity.length, 1000); assert.equal(s.events(A).length, 100);
  const events = s.events(A); events[0].event = 'changed';
  assert.notEqual(s.events(A)[0].event, 'changed');
  assert.equal(s.activity.some(e => 'request' in e || 'headers' in e || 'body' in e), false);
});
