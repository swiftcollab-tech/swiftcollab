const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { requireOrganization } = require('../middleware/organization');
const { conversationService } = require('../services/conversationService');

const router = express.Router();

router.use(authenticateToken, requireOrganization());

router.get('/', async (req, res) => {
  try {
    const conversations = await conversationService.listConversations({
      organizationId: req.organization.organization_id,
      userId: req.user.userId,
      limit: req.query.limit,
    });
    return res.json({ conversations });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const conversation = await conversationService.createConversation({
      organizationId: req.organization.organization_id,
      userId: req.user.userId,
      title: req.body?.title,
    });
    return res.status(201).json({ conversation });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.get('/:conversationId/messages', async (req, res) => {
  try {
    const messages = await conversationService.listMessages({
      organizationId: req.organization.organization_id,
      userId: req.user.userId,
      conversationId: req.params.conversationId,
      limit: req.query.limit,
    });
    return res.json({ messages });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.delete('/', async (req, res) => {
  try {
    const result = await conversationService.clearHistory({
      organizationId: req.organization.organization_id,
      userId: req.user.userId,
    });
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

router.delete('/:conversationId', async (req, res) => {
  try {
    await conversationService.deleteConversation({
      organizationId: req.organization.organization_id,
      userId: req.user.userId,
      conversationId: req.params.conversationId,
    });
    return res.status(204).send();
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
});

module.exports = router;
