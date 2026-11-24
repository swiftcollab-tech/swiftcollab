/**
 * Frappe/ERPNext Integration Routes
 *
 * Provides endpoints for:
 * - Per-user connection management (connect, disconnect, test)
 * - Dynamic DocType schema fetching
 * - Document CRUD operations
 * - Legacy global-credential endpoints (backward compatible)
 */

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

// Import auth middleware for protected routes
const { authenticateToken } = require('../middleware/auth');

// Import new per-user integration modules
const {
  frappeConnectionManager,
  frappeSchemaService,
  frappeProviderService,
  PRIORITY_DOCTYPES
} = require('../integrations/frappe');

// Legacy global credentials (for backward compatibility)
const FRAPPE_URL = process.env.FRAPPE_URL;
const FRAPPE_API_KEY = process.env.FRAPPE_API_KEY;
const FRAPPE_API_SECRET = process.env.FRAPPE_API_SECRET;

// Middleware to extract user ID from request
function getUserId(req) {
  // From JWT auth middleware
  if (req.user?.id) return req.user.id;
  if (req.user?.userId) return req.user.userId;
  // From header (for testing)
  if (req.headers['x-user-id']) return req.headers['x-user-id'];
  return null;
}

// ============================================
// PER-USER CONNECTION MANAGEMENT
// ============================================

/**
 * Connect ERPNext - Create or update a user's Frappe connection
 * POST /api/frappe/connect
 */
