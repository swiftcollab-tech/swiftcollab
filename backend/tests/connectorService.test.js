const test = require('node:test');
const assert = require('node:assert/strict');
const { CONNECTOR_CATALOG, getConnector, connectorForAction } = require('../integrations/connectorCatalog');
const { ConnectorService } = require('../integrations/ConnectorService');
const {
  SCOPES,
  adf,
  supportsAction,
  getTools,
  normalizeIssueKey,
  issueKeyFrom,
  isCurrentUserAssignee,
} = require('../services/jiraConnectorService');
const { ActionRegistry } = require('../orchestration/core/ActionRegistry');

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

test('Jira issue identifiers and current-user assignment are provider compatible', () => {
  assert.equal(issueKeyFrom({ issue_key: 'SCRUM-1' }), 'SCRUM-1');
  assert.equal(normalizeIssueKey('SCRUM -1'), 'SCRUM-1');
  assert.equal(issueKeyFrom({ issue_id_or_key: 'SCRUM-2' }), 'SCRUM-2');
  assert.equal(isCurrentUserAssignee('me'), true);
  assert.equal(isCurrentUserAssignee('currentUser()'), true);
  assert.equal(isCurrentUserAssignee('user-uuid-1', 'user-uuid-1'), true);
  assert.equal(isCurrentUserAssignee('account-id-1'), false);
  assert.ok(SCOPES.includes('read:jira-user'));
  assert.equal(ActionRegistry.isValidAction('JIRA_GET_ISSUE'), true);
});

test('native Jira tools accept an optional site selector for multi-site organizations', () => {
  const tools = getTools();
  assert.ok(tools.length > 0);
  for (const tool of tools) {
    assert.ok(tool.parameters.properties.jira_site, `${tool.name} should accept jira_site`);
    assert.equal(tool.parameters.required?.includes('jira_site'), false);
  }
});

test('connector service forwards Jira connection attempt and resource identifiers', async () => {
  const calls = [];
  const service = new ConnectorService({
    directConnectors: {
      jira: {
        getConnectionStatus: async input => { calls.push(['status', input]); return { connected: true }; },
        selectResource: async input => { calls.push(['select', input]); return { connected: true }; },
        setActiveResource: async input => { calls.push(['active', input]); return { connected: true }; },
        disconnect: async input => { calls.push(['disconnect', input]); },
      },
    },
  });

  await service.getDirectStatus({
    appId: 'jira', organizationId: 'org_1', userId: 'user_1', connectionAttemptId: 'attempt_1',
  });
  await service.selectResource({
    appId: 'jira', organizationId: 'org_1', userId: 'user_1', resourceId: 'site_1', connectionId: 'pending_1',
  });
  await service.setActiveResource({
    appId: 'jira', organizationId: 'org_1', userId: 'user_1', connectionId: 'connection_2',
  });
  await service.disconnect({
    appId: 'jira', organizationId: 'org_1', userId: 'user_1', connectionId: 'connection_1',
  });

  assert.equal(calls[0][1].connectionAttemptId, 'attempt_1');
  assert.equal(calls[1][1].connectionId, 'pending_1');
  assert.equal(calls[2][1].connectionId, 'connection_2');
  assert.equal(calls[3][1].connectionId, 'connection_1');
});
