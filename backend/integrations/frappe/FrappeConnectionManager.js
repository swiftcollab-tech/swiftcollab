/**
 * FrappeConnectionManager - Per-user Frappe/ERPNext connection management
 *
 * Handles:
 * - Secure credential storage with AES-256-GCM encryption
 * - Connection lifecycle (create, test, update, disconnect)
 * - Credential retrieval for API calls
 * - Connection health monitoring
 */

const crypto = require('crypto');
const { query, getClient } = require('../../db');

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// Get encryption key from env or generate a stable one from JWT_SECRET
function getEncryptionKey() {
  const secret = process.env.FRAPPE_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('FRAPPE_ENCRYPTION_KEY or JWT_SECRET must be set for credential encryption');
  }
  // Derive a 32-byte key from the secret
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a string using AES-256-GCM
 * Returns: iv:authTag:encryptedData (all base64)
 */
function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encryptedData
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt()
 */
function decrypt(encryptedData) {
  const key = getEncryptionKey();
  const parts = encryptedData.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted data format');
  }

  const iv = Buffer.from(parts[0], 'base64');
  const authTag = Buffer.from(parts[1], 'base64');
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

class FrappeConnectionManager {
  constructor() {
    this.connectionCache = new Map(); // userId -> { connection, expiresAt }
    this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Create a new Frappe connection for a user
   */
  async createConnection(userId, {
    connectionName = 'Default ERPNext',
    baseUrl,
    apiKey,
    apiSecret,
    provider = 'mcp'
  }) {
    // Validate inputs
    if (!baseUrl || !apiKey || !apiSecret) {
      throw new Error('baseUrl, apiKey, and apiSecret are required');
    }

    const normalizedProvider = String(provider || 'mcp').toLowerCase();
    if (!['mcp', 'native'].includes(normalizedProvider)) {
      throw new Error("provider must be either 'mcp' or 'native'");
    }

    // Normalize URL (remove trailing slash)
    let normalizedUrl = baseUrl.replace(/\/+$/, '');

    // Test connection before saving
    const testResult = normalizedProvider === 'mcp'
      ? await require('./FrappeMcpProvider').frappeMcpProvider.testCredentials(normalizedUrl, apiKey, apiSecret)
      : await this.testCredentials(normalizedUrl, apiKey, apiSecret);
    if (!testResult.success) {
      throw new Error(`Connection test failed: ${testResult.error}`);
    }

    // Use the final URL from test result (handles redirects)
    if (testResult.finalUrl) {
      normalizedUrl = testResult.finalUrl;
    }

    // Encrypt credentials
    const apiKeyEncrypted = encrypt(apiKey);
    const apiSecretEncrypted = encrypt(apiSecret);

    // Save to database
    const result = await query(
      `INSERT INTO frappe_connections (
        user_id, connection_name, base_url,
        api_key_encrypted, api_secret_encrypted,
        status, last_tested_at, erp_user, erp_company, erp_version,
        provider, mcp_endpoint, mcp_tools
      ) VALUES ($1, $2, $3, $4, $5, 'active', NOW(), $6, $7, $8, $9, $10, $11::jsonb)
      ON CONFLICT (user_id, connection_name)
      DO UPDATE SET
        base_url = EXCLUDED.base_url,
        api_key_encrypted = EXCLUDED.api_key_encrypted,
        api_secret_encrypted = EXCLUDED.api_secret_encrypted,
        status = 'active',
        last_tested_at = NOW(),
        last_error = NULL,
        erp_user = EXCLUDED.erp_user,
        erp_company = EXCLUDED.erp_company,
        erp_version = EXCLUDED.erp_version,
        provider = EXCLUDED.provider,
        mcp_endpoint = EXCLUDED.mcp_endpoint,
        mcp_tools = EXCLUDED.mcp_tools,
        updated_at = NOW()
      RETURNING id, connection_name, base_url, status, erp_user, erp_company,
                provider, mcp_endpoint, mcp_tools`,
      [
        userId,
        connectionName,
        normalizedUrl,
        apiKeyEncrypted,
        apiSecretEncrypted,
        testResult.user,
        testResult.company,
        testResult.version,
        normalizedProvider,
        testResult.mcpEndpoint || null,
        JSON.stringify(testResult.tools || [])
      ]
    );

    // Clear cache
    this.clearCache(userId);

    console.log(`[FrappeConnectionManager] Connection created for user ${userId}: ${normalizedUrl}`);

    return {
      success: true,
      connection: result.rows[0],
      erpUser: testResult.user,
      erpCompany: testResult.company,
      provider: normalizedProvider,
      toolCount: testResult.tools?.length || 0
    };
  }

  /**
   * Test credentials without saving
   * Robust validation that handles redirects, CORS, and permission issues
   */
  async testCredentials(baseUrl, apiKey, apiSecret) {
    const fetch = require('node-fetch');

    // Decode HTML entities that might be in the URL (&#x2F; -> /, etc.)
    const decodeHtmlEntities = (str) => {
      return str
        .replace(/&#x2F;/gi, '/')
        .replace(/&#47;/g, '/')
        .replace(/&#x3A;/gi, ':')
        .replace(/&#58;/g, ':')
        .replace(/&amp;/gi, '&')
        .replace(/&#x26;/gi, '&');
    };

    // Normalize URL - decode HTML entities and remove trailing slash
    let normalizedUrl = decodeHtmlEntities(baseUrl).replace(/\/+$/, '');

    // Debug: log raw and normalized URL
    console.log(`[FrappeConnectionManager] Raw URL: ${JSON.stringify(baseUrl)}`);
    console.log(`[FrappeConnectionManager] Normalized URL: ${JSON.stringify(normalizedUrl)}`);

    try {
      // Step 1: Test basic connectivity with ping (no auth required)
      // This validates the URL is reachable and is a Frappe instance
      console.log(`[FrappeConnectionManager] Testing connectivity to ${normalizedUrl}`);

      let pingResponse;
      try {
        pingResponse = await fetch(`${normalizedUrl}/api/method/ping`, {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          },
          redirect: 'follow', // Follow redirects
          timeout: 15000
        });

        // Check if we were redirected to a different host
        if (pingResponse.url) {
          const responseUrl = new URL(pingResponse.url);
          const originalUrl = new URL(normalizedUrl);
          if (responseUrl.host !== originalUrl.host) {
            // Update to the redirected URL
            normalizedUrl = `${responseUrl.protocol}//${responseUrl.host}`;
            console.log(`[FrappeConnectionManager] Redirected to ${normalizedUrl}`);
          }
        }
      } catch (pingErr) {
        // Ping might fail on some setups, continue to auth test
        console.log(`[FrappeConnectionManager] Ping failed (continuing): ${pingErr.message}`);
      }

      // Step 2: Test authenticated access with get_logged_user
      console.log(`[FrappeConnectionManager] Testing authentication...`);

      const userResponse = await fetch(`${normalizedUrl}/api/method/frappe.auth.get_logged_user`, {
        method: 'GET',
        headers: {
          'Authorization': `token ${apiKey}:${apiSecret}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        redirect: 'follow',
        timeout: 15000
      });

      // Handle various response codes
      if (userResponse.status === 401) {
        return {
          success: false,
          error: 'Invalid API credentials. Please check your API Key and Secret.'
        };
      }

      if (userResponse.status === 403) {
        // 403 on get_logged_user is unusual, but try alternative endpoint
        console.log(`[FrappeConnectionManager] get_logged_user returned 403, trying alternative...`);

        // Try getting session info instead
        const sessionResponse = await fetch(`${normalizedUrl}/api/method/frappe.auth.get_logged_user`, {
          method: 'POST',
          headers: {
            'Authorization': `token ${apiKey}:${apiSecret}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          redirect: 'follow',
          timeout: 10000
        });

        if (sessionResponse.status === 401) {
          return { success: false, error: 'Invalid API credentials.' };
        }

        // If we get here with 403, credentials work but permissions are limited
        if (sessionResponse.status === 403) {
          return {
            success: true,
            user: 'Unknown (limited permissions)',
            company: null,
            version: null,
            message: 'Connected with limited permissions. Some features may not work.',
            limitedPermissions: true
          };
        }
      }

      if (!userResponse.ok) {
        const errorText = await userResponse.text();
        // Check if it's HTML (might be login page)
        if (errorText.includes('<!DOCTYPE') || errorText.includes('<html')) {
          return {
            success: false,
            error: 'Received login page instead of API response. Please check the URL and ensure API access is enabled.'
          };
        }
        return { success: false, error: `API error: ${userResponse.status}` };
      }

      // Parse user response
      let userData;
      const responseText = await userResponse.text();

      // Check if response is HTML (login page redirect)
      if (responseText.includes('<!DOCTYPE') || responseText.includes('<html')) {
        return {
          success: false,
          error: 'Received HTML instead of JSON. The URL may be incorrect or API access is disabled.'
        };
      }

      try {
        userData = JSON.parse(responseText);
      } catch (e) {
        return { success: false, error: 'Invalid JSON response from server.' };
      }

      const user = userData.message;

      // Step 3: Get company info (optional, 403 is OK)
      let company = null;
      let version = null;

      try {
        const companyResponse = await fetch(
          `${normalizedUrl}/api/resource/Company?limit_page_length=1&fields=["name"]`,
          {
            headers: {
              'Authorization': `token ${apiKey}:${apiSecret}`,
              'Accept': 'application/json'
            },
            redirect: 'follow',
            timeout: 8000
          }
        );

        if (companyResponse.ok) {
          const companyData = await companyResponse.json();
          if (companyData.data && companyData.data.length > 0) {
            company = companyData.data[0].name;
          }
        }
        // 403 is fine - user just doesn't have Company read permission
      } catch (e) {
        // Company fetch is optional
        console.log(`[FrappeConnectionManager] Company fetch failed (optional): ${e.message}`);
      }

      // Step 4: Get ERPNext version (optional)
      try {
        const versionResponse = await fetch(
          `${normalizedUrl}/api/method/frappe.utils.change_log.get_versions`,
          {
            headers: {
              'Authorization': `token ${apiKey}:${apiSecret}`,
              'Accept': 'application/json'
            },
            redirect: 'follow',
            timeout: 8000
          }
        );

        if (versionResponse.ok) {
          const versionData = await versionResponse.json();
          if (versionData.message && versionData.message.erpnext) {
            version = versionData.message.erpnext.version;
          }
        }
      } catch (e) {
        // Version fetch is optional
        console.log(`[FrappeConnectionManager] Version fetch failed (optional): ${e.message}`);
      }

      console.log(`[FrappeConnectionManager] Connection successful: ${user}${company ? ` @ ${company}` : ''}`);

      return {
        success: true,
        user,
        company,
        version,
        finalUrl: normalizedUrl, // Return the final URL (after redirects)
        message: `Connected as ${user}${company ? ` to ${company}` : ''}`
      };
    } catch (error) {
      if (error.code === 'ENOTFOUND') {
        return { success: false, error: `Cannot reach ${baseUrl}. Please check the URL.` };
      }
      if (error.code === 'ETIMEDOUT' || error.type === 'request-timeout') {
        return { success: false, error: 'Connection timed out. Please check the URL and try again.' };
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Get decrypted credentials for a user's connection
   */
  async getCredentials(userId, connectionName = 'Default ERPNext') {
    // Check cache first
    const cacheKey = `${userId}:${connectionName}`;
    const cached = this.connectionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.credentials;
    }

    // Fetch from database
    const result = await query(
      `SELECT id, base_url, api_key_encrypted, api_secret_encrypted, erp_user, erp_company, status,
              provider, mcp_endpoint, mcp_tools
       FROM frappe_connections
       WHERE user_id = $1 AND connection_name = $2`,
      [userId, connectionName]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    if (row.status !== 'active') {
      throw new Error(`Frappe connection is ${row.status}. Please reconnect.`);
    }

    // Decrypt credentials
    const credentials = {
      connectionId: row.id,
      baseUrl: row.base_url,
      apiKey: decrypt(row.api_key_encrypted),
      apiSecret: decrypt(row.api_secret_encrypted),
      erpUser: row.erp_user,
      erpCompany: row.erp_company,
      provider: row.provider || 'native',
      mcpEndpoint: row.mcp_endpoint,
      mcpTools: row.mcp_tools || []
    };

    // Cache for 5 minutes
    this.connectionCache.set(cacheKey, {
      credentials,
      expiresAt: Date.now() + this.CACHE_TTL
    });

    return credentials;
  }

  /**
   * Get connection info (without decrypted credentials)
   */
  async getConnection(userId, connectionName = 'Default ERPNext') {
    const result = await query(
      `SELECT id, connection_name, base_url, status, last_tested_at, last_error,
              erp_user, erp_company, erp_version, schema_cached_at, provider,
              mcp_endpoint, mcp_tools, created_at, updated_at
       FROM frappe_connections
       WHERE user_id = $1 AND connection_name = $2`,
      [userId, connectionName]
    );

    return result.rows[0] || null;
  }

  /**
   * Get all connections for a user
   */
  async getConnections(userId) {
    const result = await query(
      `SELECT id, connection_name, base_url, status, last_tested_at, last_error,
              erp_user, erp_company, erp_version, schema_cached_at, provider,
              mcp_endpoint, mcp_tools, created_at, updated_at
       FROM frappe_connections
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    return result.rows;
  }

  /**
   * Check if user has an active Frappe connection
   */
  async hasActiveConnection(userId, connectionName = 'Default ERPNext') {
    const result = await query(
      `SELECT EXISTS(
        SELECT 1 FROM frappe_connections
        WHERE user_id = $1 AND connection_name = $2 AND status = 'active'
      ) as connected`,
      [userId, connectionName]
    );

    return result.rows[0].connected;
  }

  /**
   * Disconnect (soft delete - marks as disconnected)
   */
  async disconnect(userId, connectionName = 'Default ERPNext') {
    const result = await query(
      `UPDATE frappe_connections
       SET status = 'disconnected', updated_at = NOW()
       WHERE user_id = $1 AND connection_name = $2
       RETURNING id, connection_name, status`,
      [userId, connectionName]
    );

    // Clear cache
    this.connectionCache.delete(`${userId}:${connectionName}`);

    if (result.rows.length === 0) {
      return { success: false, error: 'Connection not found' };
    }

    console.log(`[FrappeConnectionManager] Connection disconnected for user ${userId}`);
    return { success: true, connection: result.rows[0] };
  }

  /**
   * Permanently delete a connection
   */
  async deleteConnection(userId, connectionName = 'Default ERPNext') {
    const result = await query(
      `DELETE FROM frappe_connections
       WHERE user_id = $1 AND connection_name = $2
       RETURNING id, connection_name`,
      [userId, connectionName]
    );

    // Clear cache
    this.connectionCache.delete(`${userId}:${connectionName}`);

    if (result.rows.length === 0) {
      return { success: false, error: 'Connection not found' };
    }

    console.log(`[FrappeConnectionManager] Connection deleted for user ${userId}`);
    return { success: true };
  }

  /**
   * Update connection status after API call
   */
  async updateConnectionStatus(connectionId, { success, error = null }) {
    if (success) {
      await query(
        `UPDATE frappe_connections
         SET last_tested_at = NOW(), last_error = NULL, status = 'active',
             requests_today = requests_today + 1
         WHERE id = $1`,
        [connectionId]
      );
    } else {
      await query(
        `UPDATE frappe_connections
         SET last_error = $2, status = CASE WHEN $3 THEN 'error' ELSE status END
         WHERE id = $1`,
        [connectionId, error, error && error.includes('401')]
      );
    }
  }

  /**
   * Refresh connection (re-test and update status)
   */
  async refreshConnection(userId, connectionName = 'Default ERPNext') {
    const credentials = await this.getCredentials(userId, connectionName);
    if (!credentials) {
      throw new Error('Connection not found');
    }

    const testResult = credentials.provider === 'mcp'
      ? await require('./FrappeMcpProvider').frappeMcpProvider.testCredentials(
        credentials.baseUrl,
        credentials.apiKey,
        credentials.apiSecret
      )
      : await this.testCredentials(credentials.baseUrl, credentials.apiKey, credentials.apiSecret);

    await query(
      `UPDATE frappe_connections
       SET status = $2, last_tested_at = NOW(), last_error = $3,
           erp_user = COALESCE($4, erp_user), erp_company = COALESCE($5, erp_company),
           mcp_endpoint = COALESCE($7, mcp_endpoint),
           mcp_tools = CASE WHEN $8::jsonb = '[]'::jsonb THEN mcp_tools ELSE $8::jsonb END
       WHERE user_id = $1 AND connection_name = $6`,
      [
        userId,
        testResult.success ? 'active' : 'error',
        testResult.error || null,
        testResult.user,
        testResult.company,
        connectionName,
        testResult.mcpEndpoint || null,
        JSON.stringify(testResult.tools || [])
      ]
    );

    this.connectionCache.delete(`${userId}:${connectionName}`);

    return testResult;
  }

  /**
   * Log an execution (for audit trail)
   */
  async logExecution(connectionId, userId, {
    actionName,
    doctype,
    documentName,
    requestParams,
    responseData,
    status,
    errorMessage,
    durationMs
  }) {
    try {
      await query(
        `INSERT INTO frappe_execution_logs
         (connection_id, user_id, action_name, doctype, document_name,
          request_params, response_data, status, error_message, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          connectionId,
          userId,
          actionName,
          doctype,
          documentName,
          JSON.stringify(requestParams),
          JSON.stringify(responseData),
          status,
          errorMessage,
          durationMs
        ]
      );
    } catch (e) {
      console.error('[FrappeConnectionManager] Failed to log execution:', e.message);
    }
  }

  /**
   * Get recent execution logs
   */
  async getExecutionLogs(userId, { limit = 50, connectionId = null } = {}) {
    let sql = `
      SELECT id, connection_id, action_name, doctype, document_name,
             status, error_message, duration_ms, created_at
      FROM frappe_execution_logs
      WHERE user_id = $1
    `;
    const params = [userId];

    if (connectionId) {
      sql += ` AND connection_id = $2`;
      params.push(connectionId);
    }

    sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await query(sql, params);
    return result.rows;
  }

  /**
   * Clear the connection cache (useful after credential updates)
   */
  clearCache(userId = null) {
    if (userId) {
      for (const key of this.connectionCache.keys()) {
        if (key.startsWith(userId)) {
          this.connectionCache.delete(key);
        }
      }
    } else {
      this.connectionCache.clear();
    }
  }
}

// Singleton instance
const frappeConnectionManager = new FrappeConnectionManager();

module.exports = {
  FrappeConnectionManager,
  frappeConnectionManager,
  encrypt,
  decrypt
};
