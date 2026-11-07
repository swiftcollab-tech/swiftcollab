/**
 * SwiftColab Backend Server
 *
 * Architecture Overview:
 * ----------------------
 * This server cleanly separates "thinking" (fast, flexible AI) from "doing" (durable, reliable execution).
 *
 * Request Flow:
 * 1. server.js -> AssistantOrchestrator.handleTurn()
 * 2. ToolRouter dynamically selects Composio actions (single-tool or cross-tool)
 * 3. UnifiedSlotFiller uses live JSON schemas to fill/validate all required parameters
 * 4. ExecutorV2 submits pre-validated executionPlan to Temporal with skipValidation: true
 * 5. Temporal orchestrationWorkflow.js runs tasks sequentially or in parallel
 * 6. composioActivities.js executeComposioAction() is the single source of truth for API calls
 *
 * Result: A scalable multi-tool orchestration pipeline where complex user prompts
 * become reliable, replayable workflows - without duplicating logic across layers.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

// -----------------------------------------------------------------------------
// Core Services
// -----------------------------------------------------------------------------
const { query, initializeDatabase } = require('./db');
const redis = require('./services/redis');
const { ComposioService } = require('./composioService');
const { FrappeService } = require('./integrations/frappe');
const { ComposioProvider } = require('./integrations/ComposioProvider');
const { ConnectorService } = require('./integrations/ConnectorService');
const { createDirectConnectors } = require('./integrations/directConnectors');
const { createLLMService } = require('./services/llmService');

// -----------------------------------------------------------------------------
// Orchestration Components (The "Thinking" Layer)
// -----------------------------------------------------------------------------
const ToolRouter = require('./orchestration/ToolRouter');
const UnifiedSlotFiller = require('./orchestration/unified/UnifiedSlotFiller');
const { ExecutorV2 } = require('./orchestration/executorV2');
const AssistantOrchestrator = require('./orchestration/AssistantOrchestrator');
const AutomationEngine = require('./orchestration/automationEngine');
const ProactiveEngine = require('./orchestration/proactiveEngine');

// -----------------------------------------------------------------------------
// Temporal (The "Doing" Layer - Durable Execution)
// -----------------------------------------------------------------------------
const { startWorker: startTemporalWorker, isWorkerRunning } = require('./temporal/worker');
const { initializeClient: initTemporalClient, isConnected: isTemporalConnected } = require('./temporal/client');

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------
const authRoutes = require('./routes/auth');
const workspaceRoutes = require('./routes/workspace');
const frappeRoutes = require('./routes/frappe');
const organizationRoutes = require('./routes/organizations');
const conversationRoutes = require('./routes/conversations');
const interviewSchedulingRoutes = require('./routes/interviewScheduling');
const googleWorkspaceRoutes = require('./routes/googleWorkspace');
const { startAutomaticInterviewSchedulingJob, stopAutomaticInterviewSchedulingJob } = require('./jobs/automaticInterviewSchedulingJob');
const { initOrchestrationRoutes } = require('./routes/orchestration');
const { initConnectorRoutes } = require('./routes/connectors');

// -----------------------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------------------
const { authenticateToken, optionalAuth } = require('./middleware/auth');
const { sanitizeBody } = require('./middleware/validation');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 4002;
const RENDER_APP_URL = process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
  : null;
const FRONTEND_URL = process.env.FRONTEND_URL || RENDER_APP_URL || 'http://localhost:5173';
// Routes that generate invitation and OAuth callback links read APP_URL
// directly. Give them the deployed Render URL when no explicit custom domain
// has been configured yet.
if (!process.env.APP_URL) process.env.APP_URL = FRONTEND_URL;
const COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || '127.0.0.1:7233';
const TEMPORAL_ENABLED = process.env.TEMPORAL_ENABLED !== 'false';
const ALLOWED_ORIGINS = new Set([
  FRONTEND_URL,
  ...(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  ...(process.env.NODE_ENV === 'production' ? [] : [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
  ]),
]);

// -----------------------------------------------------------------------------
// Provider-neutral LLM helper. Existing components retain the legacy
// `callGemini` callback name, but can now use either OpenAI or local Ollama.
// -----------------------------------------------------------------------------
const llmService = createLLMService();
const callGemini = llmService.complete;

// -----------------------------------------------------------------------------
// Initialize Express App
// -----------------------------------------------------------------------------
const app = express();

// Trust proxy for correct IP detection behind reverse proxies
app.set('trust proxy', 1);

// CORS configuration
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.has(origin)) {
      return callback(null, true);
    }

    console.warn(`[CORS] Blocked request from: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Organization-Id'],
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Cookie parsing (for refresh tokens)
app.use(cookieParser());

// Input sanitization
app.use(sanitizeBody);

// Request logging (development only)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (req.path !== '/api/health') {
        console.log(`[${req.method}] ${req.path} - ${res.statusCode} (${duration}ms)`);
      }
    });
    next();
  });
}

// -----------------------------------------------------------------------------
// Health Check Endpoints
// -----------------------------------------------------------------------------
app.get('/api/health', async (_req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      database: false,
      redis: false,
      composio: false,
      temporal: false,
    },
  };

  // Check database
  try {
    await query('SELECT 1');
    health.services.database = true;
  } catch (e) {
    health.services.database = false;
  }

  // Check Redis
  health.services.redis = redis.isAvailable();

  // Check Composio
  health.services.composio = !!COMPOSIO_API_KEY;

  // Check Temporal
  health.services.temporal = isTemporalConnected() && isWorkerRunning();

  // Overall status
  const criticalServices = ['database', 'composio'];
  const allCriticalOk = criticalServices.every(s => health.services[s]);
  health.status = allCriticalOk ? 'ok' : 'degraded';

  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

// Liveness only proves the HTTP process is running. Render should not restart
// the service merely because an optional dependency is temporarily degraded.
app.get('/api/health/live', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health/detailed', authenticateToken, async (_req, res) => {
  const redisStatus = redis.getStatus();

  res.json({
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    node: process.version,
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    services: {
      database: {
        configured: !!process.env.DATABASE_URL,
      },
      redis: redisStatus,
      temporal: {
        address: TEMPORAL_ADDRESS,
        clientConnected: isTemporalConnected(),
        workerRunning: isWorkerRunning(),
      },
      composio: {
        configured: !!COMPOSIO_API_KEY,
      },
      llm: {
        provider: llmService.provider,
        model: llmService.model,
        configured: llmService.configured,
      },
    },
  });
});

// -----------------------------------------------------------------------------
// Mount Static Routes (no dependencies)
// -----------------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/workspace', workspaceRoutes);
app.use('/api/frappe', frappeRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/interview-scheduling', interviewSchedulingRoutes);
app.use('/api/integrations/google', googleWorkspaceRoutes);

// -----------------------------------------------------------------------------
// Bootstrap Orchestration Stack
// -----------------------------------------------------------------------------
async function bootstrapOrchestration() {
  console.log('\n========================================');
  console.log(' SwiftColab Backend - Starting Up');
  console.log('========================================\n');

  // Step 1: Initialize Database
  console.log('[1/6] Initializing database...');
  try {
    await initializeDatabase();
    console.log('      Database ready');
  } catch (err) {
    console.warn('      Database init warning:', err.message);
  }

  // Step 2: Initialize Composio Service
  console.log('[2/6] Initializing Composio service...');
  if (!COMPOSIO_API_KEY) {
    console.error('      COMPOSIO_API_KEY not set - orchestration will not work');
    return null;
  }
  const composioService = new ComposioService(COMPOSIO_API_KEY);
  const connectorService = new ConnectorService({
    composioProvider: new ComposioProvider(composioService),
    directConnectors: createDirectConnectors(),
  });
  console.log('      Composio service ready');

  // Step 3: Initialize Frappe Service (optional)
  console.log('[3/6] Initializing Frappe service...');
  let frappeService = null;
  if (process.env.FRAPPE_URL) {
    frappeService = new FrappeService({
      url: process.env.FRAPPE_URL,
      apiKey: process.env.FRAPPE_API_KEY,
      apiSecret: process.env.FRAPPE_API_SECRET,
    });
    console.log('      Frappe service ready');
  } else {
    console.log('      Frappe not configured (optional)');
  }

  // Step 4: Build Orchestration Components
  console.log('[4/6] Building orchestration stack...');
  const llmStatus = await llmService.checkConnection();
  console.log(`      LLM provider: ${llmService.provider} (${llmService.model})`);
  if (llmService.provider === 'ollama' && !llmStatus.reachable) {
    console.warn(`      Ollama is not reachable at ${llmService.baseUrl}`);
  } else if (llmService.provider === 'ollama' && !llmStatus.modelInstalled) {
    console.warn(`      Ollama model is not installed: ${llmService.model}`);
  }

  // 4a. ToolRouter - Selects tools and extracts initial params
  const toolRouter = new ToolRouter({
    composioToolSet: composioService,
    connectorService,
    callGemini,
    frappeService,
    query,
    options: {
      userTimeZone: 'UTC',
      cacheTtlMs: 5 * 60 * 1000,
    },
  });

  // 4b. UnifiedSlotFiller - Schema-driven parameter validation
  const slotFiller = new UnifiedSlotFiller({
    composioToolSet: composioService,
    callGemini,
    options: {
      maxQuestionRounds: 20,
      progressiveDisclosure: true,
      userTimeZone: 'UTC',
    },
  });

  // 4c. ExecutorV2 - Unified execution (Temporal primary, fallback to direct)
  const executor = new ExecutorV2({
    composio: composioService,
    connectorService,
    query,
    callGemini,
    options: {
      maxConcurrency: 25,
      defaultTimeout: 30000,
      useTemporalPrimary: true,
    },
  });

  // 4d. AssistantOrchestrator - Main entry point
  // A configured Redis client can still be disconnected (for example after a
  // failed Redis Cloud connection). Do not pass that client to the
  // orchestrator: ioredis throws "Connection is closed" on session locks.
  // Use the in-memory implementation until Redis is actually ready.
  const redisClient = redis.isAvailable() ? redis.getClient() : null;
  if (!redisClient) {
    console.warn('      Redis not available - sessions will not persist');
  }

  const assistantOrchestrator = new AssistantOrchestrator({
    toolRouter,
    slotFiller,
    executor,
    redis: redisClient || createInMemoryRedis(),
    callGemini,
    options: {
      requireConfirmationForWrites: true,
      sessionTtlSeconds: 60 * 60 * 24 * 7, // 7 days
    },
  });

  console.log('      Orchestration stack ready');

  // Step 5: Initialize Engines (AutomationEngine, ProactiveEngine)
  console.log('[5/6] Initializing engines...');

  const automationEngine = new AutomationEngine({
    composio: composioService,
    query,
    executor,
  });
  assistantOrchestrator.setAutomationEngine(automationEngine);

  const proactiveEngine = new ProactiveEngine({
    composio: composioService,
    query,
    callGemini,
  });
  assistantOrchestrator.setProactiveEngine(proactiveEngine);

  console.log('      Engines ready');

  // Step 6: Start Temporal Worker (non-blocking)
  console.log('[6/6] Starting Temporal worker...');
  if (!TEMPORAL_ENABLED) {
    console.log('      Temporal disabled - using direct execution fallback');
  } else {
    try {
      await initTemporalClient(TEMPORAL_ADDRESS);
      await startTemporalWorker({
        composio: composioService,
        callGemini,
        query,
        temporalAddress: TEMPORAL_ADDRESS,
      });
      console.log('      Temporal worker running');
    } catch (err) {
      console.warn('      Temporal not available:', err.message);
      console.warn('      (Executor will use direct execution fallback)');
    }
  }

  console.log('\n========================================');
  console.log(' Orchestration Bootstrap Complete');
  console.log('========================================\n');

  return { assistantOrchestrator, composioService, connectorService };
}

/**
 * Fallback in-memory Redis-like store for development without Redis
 */
