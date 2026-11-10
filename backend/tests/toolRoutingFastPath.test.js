const assert = require('node:assert/strict');
const test = require('node:test');
const ToolRouter = require('../orchestration/ToolRouter');
const AssistantOrchestrator = require('../orchestration/AssistantOrchestrator');
const AssistantComposer = require('../orchestration/AssistantComposer');
const { ExecutorV2 } = require('../orchestration/executorV2');
const UnifiedSlotFiller = require('../orchestration/unified/UnifiedSlotFiller');
const { classifyToolIntent } = require('../orchestration/core/ToolIntentGate');

test('greetings use the immediate chat path', () => {
  const result = classifyToolIntent('hi', ['GITHUB']);
  assert.equal(result.requiresTools, false);
  assert.match(result.immediateReply, /Hi/);
});

test('a greeting never calls the tool router or LLM', async () => {
  let routerCalls = 0;
  const redis = {
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
    eval: async () => 1,
    publish: async () => 0,
  };
  const orchestrator = new AssistantOrchestrator({
    toolRouter: { route: async () => { routerCalls += 1; throw new Error('must not route'); } },
    slotFiller: {},
    executor: {},
    redis,
    callGemini: async () => { throw new Error('must not call model'); },
  });

  const result = await orchestrator.handleTurn({
    sessionId: 'test_greeting',
    message: 'hi',
    enabledToolkits: ['GITHUB'],
  });

  assert.equal(result.type, 'chat');
  assert.equal(result.debug.route, 'fast_chat');
  assert.equal(routerCalls, 0);
});

test('general questions do not enter tool routing', () => {
  assert.equal(classifyToolIntent('What is GitHub?', ['GITHUB']).requiresTools, false);
  assert.equal(classifyToolIntent('Explain JavaScript promises', ['GITHUB']).requiresTools, false);
});

test('connected-app work requests enter tool routing', () => {
  assert.equal(classifyToolIntent('List my GitHub repositories', ['GITHUB']).requiresTools, true);
  assert.equal(classifyToolIntent('Create a GitHub issue', ['GITHUB']).requiresTools, true);
  assert.equal(classifyToolIntent('Send an email to Sam', ['GMAIL']).requiresTools, true);
  assert.equal(
    classifyToolIntent('pls set a google reminder tomorrow at 10 am go to saloon', []).requiresTools,
    true
  );
});

test('native Jira connection participates in connected-tool routing', async () => {
  const router = new ToolRouter({
    composioToolSet: { getConnectedApps: async () => [] },
    connectorService: {
      canExecuteDirect: toolkit => toolkit === 'JIRA',
      getDirectStatus: async () => ({ connected: true, siteName: 'SwiftCollab Jira' }),
      listCatalog: () => [],
    },
    callGemini: async () => '',
  });
  const connected = await router._connectedToolkits(['JIRA'], {
    entityId: 'user_1',
    userId: '1',
    organizationId: 'org_1',
  });
  assert.deepEqual(connected, ['JIRA']);
});

test('an explicit Jira assignment routes directly to the update action', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.USER_TIMEZONE = 'Asia/Calcutta';
  router.callGemini = async () => { throw new Error('LLM should not be needed'); };

  const result = await router._stageA_selectTools({
    message: 'Assign Jira issue SCRUM-1 to me',
    availableTools: [
      { name: 'JIRA_GET_ISSUE', description: 'Get a Jira issue', toolkit: 'JIRA' },
      { name: 'JIRA_UPDATE_ISSUE', description: 'Update a Jira issue', toolkit: 'JIRA' },
    ],
    context: {},
  });

  assert.deepEqual(result.selectedTools, [
    { name: 'JIRA_UPDATE_ISSUE', sequence: 1, usePreviousOutput: false },
  ]);
});

test('Jira assignment preserves "me" instead of an internal SwiftCollab user ID', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.USER_TIMEZONE = 'Asia/Calcutta';
  router.callGemini = async () => JSON.stringify({
    tools: [{
      name: 'JIRA_UPDATE_ISSUE',
      sequence: 1,
      params: { issue_key: 'SCRUM-1', assignee: 'internal-user-uuid' },
    }],
    chatResponse: null,
  });

  const selectedSchemas = new Map([['JIRA_UPDATE_ISSUE', {
    name: 'JIRA_UPDATE_ISSUE',
    toolkit: 'JIRA',
    parameters: {
      type: 'object',
      properties: { issue_key: { type: 'string' }, assignee: { type: 'string' } },
      required: ['issue_key'],
    },
  }]]);

  const result = await router._stageB_extractParams({
    message: 'Assign Jira issue SCRUM-1 to me',
    stageA: {
      selectedTools: [{ name: 'JIRA_UPDATE_ISSUE', sequence: 1, usePreviousOutput: false }],
    },
    selectedSchemas,
    context: { userId: 'internal-user-uuid' },
  });

  assert.equal(result.tools[0].params.issue_key, 'SCRUM-1');
  assert.equal(result.tools[0].params.assignee, 'me');
});

