const { query, getClient } = require('../db');
const crypto = require('crypto');
const { assertEmail } = require('./emailService');

const VALID_ROLES = new Set(['owner', 'admin', 'member', 'viewer']);

function createSlug(name) {
  const normalized = String(name || 'organization')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'organization';
  return `${normalized}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createOrganizationWithOwner({ name, ownerUserId, client = null }) {
  if (!name || !ownerUserId) throw new Error('Organization name and owner are required');

  const ownsTransaction = !client;
  const dbClient = client || await getClient();
  try {
    if (ownsTransaction) await dbClient.query('BEGIN');
    const organization = await dbClient.query(
      `INSERT INTO organizations (name, slug)
       VALUES ($1, $2)
       RETURNING id, name, slug, created_at`,
      [String(name).trim(), createSlug(name)]
    );
    await dbClient.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [organization.rows[0].id, ownerUserId]
    );
    if (ownsTransaction) await dbClient.query('COMMIT');
    return organization.rows[0];
  } catch (error) {
    if (ownsTransaction) await dbClient.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsTransaction) dbClient.release();
  }
}

async function getMembership({ organizationId, userId }) {
  const result = await query(
    `SELECT o.id AS organization_id, o.name AS organization_name, o.slug, m.role
     FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.organization_id = $1 AND m.user_id = $2`,
    [organizationId, userId]
  );
  return result.rows[0] || null;
}

async function listMembershipsForUser(userId) {
  const result = await query(
    `SELECT o.id AS organization_id, o.name AS organization_name, o.slug, m.role
     FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1
     ORDER BY o.created_at ASC`,
    [userId]
  );
  return result.rows;
}

async function requireMembership({ organizationId, userId, allowedRoles = [] }) {
  const membership = await getMembership({ organizationId, userId });
  if (!membership) {
    const error = new Error('You do not have access to this organization');
    error.statusCode = 403;
    throw error;
  }
  if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role)) {
    const error = new Error('Your organization role does not allow this action');
    error.statusCode = 403;
    throw error;
  }
  return membership;
}

async function addMember({ organizationId, userId, role = 'member' }) {
  if (!VALID_ROLES.has(role) || role === 'owner') throw new Error('Invalid member role');
  const result = await query(
    `INSERT INTO organization_members (organization_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()
     RETURNING organization_id, user_id, role`,
    [organizationId, userId, role]
  );
  return result.rows[0];
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createInvitationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function assertInvitableRole(role) {
  if (!['admin', 'member', 'viewer'].includes(role)) throw new Error('Invalid invitation role');
  return role;
}

async function createInvitation({ organizationId, email, role = 'member', invitedByUserId, expiresInHours = 168, client = null }) {
  const normalizedEmail = assertEmail(email);
  const executor = client || { query };
  const existingMember = await executor.query(
    `SELECT 1 FROM organization_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND lower(u.email) = lower($2)`,
    [organizationId, normalizedEmail]
  );
  if (existingMember.rowCount > 0) throw new Error('This user is already a member of the organization');

  const token = createInvitationToken();
  const result = await executor.query(
    `INSERT INTO organization_invitations
       (organization_id, email, role, token_hash, invited_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 * INTERVAL '1 hour'))
     ON CONFLICT (organization_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL
     DO UPDATE SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash,
                   invited_by_user_id = EXCLUDED.invited_by_user_id, expires_at = EXCLUDED.expires_at,
                   created_at = NOW()
     RETURNING id, organization_id, email, role, expires_at, created_at`,
    [organizationId, normalizedEmail, assertInvitableRole(role), hashToken(token), invitedByUserId, expiresInHours]
  );
  return { invitation: result.rows[0], token };
}

async function getInvitationForToken(token, email, client = null) {
  const executor = client || { query };
  const result = await executor.query(
    `SELECT i.*, o.name AS organization_name
     FROM organization_invitations i
     JOIN organizations o ON o.id = i.organization_id
     WHERE i.token_hash = $1 AND lower(i.email) = lower($2)
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()`,
    [hashToken(token), assertEmail(email)]
  );
  return result.rows[0] || null;
}

async function getInvitationSummary(token) {
  if (!token) throw new Error('Invitation token is required');
  const result = await query(
    `SELECT i.email, i.role, i.expires_at, o.name AS organization_name
     FROM organization_invitations i
     JOIN organizations o ON o.id = i.organization_id
     WHERE i.token_hash = $1
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()`,
    [hashToken(token)]
  );
  if (result.rowCount === 0) throw new Error('Invitation is invalid, expired, or already used');
  return result.rows[0];
}

async function acceptInvitation({ token, userId, email, client = null }) {
  const ownsTransaction = !client;
  const dbClient = client || await getClient();
  try {
    if (ownsTransaction) await dbClient.query('BEGIN');
    const invitation = await getInvitationForToken(token, email, dbClient);
    if (!invitation) throw new Error('Invitation is invalid, expired, or already used');
    await dbClient.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [invitation.organization_id, userId, invitation.role]
    );
    await dbClient.query(
      `UPDATE organization_invitations
       SET accepted_at = NOW(), accepted_by_user_id = $1
       WHERE id = $2`,
      [userId, invitation.id]
    );
    if (ownsTransaction) await dbClient.query('COMMIT');
    return invitation;
  } catch (error) {
    if (ownsTransaction) await dbClient.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsTransaction) dbClient.release();
  }
}

async function listMembers(organizationId) {
  const result = await query(
    `SELECT u.id, u.email, u.name, u.avatar_url, m.role, m.created_at
     FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 ORDER BY m.created_at ASC`,
    [organizationId]
  );
  return result.rows;
}

async function listPendingInvitations(organizationId) {
  const result = await query(
    `SELECT i.id, i.email, i.role, i.expires_at, i.created_at,
            u.name AS invited_by_name, u.email AS invited_by_email
     FROM organization_invitations i
     JOIN users u ON u.id = i.invited_by_user_id
     WHERE i.organization_id = $1
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > NOW()
     ORDER BY i.created_at DESC`,
    [organizationId]
  );
  return result.rows;
}

async function getPendingInvitation({ organizationId, invitationId }) {
  const result = await query(
    `SELECT id, organization_id, email, role
     FROM organization_invitations
     WHERE id = $1 AND organization_id = $2
       AND accepted_at IS NULL AND revoked_at IS NULL`,
    [invitationId, organizationId]
  );
  if (result.rowCount === 0) throw new Error('Active invitation not found');
  return result.rows[0];
}

async function updateMemberRole({ organizationId, userId, role }) {
  if (!VALID_ROLES.has(role) || role === 'owner') throw new Error('Invalid member role');
  const result = await query(
    `UPDATE organization_members SET role = $3, updated_at = NOW()
     WHERE organization_id = $1 AND user_id = $2 AND role <> 'owner'
     RETURNING organization_id, user_id, role`,
    [organizationId, userId, role]
  );
  if (result.rowCount === 0) throw new Error('Member not found or is an owner');
  return result.rows[0];
}

async function removeMember({ organizationId, userId }) {
  const result = await query(
    `DELETE FROM organization_members
     WHERE organization_id = $1 AND user_id = $2 AND role <> 'owner'
     RETURNING user_id, role`,
    [organizationId, userId]
  );
  if (result.rowCount === 0) throw new Error('Member not found or is an owner');
  return result.rows[0];
}

async function revokeInvitation({ organizationId, invitationId }) {
  const result = await query(
    `UPDATE organization_invitations SET revoked_at = NOW()
     WHERE id = $1 AND organization_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
     RETURNING id`,
    [invitationId, organizationId]
  );
  if (result.rowCount === 0) throw new Error('Active invitation not found');
}

module.exports = {
  VALID_ROLES,
  createSlug,
  createOrganizationWithOwner,
  getMembership,
  listMembershipsForUser,
  requireMembership,
  addMember,
  hashToken,
  createInvitation,
  getInvitationForToken,
  getInvitationSummary,
  acceptInvitation,
  listMembers,
  listPendingInvitations,
  getPendingInvitation,
  updateMemberRole,
  removeMember,
  revokeInvitation,
};
