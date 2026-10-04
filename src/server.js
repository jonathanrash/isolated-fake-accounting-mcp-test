import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { FakeStore, TestError } from './store.js';
import { COMPANIES, CATEGORIES, DISCLAIMER } from './fixtures.js';

const company = z.enum(COMPANIES);
const operation = z.string().regex(/^demo-[a-z0-9-]{1,60}$/);
const invoice = z.enum(['fake-invoice-a-001', 'fake-invoice-a-002', 'fake-invoice-b-001']);
const draft = z.string().regex(/^fake-draft-[a-f0-9]{24}$/);
const approval = z.string().min(1).max(100).regex(/^(public-mock-approval-[a-z0-9-]+|local-mock-[a-f0-9-]+)$/);
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const toolNames = new Set(['test_status', 'list_fake_vendors', 'list_fake_invoices', 'get_fake_invoice', 'prepare_simulated_expense', 'commit_simulated_expense', 'reconcile_operation', 'list_simulated_expenses', 'get_test_activity']);

function result(value, isError = false) {
  const body = { simulation: true, ...value };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, ...(isError ? { isError: true } : {}) };
}

export function makeMcpServer(store) {
  const server = new McpServer({ name: 'isolated-fake-accounting-test', version: '0.1.0' }, { instructions: DISCLAIMER, maxToolInputElements: 30 });
  const add = (name, description, shape, fn, mutating = false) => {
    server.registerTool(name, { description: `SIMULATION ONLY. ${description}`, inputSchema: z.strictObject(shape), annotations: mutating ? writeAnnotations : readAnnotations }, async args => {
      try { return result({ ...fn(args), instance_id: store.instanceId }); }
      catch (error) {
        if (error instanceof TestError) return result({ instance_id: store.instanceId, error: { code: error.code, message: error.message, ...error.details } }, true);
        return result({ instance_id: store.instanceId, error: { code: 'INTERNAL_TEST_ERROR', message: 'Unexpected test-server error' } }, true);
      }
    });
  };
  add('test_status', 'Read limitations, fake company IDs and public mock-approval fixtures. Mock fixtures are public test data, never human authorization.', {}, () => store.status());
  add('list_fake_vendors', 'Read fixed invented vendors for one exact fake company.', { company_id: company }, a => ({ vendors: store.vendors(a.company_id) }));
  add('list_fake_invoices', 'Read fixed invented invoices for one exact fake company.', { company_id: company }, a => ({ invoices: store.invoices(a.company_id) }));
  add('get_fake_invoice', 'Read one fixed invented invoice. Cross-company lookup is rejected.', { company_id: company, invoice_id: invoice }, a => ({ invoice: store.invoice(a.company_id, a.invoice_id) }));
  add('prepare_simulated_expense', 'Create an in-memory fake draft. Amount, vendor and currency come only from fixed fixtures. Same operation ID and payload replay safely; changed payload is rejected.', { company_id: company, invoice_id: invoice, category: z.enum(CATEGORIES), operation_id: operation }, a => store.prepare(a), true);
  add('commit_simulated_expense', 'Mutate only the in-memory fake ledger. Requires a matching server-known MOCK approval fixture, which is NOT human approval. A real client confirmation must be tested separately. after_commit simulates a lost acknowledgment; reconcile the same operation before retrying.', { company_id: company, draft_id: draft, operation_id: operation, mock_approval_id: approval, fault: z.enum(['none', 'before_commit', 'after_commit']).default('none') }, a => store.commit(a), true);
  add('reconcile_operation', 'Read whether the exact operation committed in this running instance. Missing after restart cannot prove it never committed in a previous instance.', { company_id: company, operation_id: operation }, a => store.reconcile(a.company_id, a.operation_id));
  add('list_simulated_expenses', 'Read committed fake expenses for one fake company.', { company_id: company }, a => ({ expenses: store.expenses(a.company_id) }));
  add('get_test_activity', 'Read the last 100 in-memory activity events for one fake company. This is bounded test evidence, not a durable audit trail.', { company_id: company }, a => ({ activity: store.events(a.company_id) }));
  return server;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function headerIsAllowed(req, allowedHosts, allowedOrigins) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) return false;
  const hostname = host.split(':')[0].toLowerCase();
  if (!allowedHosts.has(hostname)) return false;
  if (req.headers.origin !== undefined && !allowedOrigins.has(req.headers.origin)) return false;
  return true;
}

