import { startService } from './server.js';
import { FakeStore } from './store.js';
import { DISCLAIMER } from './fixtures.js';

if (process.env.MOCK_APPROVAL_FIXTURES && !['enabled', 'disabled'].includes(process.env.MOCK_APPROVAL_FIXTURES)) throw new Error('MOCK_APPROVAL_FIXTURES must be enabled or disabled');
const service = await startService({
  port: Number(process.env.PORT || 3337),
  host: process.env.HOST || '127.0.0.1',
  publicHostname: process.env.RENDER_EXTERNAL_HOSTNAME,
  store: new FakeStore({ publicMockApprovals: process.env.MOCK_APPROVAL_FIXTURES !== 'disabled' }),
});
console.log(JSON.stringify({ event: 'test_server_started', local_mcp_url: `${service.url}/mcp`, port: service.port, disclaimer: DISCLAIMER }));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await service.close();
  process.exit(0);
});
