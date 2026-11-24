const { frappeConnectionManager } = require('./FrappeConnectionManager');
const { frappeSchemaService } = require('./FrappeSchemaService');
const { executeFrappeAction } = require('./FrappeClient');
const { frappeMcpProvider } = require('./FrappeMcpProvider');

class FrappeProviderService {
  async testConnection({ provider = 'mcp', baseUrl, apiKey, apiSecret }) {
    const normalized = String(provider || 'mcp').toLowerCase();
    if (normalized === 'mcp') {
      return frappeMcpProvider.testCredentials(baseUrl, apiKey, apiSecret);
    }
    if (normalized === 'native') {
      return frappeConnectionManager.testCredentials(baseUrl, apiKey, apiSecret);
    }
    throw new Error("provider must be either 'mcp' or 'native'");
  }

  async getAvailableTools(userId, connectionName = 'Default ERPNext') {
    const credentials = await frappeConnectionManager.getCredentials(userId, connectionName);
    if (!credentials) return [];
    if (credentials.provider === 'mcp') {
      if (Array.isArray(credentials.mcpTools) && credentials.mcpTools.length) {
        return credentials.mcpTools;
      }
      return frappeMcpProvider.discoverTools(credentials);
    }
    return frappeSchemaService.getAvailableTools(userId, connectionName);
  }

  async getConnectionStatus(userId, connectionName = 'Default ERPNext') {
    const connection = await frappeConnectionManager.getConnection(userId, connectionName);
    return {
      connected: connection?.status === 'active',
      status: connection?.status || 'disconnected',
      provider: connection?.provider || null,
      connection,
    };
  }

  async supportsAction(userId, actionName, connectionName = 'Default ERPNext') {
    const credentials = await frappeConnectionManager.getCredentials(userId, connectionName);
    if (!credentials) return false;
    if (credentials.provider === 'mcp') return frappeMcpProvider.supportsAction(actionName);
    return String(actionName || '').startsWith('FRAPPE_');
  }

  async executeAction(userId, actionName, params = {}, connectionName = 'Default ERPNext') {
    const credentials = await frappeConnectionManager.getCredentials(userId, connectionName);
    if (!credentials) throw new Error('No ERPNext connection configured. Please connect ERPNext first.');
    if (credentials.provider !== 'mcp') {
      return executeFrappeAction(userId, actionName, params, connectionName);
    }

    const startedAt = Date.now();
    try {
      const result = await frappeMcpProvider.execute(credentials, actionName, params);
      if (!result.success) throw new Error(result.error || `${actionName} failed`);
      await frappeConnectionManager.updateConnectionStatus(credentials.connectionId, { success: true });
      await frappeConnectionManager.logExecution(credentials.connectionId, userId, {
        actionName,
        doctype: params.doctype || null,
        documentName: params.name || null,
        requestParams: params,
        responseData: result.data,
        status: 'success',
        errorMessage: null,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      await frappeConnectionManager.updateConnectionStatus(credentials.connectionId, {
        success: false,
        error: error.message,
      });
      await frappeConnectionManager.logExecution(credentials.connectionId, userId, {
        actionName,
        doctype: params.doctype || null,
        documentName: params.name || null,
        requestParams: params,
        responseData: null,
        status: 'error',
        errorMessage: error.message,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }
}

const frappeProviderService = new FrappeProviderService();

module.exports = { FrappeProviderService, frappeProviderService };