/** Public transport has no authentication because it accepts only fixed, public synthetic data. */
export async function startService({ host = '127.0.0.1', port = 0, publicHostname, store = new FakeStore() } = {}) {
  if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('HOST must be 127.0.0.1 or 0.0.0.0');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  if (publicHostname && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(publicHostname)) throw new Error('Invalid public hostname');
  if (host === '0.0.0.0' && !publicHostname) throw new Error('Binding publicly requires a configured public hostname');
  const allowedHosts = new Set(['localhost', '127.0.0.1', ...(publicHostname ? [publicHostname.toLowerCase()] : [])]);
  const allowedOrigins = new Set(publicHostname ? [`https://${publicHostname.toLowerCase()}`] : []);
  const server = http.createServer(async (req, res) => {
    if (!headerIsAllowed(req, allowedHosts, allowedOrigins)) return json(res, 403, { error: 'Host or Origin is not allowed' });
    if (req.url === '/health' && req.method === 'GET') return json(res, 200, { ok: true, simulation: true, instance_id: store.instanceId, state: 'ephemeral', disclaimer: DISCLAIMER });
    if (req.url === '/' && req.method === 'GET') return json(res, 200, { name: 'Isolated fake accounting MCP test', mcp_path: '/mcp', health_path: '/health', disclaimer: DISCLAIMER });
    if (req.url !== '/mcp') return json(res, 404, { error: 'Not found' });
    if (req.method === 'GET' || req.method === 'DELETE') {
      res.setHeader('allow', 'POST');
      return json(res, 405, { error: 'Stateless JSON-response MCP: SSE subscriptions and session deletion are not supported' });
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return json(res, 405, { error: 'Method not allowed' });
    }
    const mcp = makeMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 16384 });
    const calls = new Map();
    // Include the running instance even on SDK-generated schema/unknown-tool errors.
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (message.result && Array.isArray(message.result.content)) {
        message = { ...message, result: { ...message.result, structuredContent: { ...message.result.structuredContent, simulation: true, instance_id: store.instanceId } } };
      }
      const context = calls.get(message.id);
      if (context) {
        calls.delete(message.id);
        const errorCode = message.result?.structuredContent?.error?.code;
        store.audit(context.company_id, null, 'tool_call', { tool: context.tool, outcome: message.error || message.result?.isError ? 'rejected' : 'success', ...(message.error || message.result?.isError ? { error_code: errorCode || 'MCP_VALIDATION_OR_TOOL_ERROR' } : {}) });
      }
      return send(message, options);
    };
    res.on('close', () => { void mcp.close(); });
    try {
      await mcp.connect(transport);
      const receive = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if (message.method === 'tools/call' && message.id !== undefined) {
          const suppliedCompany = message.params?.arguments?.company_id;
          calls.set(message.id, { tool: toolNames.has(message.params?.name) ? message.params.name : 'unknown_tool', company_id: COMPANIES.includes(suppliedCompany) ? suppliedCompany : null });
        }
        return receive(message, extra);
      };
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'MCP request failed' });
      else if (!res.writableEnded) res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actualPort = server.address().port;
  allowedOrigins.add(`http://127.0.0.1:${actualPort}`);
  allowedOrigins.add(`http://localhost:${actualPort}`);
  return { server, store, port: actualPort, url: `http://127.0.0.1:${actualPort}`,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
