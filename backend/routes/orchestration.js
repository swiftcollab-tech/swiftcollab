/**
 * Orchestration API Routes (Single Orchestrator)
 *
 * This router is intentionally thin and delegates to `AssistantOrchestrator`:
 * `ToolRouter -> UnifiedSlotFiller -> ExecutorV2 -> AssistantComposer`
 */

const express = require("express");
const { APP_TO_COMPOSIO_TOOLKIT } = require("../composioService");
const { frappeConnectionManager } = require("../integrations/frappe");
const { requireOrganization } = require('../middleware/organization');
const { conversationService } = require('../services/conversationService');

function assistantMessageText(result) {
  return String(
    result?.message || result?.response || result?.reply || 'Request processed.'
  );
}

function assistantMessageMetadata(result) {
  if (!result || typeof result !== 'object') return {};
  const metadata = { ...result };
  delete metadata.message;
  delete metadata.response;
  delete metadata.reply;
  delete metadata.conversationId;
  return metadata;
}

function normalizeSelectedToolkits({ selectedApps, selectedToolkits, appsQuery }) {
  if (Array.isArray(selectedToolkits) && selectedToolkits.length > 0) return selectedToolkits;

  const raw = Array.isArray(selectedApps)
    ? selectedApps
    : typeof appsQuery === "string" && appsQuery.length > 0
      ? appsQuery.split(",").map((a) => a.trim()).filter(Boolean)
      : [];

  return raw
    .map((id) => APP_TO_COMPOSIO_TOOLKIT[id] || String(id).toUpperCase())
    .filter(Boolean);
}

function determineEventType(app, payload) {
  switch (String(app || "").toLowerCase()) {
    case "jira":
      return payload.webhookEvent || payload.issue_event_type_name || "unknown";
    case "github":
      return payload.action || "unknown";
    case "slack":
      return payload.event?.type || "unknown";
    case "trello":
      return payload.action?.type || "unknown";
    default:
      return "unknown";
  }
}