test('a Jira update resolves "above task" from recent conversation history', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.USER_TIMEZONE = 'Asia/Calcutta';
  router.callGemini = async () => JSON.stringify({
    tools: [{
      name: 'JIRA_UPDATE_ISSUE',
      sequence: 1,
      params: { description: 'We are integrating Jira to SwiftCollab through Atlassian.' },
    }],
  });

  const selectedSchemas = new Map([['JIRA_UPDATE_ISSUE', {
    name: 'JIRA_UPDATE_ISSUE',
    toolkit: 'JIRA',
    parameters: {
      type: 'object',
      properties: { issue_key: { type: 'string' }, description: { type: 'string' } },
      required: ['issue_key'],
    },
  }]]);

  const result = await router._stageB_extractParams({
    message: 'Add a description to the above task that we are integrating Jira to SwiftCollab through Atlassian',
    stageA: {
      selectedTools: [{ name: 'JIRA_UPDATE_ISSUE', sequence: 1, usePreviousOutput: false }],
    },
    selectedSchemas,
    context: {
      conversationHistory: [{ role: 'user', text: 'Assign Jira issue SCRUM-1 to me' }],
    },
  });

  assert.equal(result.tools[0].params.issue_key, 'SCRUM-1');
  assert.match(result.tools[0].params.description, /integrating Jira/i);
});

test('processPrompt reuses the conversation as its orchestration session', async () => {
  const orchestrator = Object.create(AssistantOrchestrator.prototype);
  const sessionIds = [];
  orchestrator.handleTurn = async input => {
    sessionIds.push(input.sessionId);
    return { type: 'chat', reply: 'ok' };
  };

  const input = {
    message: 'first',
    userId: 'user-1',
    entityId: 'entity-1',
    organizationId: 'org-1',
    conversationId: 'conversation-1',
  };
  await orchestrator.processPrompt(input);
  await orchestrator.processPrompt({ ...input, message: 'second' });

  assert.equal(sessionIds[0], sessionIds[1]);
  assert.match(sessionIds[0], /conversation-1$/);
});

test('reminder requests route to the connected calendar app', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.MAX_RELEVANT_TOOLKITS = 10;
  router.callGemini = async () => { throw new Error('LLM should not be needed'); };
  const selected = await router._selectRelevantToolkits(
    'pls set a google reminder tomorrow at 10 am go to saloon',
    ['GOOGLECALENDAR', 'GITHUB', 'SLACK', 'NOTION']
  );
  assert.deepEqual(selected, ['GOOGLECALENDAR']);
});

test('calendar create actions rank first for reminder requests', () => {
  const router = Object.create(ToolRouter.prototype);
  router.MAX_ROUTER_CANDIDATES = 10;
  const tools = Array.from({ length: 20 }, (_, index) => ({
    name: `GOOGLECALENDAR_ACTION_${index}`,
    description: `Calendar utility ${index}`,
    toolkit: 'GOOGLECALENDAR',
  }));
  tools.push({
    name: 'GOOGLECALENDAR_CREATE_EVENT',
    description: 'Create or schedule a calendar event with reminders',
    toolkit: 'GOOGLECALENDAR',
  });
  const shortlisted = router._shortlistTools(
    'set a reminder tomorrow at 10 am',
    tools
  );
  assert.equal(shortlisted[0].name, 'GOOGLECALENDAR_CREATE_EVENT');
});

test('high-confidence reminder requests select create-event without an LLM', () => {
  const router = Object.create(ToolRouter.prototype);
  const result = router._deterministicToolSelection(
    'pls set a google reminder tomorrow at 10 am go to saloon',
    [
      { name: 'GOOGLECALENDAR_FIND_EVENT', description: 'Find events' },
      { name: 'GOOGLECALENDAR_CREATE_EVENT', description: 'Create a calendar event' },
      { name: 'chat_response', description: 'Chat' },
    ]
  );
  assert.equal(result.deterministic, true);
  assert.equal(result.selectedTools[0].name, 'GOOGLECALENDAR_CREATE_EVENT');
});

test('a calendar phrase cannot collapse a dynamic multi-app request', () => {
  const router = Object.create(ToolRouter.prototype);
  const tools = [
    { name: 'GMAIL_SEND_EMAIL', description: 'Send email', toolkit: 'GMAIL' },
    { name: 'GOOGLECALENDAR_CREATE_EVENT', description: 'Create event', toolkit: 'GOOGLECALENDAR' },
    { name: 'GOOGLESHEETS_CREATE_SPREADSHEET', description: 'Create sheet', toolkit: 'GOOGLESHEETS' },
    { name: 'JIRA_UPDATE_ISSUE', description: 'Update issue', toolkit: 'JIRA' },
  ];
  const result = router._deterministicToolSelection(
    'Send a welcome email, schedule a meeting tomorrow, update a Google Sheet, and comment on Jira',
    tools
  );
  assert.equal(result, null);
});

test('short action follow-ups retain tool context', () => {
  const history = [
    { role: 'user', text: 'Find my GitHub repositories' },
    { role: 'assistant', text: 'I found your repositories.' },
  ];
  assert.equal(classifyToolIntent('show me all', ['GITHUB'], history).requiresTools, true);
  assert.equal(classifyToolIntent('send that', ['GITHUB', 'GMAIL'], history).requiresTools, true);
});

test('natural connection-list questions use the system status path', () => {
  const router = Object.create(ToolRouter.prototype);
  const examples = [
    'can you give me the list which are connected?',
    'can you check now what are connected',
    'show my connected apps',
    'which integrations are connected?',
  ];
  for (const message of examples) {
    assert.equal(router._looksLikeConnectionStatusQuery(message), true, message);
  }
});