function createInMemoryRedis() {
  const store = new Map();
  const locks = new Map();

  return {
    get: async (key) => store.get(key) || null,
    set: async (key, value, ...args) => {
      store.set(key, value);
      // Handle EX ttl
      if (args[0] === 'EX' && args[1]) {
        setTimeout(() => store.delete(key), args[1] * 1000);
      }
      return 'OK';
    },
    del: async (key) => store.delete(key),
    publish: async () => 0,
    eval: async (_script, _numKeys, ...args) => {
      // Simple lock release simulation
      const key = args[0];
      const token = args[1];
      if (locks.get(key) === token) {
        locks.delete(key);
        return 1;
      }
      return 0;
    },
  };
}

// -----------------------------------------------------------------------------
// Main Startup
// -----------------------------------------------------------------------------
async function main() {
  try {
    // Bootstrap orchestration
    const bootstrapResult = await bootstrapOrchestration();
    const assistantOrchestrator = bootstrapResult?.assistantOrchestrator;
    const composioService = bootstrapResult?.composioService;
    const connectorService = bootstrapResult?.connectorService;

    if (assistantOrchestrator) {
      app.use('/api/connectors', initConnectorRoutes({ connectorService, authenticateToken }));
      // Mount orchestration routes (requires orchestrator)
      const orchestrationRoutes = initOrchestrationRoutes(
        assistantOrchestrator,
        authenticateToken,
        optionalAuth,
        composioService,
        connectorService
      );
      app.use('/api', orchestrationRoutes);
    } else {
      console.warn('[Server] Orchestration not available - AI features disabled');

      // Fallback route for when orchestration is not available
      app.use('/api/assistant', (_req, res) => {
        res.status(503).json({
          type: 'error',
          message: 'AI orchestration is not available. Please check server configuration.',
        });
      });
    }

    // 404 handler for API routes
    app.use('/api/*', (_req, res) => {
      res.status(404).json({ error: 'Endpoint not found' });
    });

    // The production service hosts the Vite build and API together. This
    // catch-all supports client-side routing without interfering with /api.
    if (process.env.NODE_ENV === 'production') {
      const frontendDist = path.join(__dirname, '..', 'dist');
      app.use(express.static(frontendDist));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        return res.sendFile(path.join(frontendDist, 'index.html'));
      });
    }

    // Global error handler
    app.use((err, _req, res, _next) => {
      console.error('[Server] Unhandled error:', err);
      res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production'
          ? 'Internal server error'
          : err.message,
      });
    });

    // Start server
    const server = app.listen(PORT, () => {
      console.log(`\n[Server] Listening on port ${PORT}`);
      console.log(`[Server] Frontend URL: ${FRONTEND_URL}`);
      console.log(`[Server] API Base: http://localhost:${PORT}/api\n`);
    });
    startAutomaticInterviewSchedulingJob();

    // Graceful shutdown
    const shutdown = async (signal) => {
      console.log(`\n[Server] Received ${signal}, shutting down gracefully...`);

      // Stop accepting new connections
      stopAutomaticInterviewSchedulingJob();
      server.close(() => {
        console.log('[Server] HTTP server closed');
      });

      // Close Redis
      try {
        await redis.close();
        console.log('[Server] Redis connection closed');
      } catch (e) {
        console.warn('[Server] Redis close error:', e.message);
      }

      // Destroy orchestrator
      if (assistantOrchestrator) {
        try {
          assistantOrchestrator.destroy();
          console.log('[Server] Orchestrator destroyed');
        } catch (e) {
          console.warn('[Server] Orchestrator destroy error:', e.message);
        }
      }

      console.log('[Server] Graceful shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Unhandled rejection handler
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
    });

  } catch (err) {
    console.error('[Server] Fatal startup error:', err);
    process.exit(1);
  }
}

// Start the server
main();

module.exports = app;
// Restart trigger
