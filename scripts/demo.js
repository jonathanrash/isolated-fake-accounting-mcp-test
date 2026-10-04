import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startService } from '../src/server.js';

// With no URL this starts a completely separate, temporary local instance.
const supplied = process.argv[2];
const service = supplied ? null : await startService();
const url = supplied || `${service.url}/mcp`;
const client = new Client({name:'synthetic-evidence-demo',version:'0.1.0'});
const evidence = {generated_at:new Date().toISOString(),endpoint:url,scope:'Fixed public fake accounting fixtures only',human_approval_tested:false,steps:[]};
async function call(name,args={}) {
  const r = await client.callTool({name,arguments:args});
  evidence.steps.push({tool:name,arguments:args,is_error:Boolean(r.isError),result:r.structuredContent,content:r.content});
  return r;
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const status=(await call('test_status')).structuredContent;
  evidence.instance_id=status.instance_id;
  evidence.disclaimer=status.disclaimer;
  await call('list_fake_vendors',{company_id:'fake-company-a'});
  await call('get_fake_invoice',{company_id:'fake-company-a',invoice_id:'fake-invoice-a-001'});
  assert.equal((await call('prepare_simulated_expense',{company_id:'fake-company-b',invoice_id:'fake-invoice-a-001',category:'test-office',operation_id:'demo-wrong-company'})).isError,true);
  const fixture=status.public_mock_fixtures[0];
  const args={company_id:fixture.company_id,invoice_id:fixture.invoice_id,category:fixture.category,operation_id:fixture.operation_id};
  const d=(await call('prepare_simulated_expense',args)).structuredContent;
  const p={company_id:fixture.company_id,operation_id:fixture.operation_id,draft_id:d.draft_id};
  assert.equal((await call('commit_simulated_expense',p)).isError,true);
  assert.equal((await call('prepare_simulated_expense',{...args,category:'test-materials'})).isError,true);
  const approved={...p,mock_approval_id:fixture.mock_approval_id};
  if (!d.committed) {
    assert.equal((await call('commit_simulated_expense',{...approved,fault:'before_commit'})).structuredContent.error.code,'SIMULATED_FAILURE_BEFORE_COMMIT');
    assert.equal((await call('reconcile_operation',picks(p))).structuredContent.committed,false);
  }
  await call('commit_simulated_expense',approved);
  assert.equal((await call('commit_simulated_expense',approved)).structuredContent.replayed,true);
  const f=status.public_mock_fixtures[1];
  const d2=(await call('prepare_simulated_expense',{company_id:f.company_id,invoice_id:f.invoice_id,category:f.category,operation_id:f.operation_id})).structuredContent;
  const p2={company_id:f.company_id,operation_id:f.operation_id,draft_id:d2.draft_id,mock_approval_id:f.mock_approval_id};
  if (!d2.committed) assert.equal((await call('commit_simulated_expense',{...p2,fault:'after_commit'})).structuredContent.error.code,'SIMULATED_AMBIGUOUS_AFTER_COMMIT');
  assert.equal((await call('reconcile_operation',picks(p2))).structuredContent.committed,true);
  assert.equal((await call('commit_simulated_expense',p2)).structuredContent.replayed,true);
  const expenses=(await call('list_simulated_expenses',{company_id:'fake-company-a'})).structuredContent.expenses;
  assert.equal(expenses.length,2);
  const activity=(await call('get_test_activity',{company_id:'fake-company-a'})).structuredContent.activity;
  assert.equal(activity.filter(x=>x.event==='simulated_committed').length,2);
  evidence.outcome='PASS';
} finally {
  await client.close();
  if(service) await service.close();
  console.log(JSON.stringify(evidence,null,2));
}
function picks(p){return {company_id:p.company_id,operation_id:p.operation_id};}