test('a write request mentioning connected tools does not become a status check', () => {
  const router = Object.create(ToolRouter.prototype);
  assert.equal(
    router._looksLikeConnectionStatusQuery('append the tools I tried to connect and the completed actions to the sheet'),
    false
  );
});

test('connection status discovers live Composio accounts', async () => {
  const executor = new ExecutorV2({
    composio: {
      listConnectedAccounts: async (_toolkits, entityId) => {
        assert.equal(entityId, 'user_test');
        return { items: [{ toolkit: { slug: 'googlecalendar' } }] };
      },
    },
    query: null,
  });
  executor.frappeService = { isConfigured: () => false };

  const result = await executor._systemCheckConnections(
    { verifyWithComposio: true },
    { entityId: 'user_test' }
  );

  assert.deepEqual(result.toolkitsChecked, ['GOOGLECALENDAR']);
  assert.equal(result.connections.GOOGLECALENDAR.connected, true);
  assert.deepEqual(result.missing, []);
});

test('only connected requested toolkits are retained', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.composioToolSet = {
    getConnectedApps: async () => [{ toolkit: 'GITHUB' }],
  };

  assert.deepEqual(
    await router._connectedToolkits(['GITHUB', 'SLACK'], { entityId: 'user_1' }),
    ['GITHUB']
  );
});

test('connected toolkits are discovered when the UI sends no selection', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.composioToolSet = {
    getConnectedApps: async () => [{ toolkit: 'GITHUB' }, { toolkit: 'GMAIL' }],
  };
  router._hasConnectedFrappe = async () => false;

  assert.deepEqual(
    await router._connectedToolkits([], { entityId: 'user_1' }),
    ['GITHUB', 'GMAIL']
  );
});

test('tool prompts receive a small relevance-ranked shortlist', () => {
  const router = Object.create(ToolRouter.prototype);
  router.MAX_ROUTER_CANDIDATES = 5;
  const tools = Array.from({ length: 30 }, (_, index) => ({
    name: `GITHUB_ACTION_${index}`,
    description: `Unrelated GitHub action ${index}`,
    toolkit: 'GITHUB',
  }));
  tools.push({ name: 'GITHUB_LIST_REPOSITORIES', description: 'List repositories', toolkit: 'GITHUB' });
  tools.push({ name: 'chat_response', description: 'Chat', toolkit: 'SYSTEM' });

  const shortlist = router._shortlistTools('list my repositories', tools);
  assert.equal(shortlist.length, 6);
  assert.equal(shortlist[0].name, 'GITHUB_LIST_REPOSITORIES');
  assert.ok(shortlist.some(tool => tool.name === 'chat_response'));
});

test('explicit cross-app requests select only relevant apps from 12 connections', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.MAX_RELEVANT_TOOLKITS = 10;
  router.callGemini = async () => { throw new Error('LLM should not be needed'); };
  const connected = [
    'GITHUB', 'GMAIL', 'GOOGLECALENDAR', 'SLACK', 'JIRA', 'ASANA',
    'TRELLO', 'NOTION', 'DROPBOX', 'HUBSPOT', 'SALESFORCE', 'ZOOM',
  ];

  const selected = await router._selectRelevantToolkits(
    'Find my GitHub pull requests and email the summary through Gmail',
    connected
  );

  assert.deepEqual(selected, ['GITHUB', 'GMAIL']);
});

test('explicit requests retain ten connected applications in one plan', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.MAX_RELEVANT_TOOLKITS = 12;
  router.callGemini = async () => { throw new Error('LLM should not be needed'); };
  const connected = [
    'GITHUB', 'GMAIL', 'GOOGLECALENDAR', 'GOOGLESHEETS', 'SLACK',
    'JIRA', 'ASANA', 'TRELLO', 'NOTION', 'SALESFORCE', 'ZOOM', 'DROPBOX',
  ];
  const selected = await router._selectRelevantToolkits(
    'Create work in GitHub, Gmail, Google Calendar, Google Sheets, Slack, Jira, Asana, Trello, Notion, and Salesforce',
    connected
  );
  assert.deepEqual(selected, connected.slice(0, 10));
});

test('the action planner retains ten dynamic actions returned by the model', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.USER_TIMEZONE = 'UTC';
  router._parseJson = ToolRouter.prototype._parseJson;
  router._nowContext = ToolRouter.prototype._nowContext;
  router._isMultiActionRequest = ToolRouter.prototype._isMultiActionRequest;
  const availableTools = Array.from({ length: 10 }, (_, index) => ({
    name: `APP_${index + 1}_CREATE_ITEM`,
    description: `Create an item in app ${index + 1}`,
    toolkit: `APP_${index + 1}`,
  }));
  router.callGemini = async systemPrompt => {
    assert.match(systemPrompt, /10 or more different apps/);
    return JSON.stringify({
      selectedTools: availableTools.map((tool, index) => ({
        name: tool.name,
        sequence: index < 5 ? 1 : 2,
        usePreviousOutput: index >= 5,
      })),
    });
  };
  const result = await router._stageA_selectTools({
    message: 'Perform all ten requested app actions',
    availableTools,
    context: { userTimeZone: 'Asia/Kolkata' },
  });
  assert.equal(result.selectedTools.length, 10);
  assert.deepEqual(result.selectedTools.map(tool => tool.name), availableTools.map(tool => tool.name));
});

