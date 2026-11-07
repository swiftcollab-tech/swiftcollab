const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireOrganization } = require('../middleware/organization');
const google = require('../services/googleWorkspaceService');
const router = express.Router();

router.post('/connect', authenticateToken, requireOrganization(), async (req, res) => {
  try { res.json(await google.startConnection({ organizationId: req.organization.organization_id, userId: req.user.userId })); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
router.get('/status', authenticateToken, requireOrganization(), async (req, res) => {
  try { res.json(await google.status(req.organization.organization_id, req.user.userId)); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
router.delete('/connect', authenticateToken, requireOrganization(), async (req, res) => {
  try { await google.disconnect(req.organization.organization_id, req.user.userId); res.status(204).end(); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
router.get('/callback', async (req, res) => {
  try {
    await google.completeConnection({ state: req.query.state, code: req.query.code });
    res.redirect(`${(process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')}/?googleConnected=1`);
  } catch (error) {
    res.redirect(`${(process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')}/?googleConnectionError=${encodeURIComponent(error.message)}`);
  }
});
module.exports = router;
