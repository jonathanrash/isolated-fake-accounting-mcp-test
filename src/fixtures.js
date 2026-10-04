/** All names, IDs and amounts in this module are invented public test data. */
export const COMPANIES = Object.freeze(['fake-company-a', 'fake-company-b']);
export const CATEGORIES = Object.freeze(['test-office', 'test-materials']);
export const VENDORS = Object.freeze([
  Object.freeze({ company_id: 'fake-company-a', vendor_id: 'fake-vendor-a', name: 'FAKE ONLY: Paper Moon Supplies' }),
  Object.freeze({ company_id: 'fake-company-b', vendor_id: 'fake-vendor-b', name: 'FAKE ONLY: Blue Comet Supplies' }),
]);
export const INVOICES = Object.freeze([
  Object.freeze({ company_id: 'fake-company-a', invoice_id: 'fake-invoice-a-001', vendor_id: 'fake-vendor-a', amount_minor: 12345, currency: 'USD', invoice_number: 'FAKE-A-001' }),
  Object.freeze({ company_id: 'fake-company-a', invoice_id: 'fake-invoice-a-002', vendor_id: 'fake-vendor-a', amount_minor: 6789, currency: 'USD', invoice_number: 'FAKE-A-002' }),
  Object.freeze({ company_id: 'fake-company-b', invoice_id: 'fake-invoice-b-001', vendor_id: 'fake-vendor-b', amount_minor: 23456, currency: 'USD', invoice_number: 'FAKE-B-001' }),
]);
export const PUBLIC_MOCK_APPROVALS = Object.freeze([
  Object.freeze({ company_id: 'fake-company-a', invoice_id: 'fake-invoice-a-001', category: 'test-office', operation_id: 'demo-approved-a', mock_approval_id: 'public-mock-approval-a-v1' }),
  Object.freeze({ company_id: 'fake-company-a', invoice_id: 'fake-invoice-a-002', category: 'test-materials', operation_id: 'demo-ambiguous-a', mock_approval_id: 'public-mock-approval-ambiguous-a-v1' }),
  Object.freeze({ company_id: 'fake-company-b', invoice_id: 'fake-invoice-b-001', category: 'test-office', operation_id: 'demo-approved-b', mock_approval_id: 'public-mock-approval-b-v1' }),
]);
export const DISCLAIMER = 'SIMULATION ONLY. Public invented data; no live accounting, payment, credential, or Intuit connection. Mock approval is NOT evidence of a human approving anything. All state is in memory and resets on restart.';