test('the normal action planner never exposes the internal connection check tool', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.USER_TIMEZONE = 'UTC';
  router._parseJson = ToolRouter.prototype._parseJson;
  router._nowContext = ToolRouter.prototype._nowContext;
  router._isMultiActionRequest = ToolRouter.prototype._isMultiActionRequest;
  router.callGemini = async systemPrompt => {
    assert.doesNotMatch(systemPrompt, /SYSTEM_CHECK_CONNECTIONS/);
    return JSON.stringify({ selectedTools: [{ name: 'GMAIL_SEND_EMAIL', sequence: 1 }] });
  };
  const result = await router._stageA_selectTools({
    message: 'send an email',
    availableTools: [
      { name: 'SYSTEM_CHECK_CONNECTIONS', description: 'internal', toolkit: 'SYSTEM' },
      { name: 'GMAIL_SEND_EMAIL', description: 'send email', toolkit: 'GMAIL' },
    ],
    context: {},
  });
  assert.deepEqual(result.selectedTools.map(tool => tool.name), ['GMAIL_SEND_EMAIL']);
});

test('planner completeness restores every explicit action omitted by a small model', () => {
  const router = Object.create(ToolRouter.prototype);
  router._toolkitSearchTerms = ToolRouter.prototype._toolkitSearchTerms;
  router._uniqueCapabilityMatches = ToolRouter.prototype._uniqueCapabilityMatches;
  const tools = [
    { name: 'GMAIL_SEND_EMAIL', description: 'Send an email', toolkit: 'GMAIL' },
    { name: 'GOOGLECALENDAR_CREATE_EVENT', description: 'Create a calendar event', toolkit: 'GOOGLECALENDAR' },
    { name: 'GOOGLESHEETS_CREATE_SPREADSHEET', description: 'Create a spreadsheet', toolkit: 'GOOGLESHEETS' },
    { name: 'GOOGLESHEETS_APPEND_VALUES', description: 'Append rows of values', toolkit: 'GOOGLESHEETS' },
    { name: 'JIRA_ADD_COMMENT', description: 'Add a comment to an issue', toolkit: 'JIRA' },
    { name: 'JIRA_SEARCH_ISSUES', description: 'Search issues', toolkit: 'JIRA' },
  ];
  const result = router._ensureRequestedActionsCovered(
    'send a onboarding email to bhemaraju.138@gmail.com and , schedule a call in google callender at tomorrow at 14 pm ist and update the above information in a google sheet naming it as scheduled events , and also update the comment in the SCRUM-1 jira with the above task done as information',
    [{ name: 'GMAIL_SEND_EMAIL', sequence: 1, usePreviousOutput: false }],
    tools
  );
  assert.deepEqual(new Set(result.map(tool => tool.name)), new Set([
    'GMAIL_SEND_EMAIL',
    'GOOGLECALENDAR_CREATE_EVENT',
    'GOOGLESHEETS_CREATE_SPREADSHEET',
    'GOOGLESHEETS_APPEND_VALUES',
    'JIRA_ADD_COMMENT',
  ]));
});

test('indirect recipient data restores a read step and creates typed fan-out', () => {
  const router = Object.create(ToolRouter.prototype);
  router._toolkitSearchTerms = ToolRouter.prototype._toolkitSearchTerms;
  const available = [
    {
      name: 'GMAIL_SEND_EMAIL',
      description: 'Send an email',
      toolkit: 'GMAIL',
      parameters: {
        properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      name: 'GOOGLESHEETS_GET_VALUES',
      description: 'Read values from a Google Sheet range',
      toolkit: 'GOOGLESHEETS',
      parameters: {
        properties: { spreadsheet_id: { type: 'string' }, range: { type: 'string' } },
        required: ['spreadsheet_id', 'range'],
      },
    },
  ];
  const message = 'send an invitation to all emails present in https://docs.google.com/spreadsheets/d/sheet-123/edit';
  const selected = router._ensureIndirectDataSourcesCovered(
    message,
    [{ name: 'GMAIL_SEND_EMAIL', sequence: 1 }],
    available
  );
  assert.deepEqual(new Set(selected.map(tool => tool.name)), new Set(['GMAIL_SEND_EMAIL', 'GOOGLESHEETS_GET_VALUES']));

  const schemas = new Map(available.map(tool => [tool.name, tool]));
  let tools = [
    { id: 'mail', name: 'GMAIL_SEND_EMAIL', sequence: 1, params: { to: message, subject: 'Invitation', body: 'Welcome' } },
    { id: 'sheet', name: 'GOOGLESHEETS_GET_VALUES', sequence: 1, params: {} },
  ];
  tools = router._applyExplicitSourceReferences(tools, schemas, message);
  tools = router._planIndirectFanOut(tools, schemas, message);
  const mail = tools.find(tool => tool.id === 'mail');
  const sheet = tools.find(tool => tool.id === 'sheet');
  assert.equal(sheet.params.spreadsheet_id, 'https://docs.google.com/spreadsheets/d/sheet-123/edit');
  assert.equal(sheet.params.range, 'A:Z');
  assert.equal(mail.params.to, '_inject_each');
  assert.equal(mail.fanOut.sourceTaskId, 'sheet');
  assert.deepEqual(mail.dependsOn, ['sheet']);
});

test('typed recipient validation rejects instructions when no fan-out exists', () => {
  const router = Object.create(ToolRouter.prototype);
  router._findDateTimeMissingTimezone = () => [];
  router._collectMissingRequiredTopLevel = ToolRouter.prototype._collectMissingRequiredTopLevel;
  router._getFieldPriority = ToolRouter.prototype._getFieldPriority;
  const schemas = new Map([['GMAIL_SEND_EMAIL', {
    parameters: {
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'subject', 'body'],
    },
  }]]);
  const result = router._validateAgainstSchemas([{
    name: 'GMAIL_SEND_EMAIL',
    params: { to: 'all emails in the sheet', subject: 'Hi', body: 'Welcome' },
  }], schemas);
  assert.ok(result.missing.some(item => item.field === 'to' && item.reason === 'invalid_typed_recipient'));
});

