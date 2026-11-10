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
  selectTransition,
} = require('../services/jiraConnectorService');
const { ActionRegistry } = require('../orchestration/core/ActionRegistry');
const googleWorkspace = require('../services/googleWorkspaceService');
const { ComposioService } = require('../composioService');

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

test('all visible Google apps share one personal Google Workspace connection', () => {
  const googleApps = ['gmail', 'gcalender', 'drive', 'docs', 'sheets'].map(getConnector);
  for (const app of googleApps) {
    assert.equal(app.providers.direct.status, 'available');
    assert.equal(app.providers.direct.connector, 'google_workspace');
    assert.equal(app.providers.direct.connectionScope, 'user');
    assert.equal(app.providers.direct.connectionFamily, 'google_workspace');
  }
});

test('native Google connector exposes tools for every connected Google app family', () => {
  const names = new Set(googleWorkspace.getTools().map(tool => tool.name));
  assert.ok(names.has('GMAIL_SEND_EMAIL'));
  assert.ok(names.has('GOOGLECALENDAR_CREATE_EVENT'));
  assert.ok(names.has('GOOGLEDRIVE_SEARCH_FILES'));
  assert.ok(names.has('GOOGLEDOCS_CREATE_DOCUMENT'));
  assert.ok(names.has('GOOGLESHEETS_GET_VALUES'));
  for (const name of names) assert.equal(googleWorkspace.supportsAction(name), true);
  assert.equal(ActionRegistry.isValidAction('GOOGLEDRIVE_CREATE_FOLDER'), true);
  assert.equal(ActionRegistry.isValidAction('GOOGLEDOCS_APPEND_TEXT'), true);
  assert.equal(ActionRegistry.isValidAction('GOOGLESHEETS_UPDATE_VALUES'), true);
});

test('Google direct connections are user-scoped while Jira remains organization-scoped', () => {
  const service = new ConnectorService();
  assert.equal(service.isUserScopedDirect('gmail'), true);
  assert.equal(service.isUserScopedDirect('GOOGLEDRIVE'), true);
  assert.equal(service.isUserScopedDirect('jira'), false);
});

test('Google direct tool schemas stay limited to the selected Google application', () => {
  const { createDirectConnectors } = require('../integrations/directConnectors');
  const service = new ConnectorService({ directConnectors: createDirectConnectors() });
  assert.ok(service.getDirectTools('gmail').every(tool => tool.name.startsWith('GMAIL_')));
  assert.ok(service.getDirectTools('GOOGLECALENDAR').every(tool => tool.name.startsWith('GOOGLECALENDAR_')));
  assert.ok(service.getDirectTools('drive').every(tool => tool.name.startsWith('GOOGLEDRIVE_')));
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

test('Jira terminal intents resolve to the workflow transition that reaches Done', () => {
  const transitions = [
    { id: '11', name: 'Start progress', to: { statusCategory: { key: 'indeterminate' } } },
    { id: '31', name: 'Finish work', to: { statusCategory: { key: 'done' } } },
  ];
  assert.equal(selectTransition(transitions, 'Closed').id, '31');
  assert.equal(selectTransition(transitions, 'done').id, '31');
  assert.equal(selectTransition(transitions, '11').id, '11');
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

test('Composio disconnect only deletes accounts returned for the authenticated entity and toolkit', async () => {
  const deleted = [];
  const service = Object.create(ComposioService.prototype);
  service.entityId = 'default';
  service._cache = {
    connectedApps: new Map([['user_1', { data: [], timestamp: Date.now() }]]),
    appActions: new Map(),
    actionSchemas: new Map(),
    allActions: new Map([['user_1', { data: [], timestamp: Date.now() }]]),
    availableToolkits: null,
  };
  service.composio = {
    connectedAccounts: {
      list: async params => {
        assert.deepEqual(params.userIds, ['user_1']);
        assert.deepEqual(params.toolkitSlugs, ['slack']);
        return { items: [{ id: 'conn_1' }, { id: 'conn_2' }] };
      },
      delete: async id => { deleted.push(id); },
    },
  };

  const result = await service.disconnectToolkit('slack', 'user_1');
  assert.deepEqual(deleted, ['conn_1', 'conn_2']);
  assert.equal(result.disconnected, 2);
  assert.equal(service._cache.connectedApps.has('user_1'), false);
  assert.equal(service._cache.allActions.has('user_1'), false);
});
