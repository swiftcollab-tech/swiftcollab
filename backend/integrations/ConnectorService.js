const { getConnector, connectorForAction, publicConnectorCatalog } = require('./connectorCatalog');

class ConnectorNotReadyError extends Error {
  constructor(app) {
    super(`The direct ${app.name} connector needs its provider OAuth/API setup before it can be used. Use Composio for now.`);
    this.name = 'ConnectorNotReadyError';
    this.statusCode = 409;
    this.code = 'DIRECT_CONNECTOR_SETUP_REQUIRED';
  }
}

/**
 * Provider-neutral facade used by HTTP routes and, progressively, execution.
 * Native adapters are keyed by the catalogue's `direct.connector` value.
 */
class ConnectorService {
  constructor({ composioProvider = null, directConnectors = {} } = {}) {
    this.composioProvider = composioProvider;
    this.directConnectors = new Map(Object.entries(directConnectors));
  }

  listCatalog() {
    return publicConnectorCatalog();
  }

  _app(appId) {
    const app = getConnector(appId);
    if (!app) {
      const error = new Error(`Unknown SwiftCollab application: ${appId}`);
      error.statusCode = 404;
      error.code = 'UNKNOWN_CONNECTOR';
      throw error;
    }
    return app;
  }

  _directAdapter(app) {
    return this.directConnectors.get(app.providers.direct.connector) || null;
  }

  canExecuteDirect(appIdOrToolkit) {
    const app = getConnector(appIdOrToolkit);
    return Boolean(app && this._directAdapter(app)?.canExecuteActions);
  }

  getDirectTools(appIdOrToolkit) {
    const app = getConnector(appIdOrToolkit);
    const adapter = app ? this._directAdapter(app) : null;
    return adapter?.getTools?.() || [];
  }

  async initiateConnection({ appId, provider, entityId, organizationId, userId, redirectUrl, connectionParams }) {
    const app = this._app(appId);
    const method = String(provider || '').toLowerCase();

    if (method === 'composio') {
      if (!this.composioProvider) {
        const error = new Error('Composio is not configured');
        error.statusCode = 503;
        throw error;
      }
      return this.composioProvider.initiateConnection({
        toolkit: app.toolkit,
        redirectUrl,
        connectionParams,
        entityId,
      });
    }

    if (method !== 'direct') {
      const error = new Error("provider must be either 'direct' or 'composio'");
      error.statusCode = 400;
      throw error;
    }

    const adapter = this._directAdapter(app);
    if (app.providers.direct.status !== 'available' || !adapter?.initiateConnection) {
      throw new ConnectorNotReadyError(app);
    }

    return adapter.initiateConnection({ app, organizationId, userId, redirectUrl, connectionParams });
  }

  async getDirectStatus({ appId, organizationId, userId, connectionAttemptId = null }) {
    const app = this._app(appId);
    const adapter = this._directAdapter(app);
    if (!adapter?.getConnectionStatus) {
      return { connected: false, status: app.providers.direct.status };
    }
    return adapter.getConnectionStatus({ app, organizationId, userId, connectionAttemptId });
  }

  async completeConnection({ appId, state, code }) {
    const app = this._app(appId);
    const adapter = this._directAdapter(app);
    if (!adapter?.completeConnection) throw new ConnectorNotReadyError(app);
    return adapter.completeConnection({ app, state, code });
  }

  async selectResource({ appId, organizationId, userId, resourceId, connectionId }) {
    const app = this._app(appId);
    const adapter = this._directAdapter(app);
    if (!adapter?.selectResource) throw new ConnectorNotReadyError(app);
    return adapter.selectResource({ app, organizationId, userId, resourceId, connectionId });
  }

  async setActiveResource({ appId, organizationId, userId, connectionId }) {
    const app = this._app(appId);
    const adapter = this._directAdapter(app);
    if (!adapter?.setActiveResource) throw new ConnectorNotReadyError(app);
    return adapter.setActiveResource({ app, organizationId, userId, connectionId });
  }

  async disconnect({ appId, organizationId, userId, connectionId = null }) {
    const app = this._app(appId);
    const adapter = this._directAdapter(app);
    if (!adapter?.disconnect) throw new ConnectorNotReadyError(app);
    return adapter.disconnect({ app, organizationId, userId, connectionId });
  }

  async executeAction({ actionName, params, entityId, organizationId, userId, preferredProvider = null }) {
    const app = connectorForAction(actionName);
    const method = String(preferredProvider || '').toLowerCase();
    const adapter = app ? this._directAdapter(app) : null;

    if (method === 'direct') {
      if (!app || !adapter?.supportsAction?.(actionName) || !adapter?.executeAction) {
        throw new ConnectorNotReadyError(app || { name: actionName });
      }
      return adapter.executeAction({ actionName, params, entityId, organizationId, userId });
    }

    if (!method && app && adapter?.supportsAction?.(actionName) && adapter?.executeAction) {
      const directStatus = await adapter.getConnectionStatus?.({ app, organizationId, userId });
      if (directStatus?.connected) {
        return adapter.executeAction({ actionName, params, entityId, organizationId, userId });
      }
    }

    // Default to Composio until a user explicitly chooses an available native
    // connection. This preserves all existing production behaviour.
    if (!this.composioProvider) throw new Error('No integration provider can execute this action');
    return this.composioProvider.executeAction({ actionName, params, entityId });
  }
}

module.exports = { ConnectorService, ConnectorNotReadyError };