test('executor extracts, deduplicates and executes one action per source email', async () => {
  const executor = new ExecutorV2({ composio: {}, query: null });
  const recipients = executor._extractFanOutValues({ values: [
    ['Email'],
    ['One@Example.com'],
    ['one@example.com', 'two@example.com'],
  ] }, 'email');
  assert.deepEqual([...new Set(recipients)], ['one@example.com', 'two@example.com']);

  const executed = [];
  executor._executeStepWithRetry = async step => {
    executed.push(step.params.to);
    return { stepId: step.id, action: step.action, success: true, status: 'success' };
  };
  const result = await executor._executeFanOutStep({
    id: 'mail',
    type: 'tool',
    action: 'GMAIL_SEND_EMAIL',
    params: { to: '_inject_each', subject: 'Hello', body: 'Welcome' },
    fanOut: { sourceTaskId: 'sheet', targetParam: 'to', valueType: 'email', maxItems: 100 },
  }, {
    sheet: { success: true, data: { data: { values: [['one@example.com'], ['two@example.com']] } } },
  }, 'entity', 'user', {}, {});
  assert.equal(result.success, true);
  assert.deepEqual(executed, ['one@example.com', 'two@example.com']);
});

test('retry context retains the failed action data-source dependency', () => {
  const orchestrator = Object.create(AssistantOrchestrator.prototype);
  const tools = [
    { id: 'sheet', name: 'GOOGLESHEETS_GET_VALUES', dependsOn: [] },
    { id: 'mail', name: 'GMAIL_SEND_EMAIL', dependsOn: ['sheet'], fanOut: { sourceTaskId: 'sheet' } },
    { id: 'jira', name: 'JIRA_ADD_COMMENT', dependsOn: [] },
  ];
  const retry = orchestrator._buildRetryToolClosure(tools, new Set(['GMAIL_SEND_EMAIL']));
  assert.deepEqual(retry.map(tool => tool.id), ['sheet', 'mail']);
});

test('planner reconciliation removes unrelated actions when the user requested a sheet update', () => {
  const router = Object.create(ToolRouter.prototype);
  router._toolkitSearchTerms = ToolRouter.prototype._toolkitSearchTerms;
  router._uniqueCapabilityMatches = ToolRouter.prototype._uniqueCapabilityMatches;
  const tools = [
    { name: 'GOOGLESHEETS_GET_VALUES', description: 'Read values', toolkit: 'GOOGLESHEETS' },
    { name: 'GOOGLESHEETS_UPDATE_VALUES', description: 'Update cells', toolkit: 'GOOGLESHEETS' },
    { name: 'GOOGLEDRIVE_CREATE_FILE', description: 'Create a file', toolkit: 'GOOGLEDRIVE' },
  ];
  const result = router._ensureRequestedActionsCovered(
    'try again to update the spreadsheet',
    [{ name: 'GOOGLESHEETS_GET_VALUES', sequence: 1 }, { name: 'GOOGLEDRIVE_CREATE_FILE', sequence: 1 }],
    tools
  );
  assert.deepEqual(result.map(tool => tool.name), ['GOOGLESHEETS_UPDATE_VALUES']);
});

test('planner reconciliation preserves multiple requested actions in the same app', () => {
  const router = Object.create(ToolRouter.prototype);
  router._toolkitSearchTerms = ToolRouter.prototype._toolkitSearchTerms;
  router._uniqueCapabilityMatches = ToolRouter.prototype._uniqueCapabilityMatches;
  const tools = [
    { name: 'JIRA_SEARCH_ISSUES', description: 'Search Jira issues', toolkit: 'JIRA' },
    { name: 'JIRA_ADD_COMMENT', description: 'Add a comment to a Jira issue', toolkit: 'JIRA' },
  ];
  const result = router._ensureRequestedActionsCovered(
    'search Jira for SCRUM-1 and comment on Jira issue SCRUM-1 that onboarding is complete',
    [{ name: 'JIRA_SEARCH_ISSUES', sequence: 1 }],
    tools
  );
  assert.deepEqual(new Set(result.map(tool => tool.name)), new Set([
    'JIRA_SEARCH_ISSUES',
    'JIRA_ADD_COMMENT',
  ]));
});

