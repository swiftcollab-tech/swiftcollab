const googleWorkspace = require('../services/googleWorkspaceService');
const jira = require('../services/jiraConnectorService');
const { frappeConnectionManager, executeFrappeAction } = require('./frappe');

const googleWorkspaceConnector = {
  canExecuteActions: false,
  async initiateConnection({ organizationId, userId }) {
    const result = await googleWorkspace.startConnection({ organizationId, userId });
    return { redirectUrl: result.authorizationUrl, status: 'PENDING' };
  },
  async getConnectionStatus({ organizationId }) {
    const result = await googleWorkspace.status(organizationId);
    return { ...result, connected: result.status === 'connected' };
  },
  // Generic chat actions are not switched to this adapter until their action
  // schemas have native implementations. Existing interview scheduling uses
  // googleWorkspaceService directly and remains unchanged.
  supportsAction() { return false; },
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
    return { redirectUrl: result.authorizationUrl, status: 'PENDING' };
  },
  async completeConnection({ state, code }) {
    return jira.completeConnection({ state, code });
  },
  async getConnectionStatus({ organizationId }) {
    return jira.status(organizationId);
  },
  async selectResource({ organizationId, resourceId }) {
    return jira.selectResource({ organizationId, resourceId });
  },
  async disconnect({ organizationId }) {
    return jira.disconnect(organizationId);
  },
  supportsAction(actionName) {
    return jira.supportsAction(actionName);
  },
  async executeAction({ actionName, params, organizationId }) {
    const data = await jira.executeAction({ organizationId, actionName, params });
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
