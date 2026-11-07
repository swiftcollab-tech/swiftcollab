const googleWorkspace = require('../services/googleWorkspaceService');
const jira = require('../services/jiraConnectorService');
const { frappeConnectionManager, executeFrappeAction } = require('./frappe');

const googleWorkspaceConnector = {
  canExecuteActions: true,
  async initiateConnection({ organizationId, userId }) {
    const result = await googleWorkspace.startConnection({ organizationId, userId });
    return { redirectUrl: result.authorizationUrl, status: 'PENDING' };
  },
  async completeConnection({ state, code }) {
    return googleWorkspace.completeConnection({ state, code });
  },
  async getConnectionStatus({ organizationId, userId }) {
    const result = await googleWorkspace.status(organizationId, userId);
    return { ...result, connected: result.status === 'connected' };
  },
  async disconnect({ organizationId, userId }) {
    return googleWorkspace.disconnect(organizationId, userId);
  },
  supportsAction(actionName) {
    return googleWorkspace.supportsAction(actionName);
  },
  async executeAction({ actionName, params, organizationId, userId }) {
    const data = await googleWorkspace.executeAction({ organizationId, userId, actionName, params });
    return { success: true, successful: true, data, error: null };
  },
  getTools({ app } = {}) {
    const tools = googleWorkspace.getTools();
    return app?.actionPrefix ? tools.filter(tool => tool.name.startsWith(app.actionPrefix)) : tools;
  },
};

const frappeConnector = {
  canExecuteActions: true,
  async getConnectionStatus({ userId }) {
    const connected = await frappeConnectionManager.hasActiveConnection(userId);
    return { connected, status: connected ? 'connected' : 'disconnected' };
  },
  supportsAction(actionName) {
    return String(actionName || '').startsWith('FRAPPE_');
  },
  async executeAction({ actionName, params, userId }) {
    return executeFrappeAction(userId, actionName, params);
  },
};

const jiraConnector = {
  canExecuteActions: true,
  async initiateConnection({ organizationId, userId }) {
    const result = await jira.startConnection({ organizationId, userId });
    return { redirectUrl: result.authorizationUrl, connectionAttemptId: result.connectionAttemptId, status: 'PENDING' };
  },
  async completeConnection({ state, code }) {
    return jira.completeConnection({ state, code });
  },
  async getConnectionStatus({ organizationId, connectionAttemptId }) {
    return jira.status(organizationId, connectionAttemptId);
  },
  async selectResource({ organizationId, resourceId, connectionId }) {
    return jira.selectResource({ organizationId, resourceId, connectionId });
  },
  async setActiveResource({ organizationId, connectionId }) {
    return jira.setPrimaryConnection({ organizationId, connectionId });
  },
  async disconnect({ organizationId, connectionId }) {
    return jira.disconnect(organizationId, connectionId);
  },
  supportsAction(actionName) {
    return jira.supportsAction(actionName);
  },
  async executeAction({ actionName, params, organizationId, userId }) {
    const data = await jira.executeAction({ organizationId, actionName, params, userId });
    return { success: true, successful: true, data, error: null };
  },
  getTools() {
    return jira.getTools();
  },
};

function createDirectConnectors() {
  return {
    google_workspace: googleWorkspaceConnector,
    frappe: frappeConnector,
    jira: jiraConnector,
  };
}

module.exports = { createDirectConnectors };