test('independent multi-app writes never create self or circular dependencies', () => {
  const router = Object.create(ToolRouter.prototype);
  const tools = [
    { id: 'mail', name: 'GMAIL_SEND_EMAIL', sequence: 1, params: { to: 'adeebakishwar@gmail.com', body: 'Welcome' } },
    { id: 'sheet', name: 'GOOGLESHEETS_CREATE_SPREADSHEET', sequence: 2, params: { title: 'scheduled events' } },
    { id: 'jira', name: 'JIRA_ADD_COMMENT', sequence: 3, params: { issue_key: 'SCRUM-1', comment: 'Onboarding completed' } },
    { id: 'calendar', name: 'GOOGLECALENDAR_CREATE_EVENT', sequence: 4, params: { summary: 'Onboarding call' } },
    { id: 'append', name: 'GOOGLESHEETS_APPEND_VALUES', sequence: 5, params: { values: [['Onboarding call']] } },
  ];
  const schemas = new Map([
    ['GMAIL_SEND_EMAIL', { description: 'Send an email', parameters: { properties: { body: { type: 'string' } }, required: ['body'] } }],
    ['GOOGLESHEETS_CREATE_SPREADSHEET', { description: 'Create a spreadsheet', parameters: { properties: { title: { type: 'string' } }, required: ['title'] } }],
    ['JIRA_ADD_COMMENT', { description: 'Add a Jira comment', parameters: { properties: { comment: { type: 'string' } }, required: ['comment'] } }],
    ['GOOGLECALENDAR_CREATE_EVENT', { description: 'Create a calendar event', parameters: { properties: { description: { type: 'string' } }, required: [] } }],
    ['GOOGLESHEETS_APPEND_VALUES', {
      description: 'Append spreadsheet values',
      parameters: {
        properties: { spreadsheet_id: { type: 'string' }, values: { type: 'array' } },
        required: ['spreadsheet_id', 'values'],
      },
    }],
  ]);

  const planned = router._enforceDataDependencies(tools, schemas,
    'send an onboarding email, schedule a call, create a sheet, and comment on Jira');
  const append = planned.find(tool => tool.id === 'append');

  assert.ok(append.dependsOn.includes('sheet'));
  for (const tool of planned) {
    assert.ok(!(tool.dependsOn || []).includes(tool.id), `${tool.name} depends on itself`);
  }
  assert.equal(ExecutorV2.prototype._validateDag(planned).valid, true);
});

test('an invalid or empty execution is never reported as completed zero of zero', async () => {
  const orchestrator = Object.create(AssistantOrchestrator.prototype);
  const message = await orchestrator._formatExecutionSummary({
    success: false,
    results: [],
    error: 'Invalid execution DAG: circular dependency detected',
  });
  assert.match(message, /^❌/);
  assert.match(message, /Invalid execution DAG/);
  assert.doesNotMatch(message, /Completed \(0\/0 actions\)/);
});

test('sheet typo follow-ups still enter connected-app routing', () => {
  assert.equal(classifyToolIntent('try again to update the spreed sheet', ['GOOGLESHEETS']).requiresTools, true);
});

test('preflight time overrides stay scoped to the calendar action', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.USER_TIMEZONE = 'UTC';
  router._inferToolkit = ToolRouter.prototype._inferToolkit;
  router._extractTimeFromMessage = ToolRouter.prototype._extractTimeFromMessage;
  router._getOffsetForTimeZone = ToolRouter.prototype._getOffsetForTimeZone;
  router._getDateInTimezone = ToolRouter.prototype._getDateInTimezone;
  const schemas = new Map([
    ['GOOGLECALENDAR_CREATE_EVENT', { toolkit: 'GOOGLECALENDAR', parameters: { properties: { summary: {}, start: {}, end: {} }, required: ['summary', 'start', 'end'] } }],
    ['GMAIL_SEND_EMAIL', { toolkit: 'GMAIL', parameters: { properties: { to: {}, subject: {}, body: {} }, required: ['to', 'subject', 'body'] } }],
  ]);
  const tools = [
    { id: 't1', name: 'GOOGLECALENDAR_CREATE_EVENT', params: { summary: 'Onboarding', start: 'wrong', end: 'wrong' } },
    { id: 't2', name: 'GMAIL_SEND_EMAIL', params: { to: 'user@example.com', subject: 'Welcome', body: 'Hello' } },
  ];
  const preflight = await router._runPreflight({
    tools,
    selectedSchemas: schemas,
    availableTools: [],
    context: { userTimeZone: 'Asia/Kolkata', entityId: 'user_1' },
    message: 'schedule tomorrow at 2 pm IST',
    connections: [],
  });
  const merged = router._mergePreflightResults(tools, preflight);
  assert.match(merged[0].params.start, /14:00:00\+05:30$/);
  assert.equal(merged[1].params.start, undefined);
  assert.equal(merged[1].params.end, undefined);
});

test('an explicit IST timezone overrides a UTC client fallback', () => {
  const router = Object.create(ToolRouter.prototype);
  router.USER_TIMEZONE = 'UTC';
  router._timeZoneFromMessage = ToolRouter.prototype._timeZoneFromMessage;
  router._getOffsetForTimeZone = ToolRouter.prototype._getOffsetForTimeZone;
  router._getDateInTimezone = ToolRouter.prototype._getDateInTimezone;
  const value = router._extractTimeFromMessage('tomorrow at 14:00 IST', 'UTC');
  assert.equal(value.timezone, 'Asia/Kolkata');
  assert.match(value.start, /14:00:00\+05:30$/);
});

