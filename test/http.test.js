import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startService } from '../src/server.js';
import { FakeStore } from '../src/store.js';
const A = 'fake-company-a';
const args = { company_id: A, invoice_id: 'fake-invoice-a-001', category: 'test-office', operation_id: 'demo-approved-a' };
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
async function setup(t, options = {}) {
  const service = await startService(options);
  const client = new Client({ name: 'official-sdk-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`));
  await client.connect(transport);
  t.after(async () => { await client.close(); await service.close(); });
  return {service, client, transport};
}
const call = (client, name, arguments_ = {}) => client.callTool({name, arguments: arguments_});
const body = result => result.structuredContent;
async function rpc(service, value, options = {}) {
  return fetch(`${service.url}/mcp`, { method: 'POST', headers, body: JSON.stringify(value), ...options });
}
function rawHttp(url, method, extraHeaders = {}, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {method, headers: extraHeaders}, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({status:res.statusCode, body:JSON.parse(text)}));
    });
    req.on('error', reject); req.end(data);
  });
}

test('official SDK negotiates MCP and discovers exactly nine bounded tools', async t => {
  const {client, transport} = await setup(t);
  assert.equal(client.getServerVersion().name, 'isolated-fake-accounting-test');
  assert.ok(client.getServerCapabilities().tools);
  assert.equal(transport.sessionId, undefined);
  const {tools} = await client.listTools();
  assert.equal(tools.length, 9);
  for (const tool of tools) {
    assert.match(tool.description, /SIMULATION ONLY/);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.readOnlyHint, !['prepare_simulated_expense','commit_simulated_expense'].includes(tool.name));
  }
  assert.equal(tools.some(x => /mint|approve|login|payment|delete/.test(x.name)), false);
});
test('health and status disclose public simulation and ephemeral instance', async t => {
  const {service, client} = await setup(t);
  const health = await (await fetch(service.url+'/health')).json();
  assert.equal(health.ok, true); assert.equal(health.simulation, true);
  const status = body(await call(client, 'test_status'));
  assert.equal(status.instance_id, health.instance_id);
  assert.equal(status.approval_is_human_authorization, false);
  assert.equal(status.public_mock_fixtures.length, 3);
  assert.match((await (await fetch(service.url)).json()).disclaimer, /no live accounting/);
});
test('all read tools work through SDK and keep company results scoped', async t => {
  const {client} = await setup(t);
  assert.equal(body(await call(client, 'list_fake_vendors', {company_id:A})).vendors.length, 1);
  assert.equal(body(await call(client, 'list_fake_invoices', {company_id:A})).invoices.length, 2);
  assert.equal(body(await call(client, 'get_fake_invoice', {company_id:A, invoice_id:args.invoice_id})).invoice.amount_minor,12345);
  assert.equal(body(await call(client, 'list_simulated_expenses', {company_id:A})).expenses.length, 0);
  assert.ok(body(await call(client, 'get_test_activity', {company_id:A})).activity.some(e=>e.tool==='get_fake_invoice' && e.outcome==='success'));
});
test('every company-scoped MCP tool rejects arbitrary/live company IDs without mutation', async t => {
  const {client,service} = await setup(t);
  for (const tool of (await client.listTools()).tools.filter(x => x.name !== 'test_status')) {
    const invalid = {...args, draft_id:'fake-draft-'+'a'.repeat(24), mock_approval_id:'public-mock-approval-a-v1',company_id:'123456789'};
    const params = Object.fromEntries(Object.keys(tool.inputSchema.properties).filter(k => k in invalid).map(k => [k,invalid[k]]));
    const r = await call(client, tool.name, params);
    assert.equal(r.isError, true, tool.name);
    assert.equal(body(r).instance_id, service.store.instanceId);
  }
  assert.equal(service.store.operations.size, 0);
  assert.ok(service.store.activity.every(e=>e.event==='tool_call' && e.company_id===null && e.outcome==='rejected'));
});
test('cross-company invoice rejects at server and leaves no draft', async t => {
  const {client,service} = await setup(t);
  for (const [name, params] of [['get_fake_invoice',{company_id:'fake-company-b',invoice_id:args.invoice_id}],['prepare_simulated_expense',{...args,company_id:'fake-company-b'}]]) {
    const r = await call(client,name,params);
    assert.equal(r.isError,true); assert.equal(body(r).error.code,'WRONG_COMPANY');
  }
  assert.equal(service.store.operations.size,0);
});
test('strict schema rejects approved=true, extra amount, URLs and unknown fields', async t => {
  const {client,service} = await setup(t);
  for (const extra of [{approved:true},{amount_minor:1},{endpoint_url:'https://not-an-accounting-fixture.invalid'},{vendor_id:'fake-vendor-a'},{password:'PUBLIC-TEST-STRING-NOT-A-SECRET'}]) {
    const r = await call(client,'prepare_simulated_expense',{...args,...extra});
    assert.equal(r.isError,true);
    assert.equal(body(r).instance_id,service.store.instanceId);
  }
  assert.equal(service.store.operations.size,0);
  assert.equal(JSON.stringify(service.store.activity).includes('PUBLIC-TEST-STRING'),false);
});
test('missing/wrong-type fields, giant operation and nonobject arguments reject', async t => {
  const {client} = await setup(t);
  for (const value of [{},{...args,category:1},{...args,operation_id:'demo-'+'a'.repeat(61)},{...args,company_id:null}]) {
    assert.equal((await call(client,'prepare_simulated_expense',value)).isError,true);
  }
});
test('missing/invented mock approval and caller approved boolean never allow commit', async t => {
  const {client,service} = await setup(t);
  const d = body(await call(client,'prepare_simulated_expense',args));
  const p = {company_id:A,operation_id:args.operation_id,draft_id:d.draft_id};
  assert.equal((await call(client,'commit_simulated_expense',p)).isError,true);
  assert.equal((await call(client,'commit_simulated_expense',{...p,mock_approval_id:'public-mock-approval-missing'})).isError,true);
  assert.equal((await call(client,'commit_simulated_expense',{...p,mock_approval_id:'public-mock-approval-a-v1',approved:true})).isError,true);
  assert.equal(service.store.expenses(A).length,0);
});
test('public mock fixture commit and repeated protocol calls create exactly one fake expense', async t => {
  const {client} = await setup(t);
  const d = body(await call(client,'prepare_simulated_expense',args));
  const p = {company_id:A,operation_id:args.operation_id,draft_id:d.draft_id,mock_approval_id:'public-mock-approval-a-v1'};
  const first = body(await call(client,'commit_simulated_expense',p));
  assert.equal(first.approval_is_human_authorization,false);
  const second = body(await call(client,'commit_simulated_expense',p));
  assert.equal(second.replayed,true); assert.equal(second.expense_id,first.expense_id);
  assert.equal(body(await call(client,'list_simulated_expenses',{company_id:A})).expenses.length,1);
  const events = body(await call(client,'get_test_activity',{company_id:A})).activity;
  assert.equal(events.filter(e=>e.event==='simulated_committed').length,1);
});
test('concurrent same-operation commits have one mutation and nineteen replays', async t => {
  const {client,service} = await setup(t);
  const d = body(await call(client,'prepare_simulated_expense',args));
  const p = {company_id:A,operation_id:args.operation_id,draft_id:d.draft_id,mock_approval_id:'public-mock-approval-a-v1'};
  const results = await Promise.all(Array.from({length:20},()=>call(client,'commit_simulated_expense',p)));
  assert.equal(results.filter(r=>body(r).replayed===false).length,1);
  assert.equal(results.filter(r=>body(r).replayed===true).length,19);
  assert.equal(service.store.expenses(A).length,1);
});
test('before-commit failure reconciles absent; retry succeeds once', async t => {
  const {client} = await setup(t);
  const d=body(await call(client,'prepare_simulated_expense',args));
  const p={company_id:A,operation_id:args.operation_id,draft_id:d.draft_id,mock_approval_id:'public-mock-approval-a-v1'};
  const r=await call(client,'commit_simulated_expense',{...p,fault:'before_commit'});
  assert.equal(r.isError,true); assert.equal(body(r).error.code,'SIMULATED_FAILURE_BEFORE_COMMIT');
  assert.equal(body(await call(client,'reconcile_operation',{company_id:A,operation_id:args.operation_id})).committed,false);
  assert.equal(body(await call(client,'commit_simulated_expense',p)).replayed,false);
});
test('after-commit ambiguous result reconciles committed and retry does not duplicate', async t => {
  const {client} = await setup(t);
  const d=body(await call(client,'prepare_simulated_expense',args));
  const p={company_id:A,operation_id:args.operation_id,draft_id:d.draft_id,mock_approval_id:'public-mock-approval-a-v1'};
  const r=await call(client,'commit_simulated_expense',{...p,fault:'after_commit'});
  assert.equal(r.isError,true); assert.equal(body(r).error.outcome,'unknown_to_caller');
  assert.equal(body(await call(client,'reconcile_operation',{company_id:A,operation_id:args.operation_id})).committed,true);
  assert.equal(body(await call(client,'commit_simulated_expense',p)).replayed,true);
  assert.equal(body(await call(client,'list_simulated_expenses',{company_id:A})).expenses.length,1);
});
test('raw JSON-RPC initialize and initialized notification use standard responses', async t => {
  const {service} = await setup(t);
  const res=await rpc(service,{jsonrpc:'2.0',id:7,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'raw-test',version:'1'}}});
  assert.equal(res.status,200); assert.match(res.headers.get('content-type'),/application\/json/);
  const v=await res.json(); assert.equal(v.id,7); assert.equal(v.result.protocolVersion,'2025-11-25');
  const n=await rpc(service,{jsonrpc:'2.0',method:'notifications/initialized'});
  assert.equal(n.status,202); assert.equal(await n.text(),'');
});
test('stateless GET/DELETE/PUT return 405, unrelated and operator TCP routes return 404', async t => {
  const {service} = await setup(t);
  for (const method of ['GET','DELETE','PUT']) assert.equal((await fetch(service.url+'/mcp',{method})).status,405);
  for (const path of ['/mock-approve','/operator/mock-approve','/missing','/mcp?company=live']) assert.equal((await fetch(service.url+path)).status,404);
});
test('untrusted Origin and Host reject before MCP or health processing', async t => {
  const {service} = await setup(t);
  for (const bad of [{origin:'https://evil.invalid'},{origin:'null'},{host:'evil.invalid'},{host:'localhost.evil.invalid'},{origin:'http://localhost:9999'}]) {
    assert.equal((await rawHttp(service.url+'/health','GET',bad)).status,403,JSON.stringify(bad));
    assert.equal((await rawHttp(service.url+'/mcp','POST',{...headers,...bad},JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}))).status,403,JSON.stringify(bad));
  }
  assert.equal((await fetch(service.url+'/health',{headers:{origin:service.url}})).status,200);
});
test('invalid HTTP accept, JSON, content-type and protocol version reject', async t => {
  const {service} = await setup(t);
  const packet={jsonrpc:'2.0',id:1,method:'tools/list'};
  assert.equal((await rpc(service,packet,{headers:{...headers,accept:'text/plain'}})).status,406);
  assert.equal((await rpc(service,packet,{body:'not JSON'})).status,400);
  assert.equal((await rpc(service,packet,{headers:{...headers,'content-type':'text/plain'}})).status,415);
  assert.equal((await rpc(service,packet,{headers:{...headers,'mcp-protocol-version':'1900-01-01'}})).status,400);
});
test('oversized request is rejected without domain mutation', async t => {
  const {service} = await setup(t);
  const r=await rpc(service,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'prepare_simulated_expense',arguments:{...args,padding:'x'.repeat(20000)}}});
  assert.equal(r.status,413); assert.equal(service.store.operations.size,0);
});
test('unknown MCP tool cannot reach an operator approval mechanism', async t => {
  const {client,service} = await setup(t);
  const r=await call(client,'mint_mock_approval',{});
  assert.equal(r.isError,true); assert.equal(body(r).instance_id,service.store.instanceId);
  assert.equal(service.store.grants.size,3);
});
test('unsafe bind/configuration values reject instead of guessing public access', async () => {
  for (const config of [{host:'localhost'},{port:-1},{port:65536},{host:'0.0.0.0'},{publicHostname:'https://fake.invalid/path'}]) {
    await assert.rejects(()=>startService(config));
  }
});
test('sanitized activity covers reads/rejections but never retains raw payloads or unknown IDs', async t => {
  const {client,service}=await setup(t);
  await call(client,'get_fake_invoice',{company_id:'live-company-private-id',invoice_id:'not-fixture'});
  await call(client,'unknown-tool-private-name',{});
  await call(client,'prepare_simulated_expense',{...args,comment:'PRIVATE-PAYLOAD-SENTINEL',url:'https://private.invalid'});
  const r=body(await call(client,'get_test_activity',{company_id:A}));
  const text=JSON.stringify(service.store.activity);
  for (const sentinel of ['live-company-private-id','not-fixture','unknown-tool-private-name','PRIVATE-PAYLOAD-SENTINEL','private.invalid']) assert.equal(text.includes(sentinel),false);
  assert.ok(r.activity.some(e=>e.tool==='get_fake_invoice' && e.outcome==='rejected'));
  assert.ok(r.activity.some(e=>e.tool==='unknown_tool' && e.outcome==='rejected'));
});
test('restart loses fake state and changes instance ID, verified through the SDK', async t => {
  const first=await setup(t);
  const d=body(await call(first.client,'prepare_simulated_expense',args));
  await call(first.client,'commit_simulated_expense',{company_id:A,operation_id:args.operation_id,draft_id:d.draft_id,mock_approval_id:'public-mock-approval-a-v1'});
  await first.client.close(); await first.service.close();
  const second=await setup(t);
  const r=body(await call(second.client,'reconcile_operation',{company_id:A,operation_id:args.operation_id}));
  assert.notEqual(r.instance_id,d.instance_id); assert.equal(r.status,'not_found'); assert.match(r.warning,/restart/);
});
