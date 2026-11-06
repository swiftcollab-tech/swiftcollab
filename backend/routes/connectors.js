const express = require('express');
const { requireOrganization } = require('../middleware/organization');

function initConnectorRoutes({ connectorService, authenticateToken }) {
  if (!connectorService) throw new Error('connectorService is required');
  const router = express.Router();

  router.get('/catalog', authenticateToken, requireOrganization(), (_req, res) => {
    res.json({ connectors: connectorService.listCatalog() });
  });

  router.post('/:appId/connect', authenticateToken, requireOrganization(['owner', 'admin', 'member']), async (req, res) => {
    try {
      if (req.body?.provider === 'direct' && !['owner', 'admin'].includes(req.organization.role)) {
        return res.status(403).json({ error: 'Only an organization owner or admin can connect a shared native integration' });
      }
      const userId = req.user.userId;
      const result = await connectorService.initiateConnection({
        appId: req.params.appId,
        provider: req.body?.provider,
        entityId: `user_${userId}`,
        organizationId: req.organization.organization_id,
        userId,
        redirectUrl: req.body?.redirectUrl || null,
        connectionParams: req.body?.connectionParams || {},
      });
      res.json(result);
    } catch (error) {
      res.status(error.statusCode || 500).json({
        error: error.message,
        code: error.code || 'CONNECTOR_CONNECTION_FAILED',
      });
    }
  });

  router.get('/:appId/callback', async (req, res) => {
    const appUrl = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
    try {
      const result = await connectorService.completeConnection({
        appId: req.params.appId,
        state: req.query.state,
        code: req.query.code,
      });
      const params = new URLSearchParams({ connector: req.params.appId, connected: result.connected ? '1' : '0' });
      if (result.requiresResourceSelection) params.set('selectResource', '1');
      res.redirect(`${appUrl}/?${params.toString()}`);
    } catch (error) {
      const params = new URLSearchParams({ connector: req.params.appId, connectorError: error.message });
      res.redirect(`${appUrl}/?${params.toString()}`);
    }
  });

  router.get('/:appId/direct-status', authenticateToken, requireOrganization(), async (req, res) => {
    try {
      res.json(await connectorService.getDirectStatus({
        appId: req.params.appId,
        organizationId: req.organization.organization_id,
        userId: req.user.userId,
      }));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
    }
  });

  router.post('/:appId/select-resource', authenticateToken, requireOrganization(['owner', 'admin']), async (req, res) => {
    try {
      res.json(await connectorService.selectResource({
        appId: req.params.appId,
        organizationId: req.organization.organization_id,
        userId: req.user.userId,
        resourceId: req.body?.resourceId,
      }));
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
    }
  });

  router.delete('/:appId/connect', authenticateToken, requireOrganization(['owner', 'admin']), async (req, res) => {
    try {
      await connectorService.disconnect({
        appId: req.params.appId,
        organizationId: req.organization.organization_id,
        userId: req.user.userId,
      });
      res.status(204).end();
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message, code: error.code });
    }
  });

  return router;
}

module.exports = { initConnectorRoutes };
