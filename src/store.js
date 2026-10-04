import { createHash, randomUUID } from 'node:crypto';
import { COMPANIES, CATEGORIES, VENDORS, INVOICES, PUBLIC_MOCK_APPROVALS, DISCLAIMER } from './fixtures.js';

export class TestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => { throw new TestError(code, message, details); };
const clone = value => structuredClone(value);
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const fingerprint = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const keyFor = (company, operation) => `${company}:${operation}`;
export const draftIdFor = (company, operation, hash) => `fake-draft-${fingerprint({company, operation, hash}).slice(0,24)}`;

export function assertCompany(company) {
  if (!COMPANIES.includes(company)) fail('NON_FAKE_COMPANY_REJECTED', 'Only the two exact fake-company IDs are accepted');
}
function assertOperation(operation) {
  if (typeof operation !== 'string' || !/^demo-[a-z0-9-]{1,60}$/.test(operation)) fail('INVALID_OPERATION', 'Use a synthetic demo- operation ID with lowercase letters, digits and hyphens');
}
function payloadFor(company, invoiceId, category) {
  assertCompany(company);
  if (!CATEGORIES.includes(category)) fail('INVALID_CATEGORY', 'Only fixed test categories are accepted');
  const invoice = INVOICES.find(x => x.invoice_id === invoiceId);
  if (!invoice) fail('INVOICE_NOT_FOUND', 'Unknown fake invoice');
  if (invoice.company_id !== company) fail('WRONG_COMPANY', 'The fake invoice belongs to another fake company');
  return {...invoice, category};
}

/** This is an intentionally ephemeral, single-process simulator, not an accounting ledger. */
export class FakeStore {
  constructor({ now = () => Date.now(), maxOperations = 1000, publicMockApprovals = true } = {}) {
    this.now = now;
    this.maxOperations = maxOperations;
    this.publicMockApprovals = publicMockApprovals;
    this.instanceId = `fake-instance-${randomUUID()}`;
    this.operations = new Map();
    this.drafts = new Map();
    this.grants = new Map();
    this.invoiceCommits = new Map();
    this.activity = [];
    this.sequence = 0;
    if (publicMockApprovals) {
      for (const fixture of PUBLIC_MOCK_APPROVALS) {
        const payload = payloadFor(fixture.company_id, fixture.invoice_id, fixture.category);
        const payload_hash = fingerprint(payload);
        this.grants.set(fixture.mock_approval_id, {
          ...fixture,
          payload_hash,
          draft_id: draftIdFor(fixture.company_id, fixture.operation_id, payload_hash),
          amount_minor: payload.amount_minor,
          expires_at: null,
          consumed: false,
          evidence_type: 'public_mock_fixture_not_human_approval',
        });
      }
    }
  }

  audit(company_id, operation_id, event, extra = {}) {
    const entry = { sequence: ++this.sequence, time: new Date(this.now()).toISOString(), company_id, operation_id, event, ...extra };
    this.activity.push(entry);
    if (this.activity.length > 1000) this.activity.shift();
  }

  status() {
    return { simulation: true, disclaimer: DISCLAIMER, instance_id: this.instanceId, company_ids: [...COMPANIES], state: 'ephemeral_single_process', approval_is_human_authorization: false, public_mock_approvals_enabled: this.publicMockApprovals, public_mock_fixtures: this.publicMockApprovals ? PUBLIC_MOCK_APPROVALS.map(f => ({...f, payload_hash: this.grants.get(f.mock_approval_id).payload_hash})) : [], max_operations: this.maxOperations };
  }

  vendors(company_id) { assertCompany(company_id); return clone(VENDORS.filter(x => x.company_id === company_id)); }
  invoices(company_id) { assertCompany(company_id); return clone(INVOICES.filter(x => x.company_id === company_id)); }
  invoice(company_id, invoice_id) {
    assertCompany(company_id);
    const value = INVOICES.find(x => x.invoice_id === invoice_id);
    if (!value) fail('INVOICE_NOT_FOUND', 'Unknown fake invoice');
    if (value.company_id !== company_id) fail('WRONG_COMPANY', 'The fake invoice belongs to another fake company');
    return clone(value);
  }

  prepare({ company_id, invoice_id, category, operation_id }) {
    assertCompany(company_id);
    assertOperation(operation_id);
    const payload = payloadFor(company_id, invoice_id, category);
    const payload_hash = fingerprint(payload);
    const key = keyFor(company_id, operation_id);
    const old = this.operations.get(key);
    if (old) {
      if (old.payload_hash !== payload_hash) fail('IDEMPOTENCY_CONFLICT', 'The operation ID already refers to a different payload');
      this.audit(company_id, operation_id, 'prepare_replayed');
      return { ...clone(old.draft), replayed: true, committed: Boolean(old.receipt) };
    }
    if (this.operations.size >= this.maxOperations) fail('TEST_CAPACITY_REACHED', 'This bounded demo is full; restart the isolated service to reset it');
    const draft = { simulation: true, company_id, operation_id, draft_id: draftIdFor(company_id, operation_id, payload_hash), payload_hash, payload, status: 'prepared', requires_mock_approval: true, approval_is_human_authorization: false };
    const record = { company_id, operation_id, payload_hash, draft, receipt: null };
    this.operations.set(key, record);
    this.drafts.set(draft.draft_id, record);
    this.audit(company_id, operation_id, 'prepared', { payload_hash });
    return { ...clone(draft), replayed: false, committed: false };
  }

