const { McpClientProvider, normalizeMcpEndpoint } = require('../mcp');

const REMOTE_TO_ACTION = Object.freeze({
  search_doctypes: 'FRAPPE_SEARCH_DOCTYPES',
  get_doctype_schema: 'FRAPPE_GET_DOCTYPE_SCHEMA',
  search_methods: 'FRAPPE_SEARCH_METHODS',
  get_method_schema: 'FRAPPE_GET_METHOD_SCHEMA',
  list_document_methods: 'FRAPPE_LIST_DOCUMENT_METHODS',
  list_documents: 'FRAPPE_LIST_DOCUMENTS',
  get_document: 'FRAPPE_GET_DOCUMENT',
  count_documents: 'FRAPPE_COUNT_DOCUMENTS',
  create_document: 'FRAPPE_CREATE_DOCUMENT',
  update_document: 'FRAPPE_UPDATE_DOCUMENT',
  delete_document: 'FRAPPE_DELETE_DOCUMENT',
  call_method: 'FRAPPE_CALL_METHOD',
  call_document_method: 'FRAPPE_CALL_DOCUMENT_METHOD',
});
const ACTION_TO_REMOTE = Object.freeze(Object.fromEntries(
  Object.entries(REMOTE_TO_ACTION).map(([remote, action]) => [action, remote])
));

class FrappeMcpProvider {
  constructor({ client = new McpClientProvider() } = {}) {
    this.client = client;
  }

  normalizeTools(tools) {
    return (tools || [])
      .filter(tool => REMOTE_TO_ACTION[tool.name])
      .map(tool => ({
        name: REMOTE_TO_ACTION[tool.name],
        description: tool.description || `ERPNext MCP tool: ${tool.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
        toolkit: 'FRAPPE',
        provider: 'mcp',
        remoteToolName: tool.name,
      }));
  }

  async testCredentials(baseUrl, apiKey, apiSecret) {
    const result = await this.client.listTools({ serverUrl: baseUrl, apiKey, apiSecret });
    const tools = this.normalizeTools(result.tools);
    if (!tools.length) throw new Error('The Frappe MCP server connected but did not expose supported ERPNext tools');
    return {
      success: true,
      finalUrl: result.endpoint.replace(/\/api\/v2\/mcp\/?$/, ''),
      mcpEndpoint: result.endpoint,
      tools,
      user: 'Frappe MCP user',
      company: null,
      version: '16+',
      message: `Connected to Frappe MCP with ${tools.length} supported tools`,
    };
  }

  async discoverTools(credentials) {
    const result = await this.client.listTools({
      serverUrl: credentials.mcpEndpoint || credentials.baseUrl,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
    });
    return this.normalizeTools(result.tools);
  }

  supportsAction(actionName) {
    return Boolean(ACTION_TO_REMOTE[String(actionName || '').toUpperCase()]);
  }

  async execute(credentials, actionName, params) {
    const normalized = String(actionName || '').toUpperCase();
    const remoteToolName = ACTION_TO_REMOTE[normalized];
    if (!remoteToolName) throw new Error(`Unsupported Frappe MCP action: ${actionName}`);
    return this.client.callTool({
      serverUrl: credentials.mcpEndpoint || normalizeMcpEndpoint(credentials.baseUrl),
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
    }, remoteToolName, params || {});
  }
}

const frappeMcpProvider = new FrappeMcpProvider();

module.exports = { FrappeMcpProvider, frappeMcpProvider, REMOTE_TO_ACTION, ACTION_TO_REMOTE };
