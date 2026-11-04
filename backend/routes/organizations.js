const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireOrganization } = require('../middleware/organization');
const {
  listMembershipsForUser,
  createInvitation,
  acceptInvitation,
  listMembers,
  listPendingInvitations,
  getPendingInvitation,
  updateMemberRole,
  removeMember,
  revokeInvitation,
} = require('../services/organizationService');
const { sendOrganizationInvitation } = require('../services/emailService');

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    res.json({ organizations: await listMembershipsForUser(req.user.userId) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load organizations' });
  }
});

router.post('/invitations/accept', async (req, res) => {
  try {
    const invitation = await acceptInvitation({
      token: req.body?.token,
      userId: req.user.userId,
      email: req.user.email,
    });
    res.json({ organizationId: invitation.organization_id, role: invitation.role });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/:organizationId/members', requireOrganization(), async (req, res) => {
  try {
    res.json({ members: await listMembers(req.organization.organization_id) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load members' });
  }
});

router.get('/:organizationId/invitations', requireOrganization(['owner', 'admin']), async (req, res) => {
  try {
    res.json({ invitations: await listPendingInvitations(req.organization.organization_id) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load invitations' });
  }
});

router.post('/:organizationId/invitations', requireOrganization(['owner', 'admin']), async (req, res) => {
  try {
    const { email, role = 'member' } = req.body || {};
    if (req.organization.role === 'admin' && role === 'admin') {
      return res.status(403).json({ error: 'Only an owner can invite an admin' });
    }
    const { invitation, token } = await createInvitation({
      organizationId: req.organization.organization_id,
      email,
      role,
      invitedByUserId: req.user.userId,
    });
    const appUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
    const invitationUrl = `${appUrl.replace(/\/$/, '')}/accept-invitation?token=${encodeURIComponent(token)}`;
    const delivery = await sendOrganizationInvitation({
      email: invitation.email,
      organizationName: req.organization.organization_name,
      invitationUrl,
      inviterName: req.user.name || req.user.email,
      role: invitation.role,
      expiresAt: invitation.expires_at,
    });
    res.status(201).json({ invitation, delivery });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.patch('/:organizationId/members/:userId', requireOrganization(['owner', 'admin']), async (req, res) => {
  try {
    const { role } = req.body || {};
    if (req.organization.role === 'admin' && req.params.userId === req.user.userId) {
      return res.status(403).json({ error: 'Admins cannot change their own role' });
    }
    if (req.organization.role === 'admin' && role === 'admin') {
      return res.status(403).json({ error: 'Only an owner can grant admin access' });
    }
    if (req.organization.role === 'admin') {
      const members = await listMembers(req.organization.organization_id);
      const target = members.find(member => member.id === req.params.userId);
      if (target?.role === 'admin') {
        return res.status(403).json({ error: 'An admin cannot change another admin' });
      }
    }
    const member = await updateMemberRole({
      organizationId: req.organization.organization_id,
      userId: req.params.userId,
      role,
    });
    res.json({ member });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:organizationId/members/:userId', requireOrganization(['owner', 'admin']), async (req, res) => {
  try {
    if (req.params.userId === req.user.userId) {
      return res.status(403).json({ error: 'You cannot remove yourself from the organization' });
    }
    if (req.organization.role === 'admin') {
      const members = await listMembers(req.organization.organization_id);
      const target = members.find(member => member.id === req.params.userId);
      if (target?.role === 'admin' || target?.role === 'owner') {
        return res.status(403).json({ error: 'An admin cannot remove an admin or owner' });
      }
    }
    await removeMember({
      organizationId: req.organization.organization_id,
      userId: req.params.userId,
    });
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:organizationId/invitations/:invitationId', requireOrganization(['owner', 'admin']), async (req, res) => {
  try {
    const pending = await getPendingInvitation({
      organizationId: req.organization.organization_id,
      invitationId: req.params.invitationId,
    });
    if (req.organization.role === 'admin' && pending.role === 'admin') {
      return res.status(403).json({ error: 'Only an owner can revoke an admin invitation' });
    }
    await revokeInvitation({ organizationId: req.organization.organization_id, invitationId: req.params.invitationId });
    res.status(204).end();
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

router.post('/:organizationId/invitations/:invitationId/resend', requireOrganization(['owner', 'admin']), async (req, res) => {
  try {
    const pending = await getPendingInvitation({
      organizationId: req.organization.organization_id,
      invitationId: req.params.invitationId,
    });
    if (req.organization.role === 'admin' && pending.role === 'admin') {
      return res.status(403).json({ error: 'Only an owner can resend an admin invitation' });
    }
    const { invitation, token } = await createInvitation({
      organizationId: req.organization.organization_id,
      email: pending.email,
      role: pending.role,
      invitedByUserId: req.user.userId,
    });
    const appUrl = process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
    const invitationUrl = `${appUrl.replace(/\/$/, '')}/accept-invitation?token=${encodeURIComponent(token)}`;
    const delivery = await sendOrganizationInvitation({
      email: invitation.email,
      organizationName: req.organization.organization_name,
      invitationUrl,
      inviterName: req.user.name || req.user.email,
      role: invitation.role,
      expiresAt: invitation.expires_at,
    });
    res.json({ invitation, delivery });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