test('a created resource is injected into a later action requiring its id', () => {
  const router = Object.create(ToolRouter.prototype);
  router._containsInjectMarker = ToolRouter.prototype._containsInjectMarker;
  router._pickInjectionFieldFromSchema = ToolRouter.prototype._pickInjectionFieldFromSchema;
  const schemas = new Map([
    ['GOOGLESHEETS_CREATE_SPREADSHEET', { description: 'Create spreadsheet', parameters: { properties: { title: { type: 'string' } }, required: ['title'] } }],
    ['GOOGLESHEETS_APPEND_VALUES', { description: 'Append rows to spreadsheet', parameters: { properties: { spreadsheet_id: { type: 'string' }, values: { type: 'array' } }, required: ['spreadsheet_id', 'values'] } }],
  ]);
  const result = router._enforceDataDependencies([
    { name: 'GOOGLESHEETS_CREATE_SPREADSHEET', sequence: 1, params: { title: 'scheduled events' } },
    { name: 'GOOGLESHEETS_APPEND_VALUES', sequence: 2, params: { values: [['Event', 'Status']] } },
  ], schemas, 'create a spreadsheet and add the information there');
  assert.deepEqual(result[1].dependsOn, [result[0].id]);
  assert.equal(result[1].injectFrom.spreadsheet_id, `${result[0].id}.spreadsheetId`);
  assert.equal(result[1].params.spreadsheet_id, '_inject_from_previous');
});

test('slot filler asks for one action-specific value per turn', () => {
  const filler = Object.create(UnifiedSlotFiller.prototype);
  const session = { askedKeys: new Set() };
  const batch = filler._selectNextBatch(session, [
    { toolId: 'calendar', field: 'summary' },
    { toolId: 'sheet', field: 'title' },
  ]);
  assert.deepEqual(batch, [{ toolId: 'calendar', field: 'summary' }]);
});

test('executor finds a created resource id inside provider response envelopes', () => {
  const executor = new ExecutorV2({ composio: {}, query: null });
  assert.equal(
    executor._findInjectionValue({ data: { result: { spreadsheetId: 'sheet-123' } } }, 'spreadsheet_id', ['spreadsheetId']),
    'sheet-123'
  );
});

test('Google scope failures produce a reconnect instruction', () => {
  const executor = new ExecutorV2({ composio: {}, query: null });
  assert.match(
    executor._friendlyConnectorError('GOOGLESHEETS_UPDATE_VALUES', new Error('Insufficient Permission')),
    /Reconnect your Google account/i
  );
});

test('plain retry commands are distinguished from changed requests', () => {
  const orchestrator = Object.create(AssistantOrchestrator.prototype);
  assert.equal(orchestrator._isPureRetryRequest('try again'), true);
  assert.equal(orchestrator._isPureRetryRequest('try again, I changed the permission'), true);
  assert.equal(orchestrator._isPureRetryRequest('try again to update the spreadsheet'), false);
});

test('slot filling preserves the exact routed provider schema', async () => {
  let composioSchemaLookups = 0;
  const filler = new UnifiedSlotFiller({
    composioToolSet: {
      getToolsForToolkit: async () => {
        composioSchemaLookups += 1;
        return [{
          name: 'GMAIL_SEND_EMAIL',
          parameters: { required: ['to', 'body', 'extra_recipients'] },
        }];
      },
    },
    callGemini: async () => '',
  });
  const routedSchema = {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'body'],
  };
  const session = await filler.startSession('native_schema_test', {
    tools: [{ name: 'GMAIL_SEND_EMAIL', composio_action: 'GMAIL_SEND_EMAIL', params: {} }],
    schemas: { GMAIL_SEND_EMAIL: routedSchema },
  });
  assert.equal(composioSchemaLookups, 0);
  assert.equal(session.schemaByToolId[session.tools[0].id], routedSchema);
});

test('parameter planning allows requested content generation without inventing identifiers', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.USER_TIMEZONE = 'Asia/Kolkata';
  router._parseJson = ToolRouter.prototype._parseJson;
  router._formatContextForPrompt = () => '';
  router._nowContext = ToolRouter.prototype._nowContext;
  router._inferToolkit = ToolRouter.prototype._inferToolkit;
  router.callGemini = async systemPrompt => {
    assert.match(systemPrompt, /GENERATED CONTENT \(PROVIDER-NEUTRAL\)/);
    assert.match(systemPrompt, /warm 200-word welcome email/);
    return JSON.stringify({
      tools: [{
        name: 'GMAIL_SEND_EMAIL',
        sequence: 1,
        params: {
          to: 'new.user@example.com',
          subject: 'Welcome to SwiftCollab',
          body: 'Welcome '.repeat(200).trim(),
        },
      }],
    });
  };
  const selectedSchemas = new Map([['GMAIL_SEND_EMAIL', {
    name: 'GMAIL_SEND_EMAIL',
    toolkit: 'GMAIL',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'body'],
    },
  }]]);
  const result = await router._stageB_extractParams({
    message: 'Send new.user@example.com a warm welcome email with a 200 word body',
    selectedSchemas,
    stageA: { selectedTools: [{ name: 'GMAIL_SEND_EMAIL', sequence: 1, usePreviousOutput: false }] },
    context: {},
  });
  assert.equal(result.tools[0].params.to, 'new.user@example.com');
  assert.match(result.tools[0].params.body, /Welcome/);
});

