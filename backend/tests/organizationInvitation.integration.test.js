const assert = require('assert');
const crypto = require('crypto');
const { getClient, pool } = require('../db');
const {
  createOrganizationWithOwner,
  createInvitation,
  acceptInvitation,
} = require('../services/organizationService');

async function run() {
  const client = await getClient();
  const suffix = crypto.randomUUID();
  try {
    await client.query('BEGIN');
    const owner = await client.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test', 'Owner') RETURNING id`,
      [`owner-${suffix}@example.test`]
    );
    const inviteeEmail = `invitee-${suffix}@example.test`;
    const invitee = await client.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, 'test', 'Invitee') RETURNING id`,
      [inviteeEmail]
    );
    const organization = await createOrganizationWithOwner({
      name: `Invitation Test ${suffix}`,
      ownerUserId: owner.rows[0].id,
      client,
    });
    const { invitation, token } = await createInvitation({
      organizationId: organization.id,
      email: inviteeEmail,
      role: 'viewer',
      invitedByUserId: owner.rows[0].id,
      client,
    });

    assert.strictEqual(invitation.role, 'viewer');
    assert.ok(token.length > 20);
    await acceptInvitation({ token, userId: invitee.rows[0].id, email: inviteeEmail, client });

    const membership = await client.query(
      'SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [organization.id, invitee.rows[0].id]
    );
    assert.strictEqual(membership.rows[0].role, 'viewer');
    await assert.rejects(
      () => createInvitation({
        organizationId: organization.id,
        email: inviteeEmail,
        role: 'member',
        invitedByUserId: owner.rows[0].id,
        client,
      }),
      /already a member/
    );
    await assert.rejects(
      () => acceptInvitation({ token, userId: invitee.rows[0].id, email: inviteeEmail, client }),
      /invalid, expired, or already used/
    );
    console.log('Organization invitation integration test passed');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