function initOrchestrationRoutes(assistantOrchestrator, authenticateToken, optionalAuth, composioService = null, connectorService = null) {
  const router = express.Router();

  if (!assistantOrchestrator) {
    throw new Error("initOrchestrationRoutes requires assistantOrchestrator");
  }

  // ---------------------------------------------------------------------------
  // Assistant endpoints (back-compat)
  // ---------------------------------------------------------------------------

  async function runAssistant(req, emit = async () => {}) {
    let activeConversation = null;
    try {
      const {
        message,
        selectedApps,
        selectedToolkits,
        followupContext,
        answers,
        conversationId,
        userResponse,
      } = req.body || {};

      const userId = req.user.userId;
      // Connections are user-scoped by default so one organization member can
      // never execute against another member's personal account.
      const entityId = `user_${userId}`;

      const normalizedToolkits = normalizeSelectedToolkits({ selectedApps, selectedToolkits });
      const effectiveMessage = typeof userResponse === "string" && userResponse.length > 0 ? userResponse : message;

      if (typeof effectiveMessage !== 'string' || !effectiveMessage.trim()) {
        const error = new Error('Message is required.');
        error.statusCode = 400;
        throw error;
      }

      await emit('status', { stage: 'understanding', message: 'Understanding your request...' });

      activeConversation = conversationId
        ? await conversationService.getConversation({
          organizationId: req.organization.organization_id,
          userId,
          conversationId,
        })
        : await conversationService.createConversation({
          organizationId: req.organization.organization_id,
          userId,
          title: effectiveMessage,
        });

      // The database, not browser-provided history, is the trusted source of
      // conversation context. Fetch prior turns before appending this turn so
      // the current prompt is not sent to the LLM twice.
      const priorMessages = await conversationService.listMessages({
        organizationId: req.organization.organization_id,
        userId,
        conversationId: activeConversation.id,
        limit: 20,
      });
      await conversationService.addMessage({
        organizationId: req.organization.organization_id,
        userId,
        conversationId: activeConversation.id,
        role: 'user',
        content: effectiveMessage,
      });

      await emit('status', {
        stage: 'planning',
        message: normalizedToolkits.length > 0
          ? 'Planning the best response and checking available tools...'
          : 'Preparing a contextual response...',
      });

      const result = await assistantOrchestrator.processPrompt({
        message: effectiveMessage,
        userId,
        entityId,
        organizationId: req.organization.organization_id,
        selectedToolkits: normalizedToolkits,
        followupContext: followupContext || null,
        answers: answers || [],
        conversationHistory: priorMessages.map(item => ({
          role: item.role,
          text: item.content,
        })),
        onProgress: event => emit('progress', event),
      });

      await emit('status', { stage: 'responding', message: 'Preparing the response...' });

      await conversationService.addMessage({
        organizationId: req.organization.organization_id,
        userId,
        conversationId: activeConversation.id,
        role: 'assistant',
        content: assistantMessageText(result),
        metadata: assistantMessageMetadata(result),
      });

      return { ...result, conversationId: activeConversation.id };
    } catch (error) {
      if (activeConversation) error.conversationId = activeConversation.id;
      throw error;
    }
  }

  async function handleAssistant(req, res) {
    try {
      return res.json(await runAssistant(req));
    } catch (error) {
      console.error("[Orchestration] Assistant error:", error);
      return res.status(error.statusCode || 500).json({
        type: "error",
        message: error.message,
        ...(error.conversationId ? { conversationId: error.conversationId } : {}),
      });
    }
  }

  async function handleAssistantStream(req, res) {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let closed = false;
    res.on('close', () => { closed = true; });

    const sendEvent = async (event, data) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await sendEvent('status', { stage: 'connected', message: 'Connected to SwiftCollab...' });
      const result = await runAssistant(req, sendEvent);
      const message = assistantMessageText(result);

      await sendEvent('response_start', {
        type: result.type || 'chat',
        conversationId: result.conversationId,
      });

      // Stream the finalized response in small chunks. Tool execution progress
      // is emitted independently while the orchestrator is working.
      const chunks = message.match(/[\s\S]{1,80}/g) || [''];
      for (const delta of chunks) {
        if (closed) break;
        await sendEvent('message_delta', { delta });
        await new Promise(resolve => setTimeout(resolve, 8));
      }

      await sendEvent('result', result);
      await sendEvent('done', { conversationId: result.conversationId });
    } catch (error) {
      console.error('[Orchestration] Streaming assistant error:', error);
      await sendEvent('error', {
        message: error.message || 'Unable to process the request.',
        ...(error.conversationId ? { conversationId: error.conversationId } : {}),
      });
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  router.post("/assistant", authenticateToken, requireOrganization(), handleAssistant);
  router.post("/assistant/stream", authenticateToken, requireOrganization(), handleAssistantStream);
  router.post("/unified", authenticateToken, requireOrganization(), handleAssistant);

  // ---------------------------------------------------------------------------
  // Automation routes (AutomationEngine)
  // ---------------------------------------------------------------------------

  router.post("/automations", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { description, automationContext, answers } = req.body || {};

      const automationEngine = assistantOrchestrator.getAutomationEngine();

      const result = automationContext
        ? await automationEngine.clarifyRule(userId, automationContext, answers || [], assistantOrchestrator.callGemini)
        : await automationEngine.createRule(userId, description, assistantOrchestrator.callGemini);

      return res.json(result);
    } catch (error) {
      console.error("[Orchestration] Create automation error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/automations", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const automationEngine = assistantOrchestrator.getAutomationEngine();
      const rules = await automationEngine.getRules(userId);
      return res.json({ rules });
    } catch (error) {
      console.error("[Orchestration] List automations error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.put("/automations/:id/status", authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body || {};

      const automationEngine = assistantOrchestrator.getAutomationEngine();
      const result = await automationEngine.updateRuleStatus(id, status);
      return res.json(result);
    } catch (error) {
      console.error("[Orchestration] Update automation status error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.delete("/automations/:id", authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const automationEngine = assistantOrchestrator.getAutomationEngine();
      const result = await automationEngine.deleteRule(id);
      return res.json(result);
    } catch (error) {
      console.error("[Orchestration] Delete automation error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/automations/:id/history", authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const limit = Number(req.query?.limit || 20);

      const automationEngine = assistantOrchestrator.getAutomationEngine();
      const history = await automationEngine.getExecutionHistory(id, Number.isFinite(limit) ? limit : 20);
      return res.json({ history });
    } catch (error) {
      console.error("[Orchestration] Automation history error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/automations/:id/audit", authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const limit = Number(req.query?.limit || 50);

      const automationEngine = assistantOrchestrator.getAutomationEngine();
      const auditLog = await automationEngine.getAuditLog(id, Number.isFinite(limit) ? limit : 50);
      return res.json({ auditLog });
    } catch (error) {
      console.error("[Orchestration] Automation audit error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/automations/health", authenticateToken, async (req, res) => {
    try {
      const automationEngine = assistantOrchestrator.getAutomationEngine();
      const health = await automationEngine.runHealthCheck();
      return res.json({ health });
    } catch (error) {
      console.error("[Orchestration] Automation health error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post("/automations/:id/recover", authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const automationEngine = assistantOrchestrator.getAutomationEngine();
      const result = await automationEngine.recoverRule(id);
      return res.json(result);
    } catch (error) {
      console.error("[Orchestration] Recover automation error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Proactive routes (ProactiveEngine)
  // ---------------------------------------------------------------------------

  router.get("/daily-plan", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const entityId = `user_${userId}`;
      const selectedToolkits = normalizeSelectedToolkits({ appsQuery: req.query?.apps });

      if (selectedToolkits.length === 0) {
        return res.json({ type: "error", message: "Please specify at least one app." });
      }

      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      const plan = await proactiveEngine.generateDailyPlan(userId, entityId, selectedToolkits);
      return res.json(plan);
    } catch (error) {
      console.error("[Orchestration] Daily plan error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/digest", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const entityId = `user_${userId}`;
      const selectedToolkits = normalizeSelectedToolkits({ appsQuery: req.query?.apps });

      if (selectedToolkits.length === 0) {
        return res.json({ type: "error", message: "Please specify at least one app." });
      }

      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      const digest = await proactiveEngine.generateDigest(userId, entityId, selectedToolkits);
      return res.json(digest);
    } catch (error) {
      console.error("[Orchestration] Digest error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/blockers", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const entityId = `user_${userId}`;
      const selectedToolkits = normalizeSelectedToolkits({ appsQuery: req.query?.apps });

      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      const blockers = await proactiveEngine.detectBlockers(userId, entityId, selectedToolkits);
      return res.json({ blockers });
    } catch (error) {
      console.error("[Orchestration] Blockers error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/recommendations", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      const recommendations = await proactiveEngine.getPendingRecommendations(userId);
      return res.json({ recommendations });
    } catch (error) {
      console.error("[Orchestration] Recommendations error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.put("/recommendations/:id/status", authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body || {};

      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      await proactiveEngine.updateRecommendationStatus(id, status);
      return res.json({ success: true });
    } catch (error) {
      console.error("[Orchestration] Update recommendation error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/followups", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const entityId = `user_${userId}`;
      const selectedToolkits = normalizeSelectedToolkits({ appsQuery: req.query?.apps });

      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      const followups = await proactiveEngine.generateFollowupRecommendations(userId, entityId, selectedToolkits);
      return res.json({ followups });
    } catch (error) {
      console.error("[Orchestration] Followups error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/risks", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const entityId = `user_${userId}`;
      const selectedToolkits = normalizeSelectedToolkits({ appsQuery: req.query?.apps });

      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      const risks = await proactiveEngine.monitorRisksAndDeadlines(userId, entityId, selectedToolkits);
      return res.json({ risks });
    } catch (error) {
      console.error("[Orchestration] Risks error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post("/feedback", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { type, itemId, feedback } = req.body || {};

      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      await proactiveEngine.learnFromFeedback(userId, type, itemId, feedback);
      return res.json({ success: true });
    } catch (error) {
      console.error("[Orchestration] Feedback error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get("/preferences", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      const preferences = await proactiveEngine.getUserPreferences(userId);
      return res.json({ preferences });
    } catch (error) {
      console.error("[Orchestration] Get preferences error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  router.put("/preferences", authenticateToken, async (req, res) => {
    try {
      const userId = req.user.userId;
      const proactiveEngine = assistantOrchestrator.getProactiveEngine();
      const preferences = await proactiveEngine.updateUserPreferences(userId, req.body || {});
      return res.json({ preferences });
    } catch (error) {
      console.error("[Orchestration] Update preferences error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Webhooks -> AutomationEngine
  // ---------------------------------------------------------------------------

  router.post("/webhooks/:app", async (req, res) => {
    try {
      const { app } = req.params;
      const payload = req.body;
      const headers = req.headers;

      const automationEngine = assistantOrchestrator.getAutomationEngine();
      const event = {
        app: String(app || "").toUpperCase(),
        type: determineEventType(app, payload),
        payload,
        headers,
        timestamp: new Date().toISOString(),
      };

      const results = await automationEngine.processEvent(event);
      return res.json({ received: true, processed: results?.length || 0 });
    } catch (error) {
      console.error("[Orchestration] Webhook error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // App Connection Status (OAuth)
  // ---------------------------------------------------------------------------

  router.post("/connection-status", authenticateToken, requireOrganization(), async (req, res) => {
    try {
      const { appIds } = req.body || {};
      const userId = req.user.userId;
      const entityId = `user_${userId}`;

      if (!Array.isArray(appIds) || appIds.length === 0) {
        return res.json({ connections: {} });
      }

      // Convert app IDs to toolkit names
      const toolkitsByApp = {};
      for (const appId of appIds) {
        const toolkit = APP_TO_COMPOSIO_TOOLKIT[appId] || String(appId).toUpperCase();
        toolkitsByApp[appId] = toolkit;
      }

      // Use passed composioService
      if (!composioService) {
        return res.status(503).json({ error: "Composio service not available" });
      }

      const connections = {};

      // Apps that use custom integration (not Composio)
      const CUSTOM_INTEGRATION_APPS = ['frappe', 'erpnext'];

      // Check connection status for each app
      for (const [appId, toolkit] of Object.entries(toolkitsByApp)) {
        try {
          // A native connection takes precedence. Composio remains the
          // fallback when the direct adapter is not connected.
          if (connectorService) {
            const direct = await connectorService.getDirectStatus({
              appId,
              organizationId: req.organization.organization_id,
              userId,
            });
            if (direct.connected) {
              connections[appId] = { ...direct, connected: true, provider: 'direct' };
              continue;
            }
          }

          // Handle Frappe/ERPNext with our custom integration
          if (CUSTOM_INTEGRATION_APPS.includes(appId.toLowerCase())) {
            try {
              const frappeConnection = await frappeConnectionManager.getConnection(userId);
              if (frappeConnection) {
                connections[appId] = {
                  connected: true,
                  customIntegration: true,
                  connectionName: frappeConnection.connection_name
                };
              } else {
                connections[appId] = {
                  connected: false,
                  customIntegration: true,
                  requiresCustomModal: true
                };
              }
            } catch (frappeErr) {
              connections[appId] = {
                connected: false,
                customIntegration: true,
                requiresCustomModal: true
              };
            }
            continue;
          }

          // Try to list connected accounts for this toolkit (Composio)
          const accounts = await composioService.listConnectedAccounts([toolkit], entityId);
          const isConnected = accounts?.items?.length > 0;

          if (isConnected) {
            connections[appId] = { connected: true };
          } else {
            // Not connected - get auth URL
            try {
              const connectionRequest = await composioService.initiateConnection(toolkit, null, {}, entityId);
              connections[appId] = {
                connected: false,
                authUrl: connectionRequest?.redirectUrl || null,
              };
            } catch (authErr) {
              console.warn(`[Connection] Failed to get auth URL for ${appId}:`, authErr.message);
              connections[appId] = {
                connected: false,
                authUrl: null,
                error: authErr.message,
              };
            }
          }
        } catch (err) {
          console.warn(`[Connection] Failed to check ${appId}:`, err.message);
          connections[appId] = { connected: false, error: err.message };
        }
      }

      if (Object.values(connections).some(connection => connection?.connected)) {
        composioService.clearEntityCache(entityId);
      }

      return res.json({ connections });
    } catch (error) {
      console.error("[Orchestration] Connection status error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Auth Config Management (for API_KEY based apps like Axonaut)
  // ---------------------------------------------------------------------------

  // Get required auth fields for a toolkit
  router.get("/auth-config/fields/:toolkit", authenticateToken, requireOrganization(), async (req, res) => {
    try {
      const { toolkit } = req.params;

      if (!composioService) {
        return res.status(503).json({ error: "Composio service not available" });
      }

      // Get toolkit info to determine auth type and required fields
      const toolkitInfo = await composioService.composio.toolkits.get(toolkit.toLowerCase());

      const authScheme = toolkitInfo?.authSchemes?.[0] || {};
      const fields = [];

      // Map auth scheme fields to frontend-friendly format
      if (authScheme.type === 'API_KEY' || authScheme.auth_mode === 'API_KEY') {
        fields.push({
          name: 'api_key',
          displayName: 'API Key',
          description: `Your ${toolkit} API key`,
          required: true,
          type: 'password'
        });
      } else if (authScheme.fields) {
        for (const field of authScheme.fields) {
          fields.push({
            name: field.name,
            displayName: field.displayName || field.name,
            description: field.description || '',
            required: field.required !== false,
            type: field.name.includes('secret') || field.name.includes('key') ? 'password' : 'text'
          });
        }
      }

      return res.json({
        toolkit,
        authType: authScheme.type || authScheme.auth_mode || 'UNKNOWN',
        fields,
        redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/connections/callback`
      });
    } catch (error) {
      console.error("[Orchestration] Get auth fields error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  // Create auth config for a toolkit (for API_KEY auth)
  // Supports both api_key and api_secret for apps like Frappe
  router.post("/auth-config/create", authenticateToken, requireOrganization(['owner', 'admin']), async (req, res) => {
    try {
      const { toolkit, credentials, name } = req.body || {};

      if (!toolkit || !credentials) {
        return res.status(400).json({ error: "toolkit and credentials are required" });
      }

      // Import appsConfig to check if this is a custom app
      const { appsConfig } = require("../appsConfig");
      const appId = toolkit.toLowerCase();
      const appConfig = appsConfig[appId];

      // Check if this is a custom integration (like Frappe) that doesn't use Composio
      if (appConfig?.type === 'custom') {
        console.log(`[AuthConfig] Custom app ${toolkit} - storing credentials locally`);
        console.log(`[AuthConfig] Credentials received: api_key=${credentials.api_key ? '[SET]' : '[NOT SET]'}, api_secret=${credentials.api_secret ? '[SET]' : '[NOT SET]'}`);

        // For custom apps, we'd typically store in database or environment
        // For now, return success - actual integration requires custom API handlers
        return res.json({
          success: true,
          authConfigId: `custom_${toolkit}_${Date.now()}`,
          message: `Credentials saved for ${toolkit}. Note: Custom integrations require manual API configuration.`,
          isCustom: true
        });
      }

      if (!composioService) {
        return res.status(503).json({ error: "Composio service not available" });
      }

      console.log(`[AuthConfig] Creating auth config for ${toolkit}`);
      console.log(`[AuthConfig] Credentials: api_key=${credentials.api_key ? '[SET]' : '[NOT SET]'}, api_secret=${credentials.api_secret ? '[SET]' : '[NOT SET]'}`);

      // Create auth config via Composio API
      const authConfig = await composioService.composio.authConfigs.create({
        toolkitSlug: toolkit.toLowerCase(),
        name: name || `${toolkit} Auth Config`,
        authScheme: 'API_KEY',
        useComposioAuth: false,
        credentials: credentials
      });

      console.log(`[AuthConfig] Created auth config:`, authConfig?.id);

      return res.json({
        success: true,
        authConfigId: authConfig?.id,
        message: `Auth config created for ${toolkit}`
      });
    } catch (error) {
      console.error("[Orchestration] Create auth config error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  // Initiate connection for a toolkit
  router.post("/connections/initiate", authenticateToken, requireOrganization(['owner', 'admin', 'member']), async (req, res) => {
    try {
      const { appId, redirectUrl, connectionParams } = req.body || {};
      const userId = req.user.userId;
      const entityId = `user_${userId}`;

      if (!appId) {
        return res.status(400).json({ error: "appId is required" });
      }

      if (!composioService) {
        return res.status(503).json({ error: "Composio service not available" });
      }

      const toolkit = APP_TO_COMPOSIO_TOOLKIT[appId] || String(appId).toUpperCase();
      console.log(`[Connection] Initiating connection for ${toolkit} (entity: ${entityId})`);

      const connectionRequest = await composioService.initiateConnection(
        toolkit,
        redirectUrl || null,
        connectionParams || {},
        entityId
      );

      return res.json({
        redirectUrl: connectionRequest?.redirectUrl,
        connectionId: connectionRequest?.connectionId,
        status: connectionRequest?.status
      });
    } catch (error) {
      console.error("[Orchestration] Initiate connection error:", error);

      // Check if it needs auth config
      if (error.message?.includes('OAuth configuration') || error.message?.includes('auth config')) {
        return res.json({
          error: error.message,
          needsAuthConfig: true
        });
      }

      // Check if it needs connection params (like subdomain)
      if (error.message?.includes('Missing required fields')) {
        return res.json({
          error: error.message,
          needsConnectionParams: true
        });
      }

      return res.status(500).json({ error: error.message });
    }
  });

  // Check connection status by ID
  router.get("/connections/check/:connectionId", authenticateToken, requireOrganization(), async (req, res) => {
    try {
      const { connectionId } = req.params;

      if (!composioService) {
        return res.status(503).json({ error: "Composio service not available" });
      }

      const account = await composioService.getConnection(connectionId);
      if (account?.status === 'ACTIVE') {
        composioService.clearEntityCache(`user_${req.user.userId}`);
      }

      return res.json({
        connectionId,
        isActive: account?.status === 'ACTIVE',
        status: account?.status
      });
    } catch (error) {
      console.error("[Orchestration] Check connection error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  // Get required connection fields for a toolkit (like subdomain for Jira)
  router.get("/connections/fields/:toolkit", authenticateToken, requireOrganization(), async (req, res) => {
    try {
      const { toolkit } = req.params;

      if (!composioService) {
        return res.status(503).json({ error: "Composio service not available" });
      }

      // Get toolkit expected parameters
      const toolkitInfo = await composioService.composio.toolkits.get(toolkit.toLowerCase());
      const fields = [];

      // Check for expected input fields (like subdomain)
      if (toolkitInfo?.expectedInputFields) {
        for (const field of toolkitInfo.expectedInputFields) {
          fields.push({
            name: field.name,
            displayName: field.displayName || field.name,
            description: field.description || '',
            required: field.required !== false
          });
        }
      }

      return res.json({ toolkit, fields });
    } catch (error) {
      console.error("[Orchestration] Get connection fields error:", error);
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { initOrchestrationRoutes };
