const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMcpEndpoint, isPrivateIp } = require('../integrations/mcp');
const {
  FrappeMcpProvider,
  REMOTE_TO_ACTION,
} = require('../integrations/frappe/FrappeMcpProvider');
const { ActionRegistry } = require('../orchestration/core/ActionRegistry');

test('Frappe MCP endpoint normalization targets the built-in v16 endpoint', () => {
  assert.equal(
    normalizeMcpEndpoint('https://erp.example.com/'),
    'https://erp.example.com/api/v2/mcp'
  );
  assert.equal(
    normalizeMcpEndpoint('https://erp.example.com/api/v2/mcp'),
    'https://erp.example.com/api/v2/mcp'
  );
  assert.throws(() => normalizeMcpEndpoint('https://user:pass@erp.example.com'), /Credentials/);
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.0.0.2'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('Frappe MCP discovery namespaces all supported remote tools', async () => {
  const client = {
    listTools: async () => ({
      endpoint: 'https://erp.example.com/api/v2/mcp',
      tools: Object.keys(REMOTE_TO_ACTION).map(name => ({
        name,
        description: name,
        inputSchema: { type: 'object', properties: {} },
      })),
    }),
  };
  const provider = new FrappeMcpProvider({ client });
  const result = await provider.testCredentials('https://erp.example.com', 'key', 'secret');
  assert.equal(result.success, true);
  assert.equal(result.tools.length, 13);
  assert.ok(result.tools.every(tool => tool.name.startsWith('FRAPPE_')));
  assert.ok(result.tools.every(tool => ActionRegistry.isValidAction(tool.name)));
});

test('Frappe MCP execution maps the canonical action back to the remote tool', async () => {
  let received;
  const provider = new FrappeMcpProvider({
    client: {
      callTool: async (credentials, name, args) => {
        received = { credentials, name, args };
        return { success: true, data: { name: 'CUST-0001' } };
      },
    },
  });
  const result = await provider.execute(
    { baseUrl: 'https://erp.example.com', apiKey: 'key', apiSecret: 'secret' },
    'FRAPPE_GET_DOCUMENT',
    { doctype: 'Customer', name: 'CUST-0001' }
  );
  assert.equal(received.name, 'get_document');
  assert.equal(received.args.doctype, 'Customer');
  assert.equal(result.success, true);
  await assert.rejects(
    provider.execute({ baseUrl: 'https://erp.example.com' }, 'FRAPPE_UNKNOWN', {}),
    /Unsupported Frappe MCP action/
  );
});
