const test = require('node:test');
const assert = require('node:assert/strict');
const { CONNECTOR_CATALOG, getConnector, connectorForAction } = require('../integrations/connectorCatalog');
const { ConnectorService } = require('../integrations/ConnectorService');
const { adf, supportsAction } = require('../services/jiraConnectorService');

test('catalog covers every application currently displayed in SwiftCollab', () => {
  assert.equal(CONNECTOR_CATALOG.length, 33);
  assert.equal(new Set(CONNECTOR_CATALOG.map(item => item.id)).size, 33);
  for (const item of CONNECTOR_CATALOG) {
    assert.ok(item.providers.direct);
    assert.equal(item.providers.composio.status, 'available');
    assert.ok(item.toolkit);
  }
  assert.equal(getConnector('gcalender').toolkit, 'GOOGLECALENDAR');
  assert.equal(getConnector('GOOGLECALENDAR').id, 'gcalender');
  assert.equal(connectorForAction('JIRA_CREATE_ISSUE').id, 'jira');
});

test('Composio remains the connection and execution fallback', async () => {
  const calls = [];
  const service = new ConnectorService({
    composioProvider: {
      initiateConnection: async input => { calls.push(['connect', input]); return { redirectUrl: 'https://provider.test' }; },
      executeAction: async input => { calls.push(['execute', input]); return { success: true, data: { ok: true } }; },
    },
  });

  const connection = await service.initiateConnection({ appId: 'jira', provider: 'composio', entityId: 'user_1' });
  assert.equal(connection.redirectUrl, 'https://provider.test');
  const result = await service.executeAction({ actionName: 'JIRA_CREATE_ISSUE', params: { summary: 'Test' }, entityId: 'user_1' });
  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
});

test('unimplemented direct connector fails clearly instead of silently using Composio', async () => {
  const service = new ConnectorService({ composioProvider: {} });
  await assert.rejects(
    service.initiateConnection({ appId: 'salesforce', provider: 'direct' }),
    error => error.code === 'DIRECT_CONNECTOR_SETUP_REQUIRED' && error.statusCode === 409
  );
});

test('available direct connector receives organization and user context', async () => {
  let received;
  const service = new ConnectorService({
    directConnectors: {
      google_workspace: {
        initiateConnection: async input => { received = input; return { redirectUrl: 'https://google.test' }; },
        getConnectionStatus: async () => ({ connected: true }),
      },
    },
  });

  const result = await service.initiateConnection({
    appId: 'gcalender',
    provider: 'direct',
    organizationId: 'org_1',
    userId: 'user_1',
  });
  assert.equal(result.redirectUrl, 'https://google.test');
  assert.equal(received.organizationId, 'org_1');
  assert.equal(received.userId, 'user_1');
});

test('connected native Jira is preferred over Composio for supported actions', async () => {
  const calls = [];
  const service = new ConnectorService({
    composioProvider: { executeAction: async () => { calls.push('composio'); return { success: true }; } },
    directConnectors: {
      jira: {
        supportsAction: action => action === 'JIRA_CREATE_ISSUE',
        getConnectionStatus: async () => ({ connected: true }),
        executeAction: async input => { calls.push(['direct', input.organizationId]); return { success: true }; },
      },
    },
  });
  await service.executeAction({
    actionName: 'JIRA_CREATE_ISSUE',
    params: { project_key: 'SWIFT', summary: 'Test' },
    organizationId: 'org_1',
    userId: 'user_1',
  });
  assert.deepEqual(calls, [['direct', 'org_1']]);
});

test('Jira connector recognizes canonical and Composio action aliases', () => {
  assert.equal(supportsAction('JIRA_CREATE_ISSUE'), true);
  assert.equal(supportsAction('JIRA_CREATE_JIRA_ISSUE'), true);
  assert.equal(supportsAction('JIRA_DELETE_ISSUE'), false);
  assert.deepEqual(adf('Hello Jira'), {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello Jira' }] }],
  });
});
