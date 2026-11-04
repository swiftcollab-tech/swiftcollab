const assert = require('assert');
const crypto = require('crypto');
process.env.REDIS_URL = '';
const { getClient, pool } = require('../db');
const { ConversationService } = require('../services/conversationService');

function createMemoryCache() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { values.set(key, value); return true; },
    async del(key) { values.delete(key); return true; },
    async clearCache(pattern) {
      const expression = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`);
      for (const key of values.keys()) {
        if (expression.test(key)) values.delete(key);
      }
      return true;
    },
  };
}

async function run() {
  const client = await getClient();
  const suffix = crypto.randomUUID();
  try {
    await client.query('BEGIN');
    const users = await client.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, 'test', 'History Owner'), ($2, 'test', 'Other Member')
       RETURNING id`,
      [`history-owner-${suffix}@example.test`, `history-other-${suffix}@example.test`]
    );
    const organization = await client.query(
      `INSERT INTO organizations (name, slug)
       VALUES ($1, $2)
       RETURNING id`,
      [`History Test ${suffix}`, `history-${suffix}`]
    );
    const organizationId = organization.rows[0].id;
    const ownerId = users.rows[0].id;
    const otherId = users.rows[1].id;
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [organizationId, ownerId, otherId]
    );

    const service = new ConversationService({
      queryFn: client.query.bind(client),
      cache: createMemoryCache(),
    });
    const conversation = await service.createConversation({
      organizationId,
      userId: ownerId,
      title: 'Summarize the customer report',
    });
    await service.addMessage({
      organizationId,
      userId: ownerId,
      conversationId: conversation.id,
      role: 'user',
      content: 'Summarize the customer report',
    });
    await service.addMessage({
      organizationId,
      userId: ownerId,
      conversationId: conversation.id,
      role: 'assistant',
      content: 'The report has been summarized.',
      metadata: { type: 'success' },
    });

    const messages = await service.listMessages({
      organizationId,
      userId: ownerId,
      conversationId: conversation.id,
    });
    assert.deepStrictEqual(messages.map(item => item.role), ['user', 'assistant']);
    assert.strictEqual(messages[1].metadata.type, 'success');

    const conversations = await service.listConversations({ organizationId, userId: ownerId });
    assert.strictEqual(conversations.length, 1);
    assert.strictEqual(conversations[0].message_count, 2);

    await assert.rejects(
      () => service.listMessages({
        organizationId,
        userId: otherId,
        conversationId: conversation.id,
      }),
      error => error.statusCode === 404
    );

    await service.deleteConversation({
      organizationId,
      userId: ownerId,
      conversationId: conversation.id,
    });
    assert.deepStrictEqual(
      await service.listConversations({ organizationId, userId: ownerId }),
      []
    );

    console.log('Conversation history isolation and caching tests passed');
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