test('explicit Jira keys are preserved for comment actions even when the model omits them', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.USER_TIMEZONE = 'Asia/Kolkata';
  router._parseJson = ToolRouter.prototype._parseJson;
  router._formatContextForPrompt = () => '';
  router._nowContext = ToolRouter.prototype._nowContext;
  router._inferToolkit = ToolRouter.prototype._inferToolkit;
  router.callGemini = async () => JSON.stringify({
    tools: [{ name: 'JIRA_ADD_COMMENT', sequence: 1, params: { comment: 'Onboarding completed' } }],
  });
  const selectedSchemas = new Map([['JIRA_ADD_COMMENT', {
    name: 'JIRA_ADD_COMMENT',
    toolkit: 'JIRA',
    parameters: {
      type: 'object',
      properties: { issue_key: { type: 'string' }, comment: { type: 'string' } },
      required: ['issue_key', 'comment'],
    },
  }]]);
  const result = await router._stageB_extractParams({
    message: 'Add a comment to SCRUM -1 that onboarding is completed',
    selectedSchemas,
    stageA: { selectedTools: [{ name: 'JIRA_ADD_COMMENT', sequence: 1 }] },
    context: {},
  });
  assert.equal(result.tools[0].params.issue_key, 'SCRUM-1');
});

test('confirmation and execution summaries never hide later actions', async () => {
  const tools = Array.from({ length: 10 }, (_, index) => ({
    name: `APP_${index + 1}_CREATE_ITEM`,
    composio_action: `APP_${index + 1}_CREATE_ITEM`,
    params: {},
  }));
  const composer = new AssistantComposer({
    callGemini: async () => 'Only one action\n\nReady?',
  });
  const confirmation = await composer.composeConfirmationMessage({ tools, originalMessage: 'run all ten' });
  assert.match(confirmation, /10 actions/);
  assert.match(confirmation, /10\. APP_10_CREATE_ITEM/);

  const execution = await composer.composeExecutionDeterministic({
    executionResult: {
      results: tools.map((tool, index) => ({
        action: tool.name,
        success: false,
        error: `failure ${index + 1}`,
      })),
    },
  });
  assert.match(execution, /APP_1_CREATE_ITEM: failure 1/);
  assert.match(execution, /APP_10_CREATE_ITEM: failure 10/);
});

test('ambiguous requests use a compact app-name selection step', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.MAX_RELEVANT_TOOLKITS = 10;
  router._parseJson = ToolRouter.prototype._parseJson;
  router.callGemini = async (systemPrompt, userPrompt) => {
    assert.match(systemPrompt, /Connected app toolkits/);
    assert.doesNotMatch(systemPrompt, /AVAILABLE TOOLS/);
    assert.equal(userPrompt, 'Create a task for the launch');
    return '{"toolkits":["ASANA"]}';
  };

  const selected = await router._selectRelevantToolkits(
    'Create a task for the launch',
    ['ASANA', 'TRELLO', 'CLICKUP', 'JIRA']
  );
  assert.deepEqual(selected, ['ASANA']);
});

test('cross-app tool shortlists preserve candidates from every selected app', () => {
  const router = Object.create(ToolRouter.prototype);
  router.MAX_ROUTER_CANDIDATES = 30;
  const tools = ['GITHUB', 'GMAIL', 'SLACK', 'JIRA'].flatMap(toolkit =>
    Array.from({ length: 20 }, (_, index) => ({
      name: `${toolkit}_ACTION_${index}`,
      description: `${toolkit} action ${index}`,
      toolkit,
    }))
  );
  tools.push({ name: 'chat_response', description: 'Chat', toolkit: 'SYSTEM' });

  const shortlist = router._shortlistTools('find issues and email a summary to slack', tools);
  const selectedToolkits = new Set(shortlist.map(tool => tool.toolkit));
  for (const toolkit of ['GITHUB', 'GMAIL', 'SLACK', 'JIRA']) {
    assert.ok(selectedToolkits.has(toolkit), `missing ${toolkit}`);
  }
  assert.ok(shortlist.length <= 31);
});

test('connected app tool catalogs are fetched in parallel', async () => {
  const router = Object.create(ToolRouter.prototype);
  router.MAX_TOOLS_PER_TOOLKIT = 80;
  router.CACHE_TTL = 60_000;
  router.toolCache = new Map();
  router.systemCheckTool = () => ({ name: 'SYSTEM_CHECK_CONNECTIONS', toolkit: 'SYSTEM' });
  router.chatTool = () => ({ name: 'chat_response', toolkit: 'SYSTEM' });
  router.normalizeSchema = (tool, toolkit) => ({ ...tool, toolkit });
  let active = 0;
  let maxActive = 0;
  router.composioToolSet = {
    getToolsForToolkit: async toolkit => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active -= 1;
      return [{ name: `${toolkit}_ACTION` }];
    },
  };

  const result = await router.getToolsFromComposio(
    ['GITHUB', 'GMAIL', 'SLACK'],
    'user_1',
    { userId: '1' }
  );
  assert.equal(maxActive, 3);
  assert.equal(result.length, 5);
});