  /** Operator/test-harness mechanism only. Never register this as an MCP tool or TCP route. */
  mintLocalMockApproval({ company_id, operation_id, draft_id, ttl_ms = 300000 }) {
    const record = this.checkDraft(company_id, operation_id, draft_id);
    if (!Number.isInteger(ttl_ms) || ttl_ms < 1 || ttl_ms > 300000) fail('INVALID_TTL', 'Mock grants may last from 1 to 300000 milliseconds');
    if (record.receipt) fail('ALREADY_COMMITTED', 'The operation already committed');
    if (this.grants.size >= this.maxOperations * 2 + PUBLIC_MOCK_APPROVALS.length) fail('TEST_CAPACITY_REACHED', 'Mock grant capacity reached');
    const mock_approval_id = `local-mock-${randomUUID()}`;
    const grant = { mock_approval_id, company_id, operation_id, draft_id, payload_hash: record.payload_hash, invoice_id: record.draft.payload.invoice_id, amount_minor: record.draft.payload.amount_minor, expires_at: this.now() + ttl_ms, consumed: false, evidence_type: 'local_operator_mock_not_human_approval' };
    this.grants.set(mock_approval_id, grant);
    this.audit(company_id, operation_id, 'local_mock_approval_minted');
    return { simulation: true, approval_is_human_authorization: false, ...clone(grant) };
  }

  checkDraft(company_id, operation_id, draft_id) {
    assertCompany(company_id);
    assertOperation(operation_id);
    const record = this.drafts.get(draft_id);
    if (!record) fail('DRAFT_NOT_FOUND', 'Unknown fake draft');
    if (record.company_id !== company_id) fail('WRONG_COMPANY', 'The draft belongs to another fake company');
    if (record.operation_id !== operation_id) fail('IDEMPOTENCY_CONFLICT', 'The draft is bound to a different operation ID');
    return record;
  }

  commit({ company_id, operation_id, draft_id, mock_approval_id, fault = 'none' }) {
    const record = this.checkDraft(company_id, operation_id, draft_id);
    if (!['none', 'before_commit', 'after_commit'].includes(fault)) fail('INVALID_FAULT', 'Unknown synthetic fault mode');
    const grant = this.grants.get(mock_approval_id);
    if (!grant) fail('MOCK_APPROVAL_REQUIRED', 'A matching server-known mock approval is required; approved=true is never accepted');
    if (grant.company_id !== company_id || grant.operation_id !== operation_id || grant.draft_id !== draft_id || grant.payload_hash !== record.payload_hash || grant.invoice_id !== record.draft.payload.invoice_id || grant.amount_minor !== record.draft.payload.amount_minor) {
      fail('MOCK_APPROVAL_MISMATCH', 'The mock approval is bound to a different exact operation and payload');
    }
    if (record.receipt) {
      if (record.receipt.mock_approval_id !== mock_approval_id) fail('IDEMPOTENCY_CONFLICT', 'Replay must use the original mock approval');
      this.audit(company_id, operation_id, 'commit_replayed');
      return { ...clone(record.receipt), replayed: true };
    }
    if (grant.consumed) fail('MOCK_APPROVAL_CONSUMED', 'The mock approval has already been consumed');
    if (grant.expires_at !== null && this.now() >= grant.expires_at) fail('MOCK_APPROVAL_EXPIRED', 'The local mock approval expired');
    const invoiceKey = `${company_id}:${record.draft.payload.invoice_id}`;
    if (this.invoiceCommits.has(invoiceKey)) fail('DUPLICATE_INVOICE', 'This fake invoice is already committed under a different operation ID');
    if (fault === 'before_commit') {
      this.audit(company_id, operation_id, 'fault_before_commit');
      fail('SIMULATED_FAILURE_BEFORE_COMMIT', 'Nothing committed. Reconcile, then retry the same operation without fault injection.', { outcome: 'not_committed', operation_id });
    }
    // No awaits occur between check and commit: atomic within this single Node process.
    const receipt = { simulation: true, company_id, operation_id, expense_id: `fake-expense-${fingerprint({ company_id, operation_id }).slice(0,24)}`, draft_id, payload_hash: record.payload_hash, payload: clone(record.draft.payload), status: 'simulated_committed', mock_approval_id, approval_evidence_type: grant.evidence_type, approval_is_human_authorization: false, committed_at: new Date(this.now()).toISOString() };
    record.receipt = receipt;
    grant.consumed = true;
    this.invoiceCommits.set(invoiceKey, receipt.expense_id);
    this.audit(company_id, operation_id, 'simulated_committed', { expense_id: receipt.expense_id, payload_hash: record.payload_hash });
    if (fault === 'after_commit') {
      this.audit(company_id, operation_id, 'fault_after_commit');
      fail('SIMULATED_AMBIGUOUS_AFTER_COMMIT', 'The simulated acknowledgment was lost. Do not create a new operation. Reconcile this exact operation ID.', { outcome: 'unknown_to_caller', operation_id, reconciliation_required: true });
    }
    return { ...clone(receipt), replayed: false };
  }

  reconcile(company_id, operation_id) {
    assertCompany(company_id);
    assertOperation(operation_id);
    const record = this.operations.get(keyFor(company_id, operation_id));
    if (!record) return { simulation: true, company_id, operation_id, status: 'not_found', committed: false, instance_id: this.instanceId, warning: 'Not found only proves absence in this running instance. State is lost on restart.' };
    return { simulation: true, company_id, operation_id, status: record.receipt ? 'simulated_committed' : 'prepared_not_committed', committed: Boolean(record.receipt), payload_hash: record.payload_hash, receipt: clone(record.receipt), instance_id: this.instanceId };
  }
  expenses(company_id) { assertCompany(company_id); return [...this.operations.values()].filter(x => x.company_id === company_id && x.receipt).map(x => clone(x.receipt)); }
  events(company_id) { assertCompany(company_id); return clone(this.activity.filter(x => x.company_id === company_id || x.company_id === null).slice(-100)); }
}
