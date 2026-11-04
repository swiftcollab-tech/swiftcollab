const { query } = require('../db');
const redis = require('./redis');

const MESSAGE_CACHE_TTL_SECONDS = 300;
const LIST_CACHE_TTL_SECONDS = 60;
const DEFAULT_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_LIMIT = 200;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 160) : 'New conversation';
}

function normalizeLimit(value) {
  const parsed = Number(value || DEFAULT_MESSAGE_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_MESSAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_MESSAGE_LIMIT);
}

class ConversationService {
  constructor({ queryFn = query, cache = redis } = {}) {
    this.query = queryFn;
    this.cache = cache;
  }

  _listCacheKey(organizationId, userId, limit) {
    return `chat:${organizationId}:${userId}:conversations:${limit}`;
  }

  _messagesCacheKey(organizationId, userId, conversationId, limit) {
    return `chat:${organizationId}:${userId}:conversation:${conversationId}:messages:${limit}`;
  }

  async _cacheGet(key) {
    return this.cache?.get ? this.cache.get(key) : null;
  }

  async _cacheSet(key, value, ttl) {
    if (this.cache?.set) await this.cache.set(key, value, ttl);
  }

  async _clearMessageCache(organizationId, userId, conversationId) {
    if (this.cache?.clearCache) {
      await this.cache.clearCache(
        `chat:${organizationId}:${userId}:conversation:${conversationId}:messages:*`
      );
    }
  }

  async _clearListCache(organizationId, userId) {
    if (this.cache?.clearCache) {
      await this.cache.clearCache(`chat:${organizationId}:${userId}:conversations:*`);
    }
  }

  async createConversation({ organizationId, userId, title }) {
    const result = await this.query(
      `INSERT INTO chat_conversations (organization_id, user_id, title)
       VALUES ($1, $2, $3)
       RETURNING id, organization_id, user_id, title, created_at, updated_at`,
      [organizationId, userId, normalizeTitle(title)]
    );
    await this._clearListCache(organizationId, userId);
    return result.rows[0];
  }

  async getConversation({ organizationId, userId, conversationId }) {
    const result = await this.query(
      `SELECT id, organization_id, user_id, title, created_at, updated_at
       FROM chat_conversations
       WHERE id = $1 AND organization_id = $2 AND user_id = $3`,
      [conversationId, organizationId, userId]
    );
    if (!result.rows[0]) throw httpError('Conversation not found', 404);
    return result.rows[0];
  }

  async listConversations({ organizationId, userId, limit = 50 }) {
    const safeLimit = Math.min(Math.max(Math.trunc(Number(limit) || 50), 1), 100);
    const cacheKey = this._listCacheKey(organizationId, userId, safeLimit);
    const cached = await this._cacheGet(cacheKey);
    if (cached) return cached;
    const result = await this.query(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              COUNT(m.id)::int AS message_count
       FROM chat_conversations c
       LEFT JOIN chat_messages m ON m.conversation_id = c.id
       WHERE c.organization_id = $1 AND c.user_id = $2
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT $3`,
      [organizationId, userId, safeLimit]
    );
    await this._cacheSet(cacheKey, result.rows, LIST_CACHE_TTL_SECONDS);
    return result.rows;
  }

  async listMessages({ organizationId, userId, conversationId, limit }) {
    await this.getConversation({ organizationId, userId, conversationId });
    const safeLimit = normalizeLimit(limit);
    const cacheKey = this._messagesCacheKey(
      organizationId, userId, conversationId, safeLimit
    );
    const cached = await this._cacheGet(cacheKey);
    if (cached) return cached;

    const result = await this.query(
      `SELECT id, role, content, metadata, created_at, sequence_number
       FROM (
         SELECT id, role, content, metadata, created_at, sequence_number
         FROM chat_messages
         WHERE conversation_id = $1
         ORDER BY sequence_number DESC
         LIMIT $2
       ) recent
       ORDER BY sequence_number ASC`,
      [conversationId, safeLimit]
    );
    await this._cacheSet(cacheKey, result.rows, MESSAGE_CACHE_TTL_SECONDS);
    return result.rows;
  }

  async addMessage({ organizationId, userId, conversationId, role, content, metadata = {} }) {
    if (!['user', 'assistant'].includes(role)) {
      throw httpError('Message role must be user or assistant', 400);
    }
    const normalizedContent = String(content || '').trim();
    if (!normalizedContent) throw httpError('Message content is required', 400);
    if (normalizedContent.length > 100000) throw httpError('Message is too large', 413);

    await this.getConversation({ organizationId, userId, conversationId });
    const result = await this.query(
      `INSERT INTO chat_messages (conversation_id, role, content, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id, conversation_id, role, content, metadata, created_at, sequence_number`,
      [conversationId, role, normalizedContent, JSON.stringify(metadata || {})]
    );
    await this.query(
      'UPDATE chat_conversations SET updated_at = NOW() WHERE id = $1',
      [conversationId]
    );
    await Promise.all([
      this._clearListCache(organizationId, userId),
      this._clearMessageCache(organizationId, userId, conversationId),
    ]);
    return result.rows[0];
  }

  async deleteConversation({ organizationId, userId, conversationId }) {
    const result = await this.query(
      `DELETE FROM chat_conversations
       WHERE id = $1 AND organization_id = $2 AND user_id = $3
       RETURNING id`,
      [conversationId, organizationId, userId]
    );
    if (!result.rows[0]) throw httpError('Conversation not found', 404);
    await Promise.all([
      this._clearListCache(organizationId, userId),
      this._clearMessageCache(organizationId, userId, conversationId),
    ]);
    return result.rows[0];
  }

  async clearHistory({ organizationId, userId }) {
    const result = await this.query(
      `DELETE FROM chat_conversations
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId]
    );
    await this._clearListCache(organizationId, userId);
    if (this.cache?.clearCache) {
      await this.cache.clearCache(`chat:${organizationId}:${userId}:conversation:*`);
    }
    return { deletedCount: result.rowCount };
  }
}

const conversationService = new ConversationService();

module.exports = {
  ConversationService,
  conversationService,
  normalizeTitle,
};