router.post('/connect', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const {
      baseUrl,
      apiKey,
      apiSecret,
      connectionName = 'Default ERPNext',
      provider = 'mcp'
    } = req.body;

    if (!baseUrl || !apiKey || !apiSecret) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: baseUrl, apiKey, apiSecret'
      });
    }

    const result = await frappeConnectionManager.createConnection(userId, {
      connectionName,
      baseUrl,
      apiKey,
      apiSecret,
      provider
    });

    // Native REST builds DocType schemas locally. MCP supplies its own schemas.
    if (String(provider).toLowerCase() === 'native') {
      frappeSchemaService.syncPrioritySchemas(userId, connectionName).catch(e => {
        console.error('[Frappe Routes] Background schema sync failed:', e.message);
      });
    }

    res.json({
      success: true,
      message: 'Connected to ERPNext successfully',
      connection: result.connection,
      erpUser: result.erpUser,
      erpCompany: result.erpCompany,
      provider: result.provider,
      toolCount: result.toolCount
    });
  } catch (error) {
    console.error('[Frappe Routes] Connect error:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Test connection without saving
 * POST /api/frappe/test-connection
 */
router.post('/test-connection', authenticateToken, async (req, res) => {
  try {
    const { baseUrl, apiKey, apiSecret, provider = 'mcp' } = req.body;

    if (!baseUrl || !apiKey || !apiSecret) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: baseUrl, apiKey, apiSecret'
      });
    }

    const result = await frappeProviderService.testConnection({ provider, baseUrl, apiKey, apiSecret });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get connection status
 * GET /api/frappe/connection
 */
router.get('/connection', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const connectionName = req.query.name || 'Default ERPNext';
    const connection = await frappeConnectionManager.getConnection(userId, connectionName);

    if (!connection) {
      return res.json({
        connected: false,
        message: 'No ERPNext connection found'
      });
    }

    res.json({
      connected: connection.status === 'active',
      connection: {
        id: connection.id,
        name: connection.connection_name,
        baseUrl: connection.base_url,
        status: connection.status,
        erpUser: connection.erp_user,
        erpCompany: connection.erp_company,
        erpVersion: connection.erp_version,
        provider: connection.provider,
        mcpEndpoint: connection.mcp_endpoint,
        toolCount: connection.mcp_tools?.length || 0,
        lastTestedAt: connection.last_tested_at,
        lastError: connection.last_error,
        schemaCachedAt: connection.schema_cached_at
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get all connections for user
 * GET /api/frappe/connections
 */
router.get('/connections', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const connections = await frappeConnectionManager.getConnections(userId);

    res.json({
      success: true,
      connections: connections.map(c => ({
        id: c.id,
        name: c.connection_name,
        baseUrl: c.base_url,
        status: c.status,
        erpUser: c.erp_user,
        erpCompany: c.erp_company,
        provider: c.provider,
        mcpEndpoint: c.mcp_endpoint,
        toolCount: c.mcp_tools?.length || 0,
        lastTestedAt: c.last_tested_at
      }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Disconnect ERPNext
 * POST /api/frappe/disconnect
 */
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const connectionName = req.body.connectionName || 'Default ERPNext';
    const result = await frappeConnectionManager.disconnect(userId, connectionName);

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete connection permanently
 * DELETE /api/frappe/connection
 */
router.delete('/connection', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const connectionName = req.query.name || 'Default ERPNext';
    const result = await frappeConnectionManager.deleteConnection(userId, connectionName);

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Refresh connection (re-test and update status)
 * POST /api/frappe/refresh
 */
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const connectionName = req.body.connectionName || 'Default ERPNext';
    const result = await frappeConnectionManager.refreshConnection(userId, connectionName);

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// DYNAMIC SCHEMA ENDPOINTS
// ============================================

/**
 * Get available DocTypes
 * GET /api/frappe/doctypes
 */
router.get('/doctypes', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { priorityOnly, module, limit } = req.query;
    const docTypes = await frappeSchemaService.listDocTypes(userId, 'Default ERPNext', {
      priorityOnly: priorityOnly === 'true',
      module,
      limit: parseInt(limit) || 200
    });

    res.json({
      success: true,
      docTypes,
      count: docTypes.length,
      priorityDocTypes: PRIORITY_DOCTYPES
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get schema for a specific DocType
 * GET /api/frappe/schema/:doctype
 */
router.get('/schema/:doctype', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { doctype } = req.params;
    const schema = await frappeSchemaService.getDocTypeSchema(userId, doctype);

    res.json({
      success: true,
      schema,
      doctype
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Sync priority schemas
 * POST /api/frappe/sync-schemas
 */
router.post('/sync-schemas', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const result = await frappeSchemaService.syncPrioritySchemas(userId);

    res.json({
      success: true,
      synced: result.success.length,
      failed: result.failed.length,
      details: result
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get available Frappe tools (for ToolRouter)
 * GET /api/frappe/tools
 */
router.get('/tools', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const tools = await frappeProviderService.getAvailableTools(userId);

    res.json({
      success: true,
      tools,
      count: tools.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// DOCUMENT OPERATIONS (via FrappeClient)
// ============================================

/**
 * Execute a Frappe action
 * POST /api/frappe/execute
 */
router.post('/execute', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { actionName, params } = req.body;

    if (!actionName) {
      return res.status(400).json({ success: false, error: 'actionName is required' });
    }

    const result = await frappeProviderService.executeAction(userId, actionName, params || {});
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * List documents (convenience endpoint)
 * GET /api/frappe/documents/:doctype
 */
router.get('/documents/:doctype', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { doctype } = req.params;
    const { filters, fields, limit, order_by } = req.query;

    const result = await frappeProviderService.executeAction(userId, 'FRAPPE_LIST_DOCUMENTS', {
      doctype,
      filters: filters ? JSON.parse(filters) : undefined,
      fields: fields ? JSON.parse(fields) : undefined,
      limit: parseInt(limit) || 20,
      order_by
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get a document
 * GET /api/frappe/documents/:doctype/:name
 */
router.get('/documents/:doctype/:name', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { doctype, name } = req.params;

    const result = await frappeProviderService.executeAction(userId, 'FRAPPE_GET_DOCUMENT', {
      doctype,
      name
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create a document
 * POST /api/frappe/documents/:doctype
 */
router.post('/documents/:doctype', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { doctype } = req.params;

    const result = await frappeProviderService.executeAction(userId, 'FRAPPE_CREATE_DOCUMENT', {
      doctype,
      data: req.body
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update a document
 * PUT /api/frappe/documents/:doctype/:name
 */
router.put('/documents/:doctype/:name', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { doctype, name } = req.params;

    const result = await frappeProviderService.executeAction(userId, 'FRAPPE_UPDATE_DOCUMENT', {
      doctype,
      name,
      data: req.body
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete a document
 * DELETE /api/frappe/documents/:doctype/:name
 */
router.delete('/documents/:doctype/:name', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { doctype, name } = req.params;

    const result = await frappeProviderService.executeAction(userId, 'FRAPPE_DELETE_DOCUMENT', {
      doctype,
      name
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// EXECUTION LOGS
// ============================================

/**
 * Get recent execution logs
 * GET /api/frappe/logs
 */
router.get('/logs', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    const { limit = 50, connectionId } = req.query;
    const logs = await frappeConnectionManager.getExecutionLogs(userId, {
      limit: parseInt(limit),
      connectionId
    });

    res.json({
      success: true,
      logs,
      count: logs.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// LEGACY ENDPOINTS (Backward Compatible)
// ============================================

/**
 * Legacy: Test global connection
 * GET /api/frappe/test
 */
router.get('/test', async (req, res) => {
  try {
    // First try per-user connection
    const userId = getUserId(req);
    if (userId) {
      const hasConnection = await frappeConnectionManager.hasActiveConnection(userId);
      if (hasConnection) {
        const result = await frappeConnectionManager.refreshConnection(userId);
        return res.json({
          success: result.success,
          message: result.success ? 'Connected to ERPNext' : 'Connection failed',
          user: result.user,
          authMethod: 'Per-User API Key',
          ...result
        });
      }
    }

    // Fall back to global credentials
    if (!FRAPPE_URL || !FRAPPE_API_KEY) {
      return res.status(400).json({
        success: false,
        error: 'No Frappe connection configured. Please connect your ERPNext instance.',
        hint: 'Use POST /api/frappe/connect to add your ERPNext credentials.'
      });
    }

    const result = await frappeConnectionManager.testCredentials(
      FRAPPE_URL,
      FRAPPE_API_KEY,
      FRAPPE_API_SECRET
    );

    res.json({
      success: result.success,
      message: result.success ? 'Connected to Frappe/ERPNext' : result.error,
      user: result.user,
      url: FRAPPE_URL,
      authMethod: 'Global API Key'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      url: FRAPPE_URL
    });
  }
});

/**
 * Legacy: Setup guide
 * GET /api/frappe/setup-guide
 */
router.get('/setup-guide', (req, res) => {
  res.json({
    message: 'To connect SwiftCollab to your ERPNext instance:',
    steps: [
      '1. Log in to your ERPNext instance as Administrator',
      '2. Go to User > [Your User] > API Access',
      '3. Click "Generate Keys" to create API Key and API Secret',
      '4. Copy the API Key and API Secret',
      '5. Use the Connect ERPNext button in the app, or call:',
      '   POST /api/frappe/connect with:',
      '   { "baseUrl": "https://your-site.erpnext.com", "apiKey": "...", "apiSecret": "..." }',
    ],
    notes: [
      'API Secret is shown only once - save it securely!',
      'The user must have appropriate permissions for the DocTypes you want to access',
      'Your credentials are encrypted at rest using AES-256-GCM'
    ]
  });
});

module.exports = router;
