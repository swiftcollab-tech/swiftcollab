const assert = require('node:assert/strict');
const test = require('node:test');
const ToolRouter = require('../orchestration/ToolRouter');
const AssistantOrchestrator = require('../orchestration/AssistantOrchestrator');
const { ExecutorV2 } = require('../orchestration/executorV2');
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
