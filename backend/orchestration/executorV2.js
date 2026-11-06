/**
 * ExecutorV2 (Unified Executor)
 *
 * One production executor for *all* execution paths:
 * - OrchestrationEngine plans (PlanBuilder output)
 * - ToolRouter + UnifiedSlotFiller tool chains
 * - Unified intent graphs (IntentGraphBuilder output)
 * - AutomationEngine single-action executions
 *
 * Responsibilities intentionally kept OUTSIDE the executor:
 * - Tool routing (ToolRouter)
 * - Slot filling / question loops (UnifiedSlotFiller / PreValidationLayer)
 * - Preflight API enrichment (PreflightChecker / PreflightResolver)
 *
 * Core capabilities:
 * - DAG execution with concurrency control (handles 50-100 steps)
 * - Dependency-aware typed injection between steps (deterministic, no JSON dumps)
 * - Retries using ResultNormalizer retry strategies (rate-limit, timeout, etc.)
 * - Idempotency via IdempotencyGateway (semantic key + cached results)
 * - Side-effect gating via SideEffectGateway (phase control)
 * - Optional DB persistence for execution plans (if `query` is provided)
 */

const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");

const { FrappeService, FRAPPE_ACTION_NAMES } = require("../integrations/frappe");

// Temporal client (lazy-loaded to avoid startup errors if Temporal is not available)
let temporalClient = null;
let temporalInitialized = false;

async function getTemporalClient() {
  if (temporalInitialized) return temporalClient;

  try {
    const temporal = require("../temporal/client");
    const address = process.env.TEMPORAL_ADDRESS || "127.0.0.1:7233";
    await temporal.initializeClient(address);
    temporalClient = temporal;
    temporalInitialized = true;
    console.log("[ExecutorV2] Temporal client connected");
    return temporalClient;
  } catch (err) {
    console.warn("[ExecutorV2] Temporal not available:", err.message);
    temporalInitialized = true; // Mark as initialized to avoid retry
    return null;
  }
}
const { ActionRegistry } = require("./core/ActionRegistry");
const { SideEffectGateway, SIDE_EFFECT_TIERS, EXECUTION_PHASES } = require("./core/SideEffectGateway");
const { IdempotencyGateway, EXECUTION_STATES } = require("./core/IdempotencyGateway");
const { ExecutionPolicyEngine, EXECUTION_POLICIES, STEP_STATUS, CHECKPOINT_ACTIONS } = require("./core/ExecutionPolicyEngine");
const { ResultNormalizer, NORMALIZED_STATUS } = require("./core/ResultNormalizer");
const { isToolSuccess, getToolError, normalizeParams } = require("./core/ToolUtils");
const { formatTypedInjection } = require("./core/TypedInjection");

// -----------------------------------------------------------------------------
// Small internal helpers
// -----------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidUUID(str) {
  if (!str || typeof str !== "string") return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

function sha256Short(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex").slice(0, 16);
}

function withTimeout(promise, timeoutMs, label = "operation") {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function containsValueDeep(value, needle) {
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((v) => containsValueDeep(v, needle));
  if (isPlainObject(value)) return Object.values(value).some((v) => containsValueDeep(v, needle));
  return false;
}

function mapObjectDeep(value, mapper, path = []) {
  if (Array.isArray(value)) return value.map((v, idx) => mapObjectDeep(v, mapper, [...path, String(idx)]));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapObjectDeep(v, mapper, [...path, k]);
    return out;
  }
  return mapper(value, path);
}

function unwrapToolPayload(toolStepResult) {
  // toolStepResult is typically { successful, data, error, ... }
  if (!toolStepResult) return null;
  if (typeof toolStepResult !== "object") return toolStepResult;
  if ("data" in toolStepResult) return toolStepResult.data;
  return toolStepResult;
}

// Stable stringify for deterministic keys (best-effort)
function stableStringify(obj) {
  try {
    if (obj === null || obj === undefined) return String(obj);
    if (typeof obj !== "object") return JSON.stringify(obj);
    if (Array.isArray(obj)) return `[${obj.map((x) => stableStringify(x)).join(",")}]`;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `"${k}":${stableStringify(obj[k])}`);
    return `{${parts.join(",")}}`;
  } catch (_) {
    return JSON.stringify(obj);
  }
}

class Semaphore {
  constructor(max) {
    this.max = Math.max(1, Number(max) || 1);
    this.current = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.current < this.max) {
      this.current += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.current += 1;
  }

  release() {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

// -----------------------------------------------------------------------------
// Unified Executor
// -----------------------------------------------------------------------------

class ExecutorV2 {
  constructor({ composio, connectorService = null, query, callGemini, options = {} }) {
    if (!composio) throw new Error("composio required");
    this.composio = composio;
    this.connectorService = connectorService;
    this.query = query || null;
    this.callGemini = callGemini || null;

    this.frappeService = new FrappeService();

    this.sideEffectGateway = new SideEffectGateway({
      onBlock: (info) => console.warn("[ExecutorV2] Blocked by SideEffectGateway:", info),
      onSanitize: (info) => console.log("[ExecutorV2] Params sanitized:", info.action),
    });

    this.idempotencyGateway = new IdempotencyGateway({
      ttlMs: options.idempotencyTtlMs ?? 24 * 60 * 60 * 1000,
      maxRetries: options.idempotencyMaxRetries ?? 3,
      onDuplicate: (info) => console.warn("[ExecutorV2] Duplicate detected:", info),
      onStateChange: (info) =>
        console.log("[ExecutorV2] Execution state:", info.requestId, info.oldState, "->", info.newState),
      providerLookup: options.providerLookup || null,
    });

    // Polyfill Fix 3 (atomic check-and-acquire) if gateway hasn't been updated yet
    if (typeof this.idempotencyGateway.checkAndAcquire !== "function") {
      this.idempotencyGateway._locks = this.idempotencyGateway._locks || new Map();

      this.idempotencyGateway.checkAndAcquire = async (requestId, actionName, params, context = {}) => {
        const gw = this.idempotencyGateway;

        // Try to compute semantic key consistently
        let semanticKey = null;
        if (typeof gw._computeSemanticKey === "function") {
          try {
            semanticKey = gw._computeSemanticKey(actionName, params, context);
          } catch (_) {
            semanticKey = null;
          }
        }
        if (!semanticKey) {
          const fallback = `${String(actionName)}|${stableStringify(params)}|${context.userId || ""}|${context.sessionId || ""}`;
          semanticKey = `fallback_${sha256Short(fallback)}`;
        }

        // Spin-lock (process-local) to avoid check/mark race
        while (gw._locks.get(semanticKey)) {
          await sleep(10);
        }
        gw._locks.set(semanticKey, true);

        try {
          const check = await gw.check(requestId, actionName, params, context);
          if (check && check.canProceed) {
            gw.markInProgress(requestId);
          }
          return check;
        } finally {
          gw._locks.delete(semanticKey);
        }
      };
    }

    // Kept for compatibility with existing policy hooks.
    this.policyEngine = new ExecutionPolicyEngine({
      highRiskThreshold: options.highRiskThreshold ?? 0.6,
      criticalRiskThreshold: options.criticalRiskThreshold ?? 0.8,
    });

    this.resultNormalizer = new ResultNormalizer();

    this.currentPhase = options.defaultPhase || EXECUTION_PHASES.EXECUTION;

    this.config = {
      maxConcurrency: options.maxConcurrency ?? 25,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000,
      defaultMaxRetries: options.defaultMaxRetries ?? 3,
      defaultBackoffMs: options.defaultBackoffMs ?? 1000,
      injectSentinel: options.injectSentinel || "_inject_from_previous",
      injectionMaxChars: options.injectionMaxChars ?? 6000,
      useTemporalPrimary: options.useTemporalPrimary ?? true,
    };

    // Global concurrency
    this.globalSemaphore = new Semaphore(this.config.maxConcurrency);

    // Fix 4: per-provider concurrency + rate-limit tracking
    this._providerSemaphores = new Map();
    this._providerRateLimitUntil = new Map();

    this._providerConcurrencyLimits = {
      gmail: 5,
      googlecalendar: 6,
      jira: 10,
      slack: 8,
      github: 10,
      trello: 6,
      asana: 8,
      notion: 6,
      hubspot: 8,
      frappe: 10,
      default: 6,
    };
  }

  // ---------------------------------------------------------------------------
  // Compatibility helpers (used by orchestration/index.js)
  // ---------------------------------------------------------------------------

  setPhase(phase) {
    if (!Object.values(EXECUTION_PHASES).includes(phase)) {
      console.warn(`[ExecutorV2] Invalid phase: ${phase}, using EXECUTION`);
      this.currentPhase = EXECUTION_PHASES.EXECUTION;
      return;
    }
    this.currentPhase = phase;
  }

  getActionsForCurrentPhase() {
    return this.sideEffectGateway.getActionsForPhase(this.currentPhase);
  }

  requiresConfirmation(actionName) {
    return this.sideEffectGateway.requiresConfirmation(actionName);
  }

  getSideEffectSummary(actionNames) {
    return this.sideEffectGateway.summarizeSideEffects(actionNames);
  }

  getActionWarning(actionName) {
    return this.sideEffectGateway.generateWarning(actionName);
  }

  getIdempotencyStats() {
    return this.idempotencyGateway.getStats();
  }

  getExecutionState(requestId) {
    return this.idempotencyGateway.getExecutionState(requestId);
  }

  clearIdempotencyState() {
    this.idempotencyGateway.clear();
  }

  // ---------------------------------------------------------------------------
  // Fix 5: progress emission helper
  // ---------------------------------------------------------------------------

  _emitProgress(onProgress, event) {
    if (typeof onProgress !== "function") return;
    try {
      onProgress({ ...event, timestamp: event.timestamp || Date.now() });
    } catch (e) {
      console.warn("[ExecutorV2] onProgress callback error:", e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Fix 4: provider helpers
  // ---------------------------------------------------------------------------

  _inferProvider(actionName) {
    if (!actionName) return "unknown";
    const prefix = String(actionName).split("_")[0].toLowerCase();
    return prefix || "unknown";
  }

  _getProviderSemaphore(provider) {
    const p = (provider || "default").toLowerCase();
    if (!this._providerSemaphores.has(p)) {
      const limit = this._providerConcurrencyLimits[p] || this._providerConcurrencyLimits.default;
      this._providerSemaphores.set(p, new Semaphore(limit));
    }
    return this._providerSemaphores.get(p);
  }

  async _waitForProviderRateLimit(provider) {
    const p = (provider || "default").toLowerCase();
    const until = this._providerRateLimitUntil.get(p) || 0;
    const now = Date.now();
    if (until > now) {
      await sleep(until - now);
    }
  }

  _setProviderRateLimit(provider, delayMs) {
    const p = (provider || "default").toLowerCase();
    const until = Date.now() + delayMs;
    const current = this._providerRateLimitUntil.get(p) || 0;
    this._providerRateLimitUntil.set(p, Math.max(current, until));
  }

  _extractRetryAfter(result) {
    if (!result) return null;

    const sources = [
      result.retryAfterMs,
      result.retry_after_ms,
      result.retryAfter,
      result.retry_after,
      result.headers?.["retry-after"],
      result.headers?.["Retry-After"],
      result._normalized?.retry?.delay_ms,
      result._retryInfo?.delay_ms,
    ];

    for (const val of sources) {
      if (val != null) {
        const num = Number(val);
        if (Number.isFinite(num) && num > 0) {
          return num < 1000 ? num * 1000 : num;
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Fix 2: Composio API compatibility wrapper
  // ---------------------------------------------------------------------------

  async _executeComposioAction(actionName, params, entityId) {
    if (this.connectorService) {
      return this.connectorService.executeAction({ actionName, params, entityId });
    }
    // Prefer positional arguments (our ComposioService wrapper uses this signature).
    // Only fall back to the object signature if positional invocation fails.
    try {
      return await this.composio.executeAction(actionName, params, entityId);
    } catch (e) {
      const msg = String(e?.message || "");
      const looksLikeObjectSignature =
        msg.includes("destructure") ||
        msg.includes("Cannot destructure") ||
        msg.includes("object") ||
        msg.includes("expected") ||
        msg.includes("argument") ||
        msg.includes("signature");

      if (!looksLikeObjectSignature) throw e;

      return await this.composio.executeAction({
        action: actionName,
        params,
        entityId,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Execution entry points
  // ---------------------------------------------------------------------------

  /**
   * Execute a PlanBuilder-style plan via Temporal workflow.
   *
   * Temporal is REQUIRED - no fallback. PreflightChecker runs inside Temporal workflow.
   *
   * Fix 6: plan-level timeout
   * Fix 5: progress callbacks
   * Fix 11: resume support
   */
  async execute({ plan, userId, entityId, conversationId, options = {}, onProgress = null, resumeFrom = null }) {
    if (!plan) throw new Error("plan required");
    if (!entityId) throw new Error("entityId required");

    // SYSTEM_* and FRAPPE_* steps are not handled by the Temporal Composio-only worker.
    // Execute them directly in-process.
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    const requiresLocalExecution = steps.some((s) =>
      this.isSystemAction(s?.action) || this.isFrappeAction(s?.action) ||
      s?.provider === 'direct' || String(s?.action || '').startsWith('JIRA_')
    );
    if (requiresLocalExecution) {
      return this._executeInternal({ plan, userId, entityId, conversationId, options, onProgress, resumeFrom });
    }

    if (this.config.useTemporalPrimary === false) {
      return this._executeInternal({ plan, userId, entityId, conversationId, options, onProgress, resumeFrom });
    }

    // Get Temporal client - REQUIRED
    const temporal = await getTemporalClient();
    if (!temporal || !temporal.isConnected()) {
      // Fallback to direct execution for local/dev environments.
      const error = "Temporal server is not running. Falling back to direct execution.";
      console.warn(`[ExecutorV2] ${error}`);
      this._emitProgress(onProgress, { type: "temporal_unavailable_fallback", planId: plan.id, message: error });
      return this._executeInternal({ plan, userId, entityId, conversationId, options, onProgress, resumeFrom });
    }

    console.log(`[ExecutorV2] Executing plan ${plan.id || "unknown"} via Temporal workflow`);

    this._emitProgress(onProgress, {
      type: "temporal_start",
      planId: plan.id,
      message: "Starting durable Temporal workflow execution",
    });

    // CRITICAL: Ensure plan has `tasks` property for Temporal workflow compatibility
    // Temporal's orchestrationWorkflow.js expects executionPlan.tasks, not executionPlan.steps
    const temporalPlan = {
      ...plan,
      tasks: plan.tasks || this._stepsToTemporalTasks(steps),
      ready: plan.ready !== false,
      entityId: plan.entityId || entityId,
      userId: plan.userId || userId,
      originalMessage: plan.originalMessage || plan.intent || options.originalMessage || null,
    };

    try {
      const workflowResult = await temporal.startOrchestrationWorkflow({
        message: plan.intent || "Execute plan",
        userId,
        entityId,
        selectedToolkits: options.selectedToolkits || [],
        availableTools: options.availableTools || [],
        executionPlan: temporalPlan,
        skipValidation: true, // Plan is already validated
        resumeFrom: resumeFrom || null,
      });

      // Map Temporal result to executor result format
      return this._mapTemporalResult(workflowResult, plan, onProgress);
    } catch (temporalErr) {
      console.error(`[ExecutorV2] Temporal workflow failed: ${temporalErr.message}`);

      this._emitProgress(onProgress, {
        type: "temporal_error",
        planId: plan.id,
        error: temporalErr.message,
      });

      return {
        id: uuidv4(),
        planId: plan.id || null,
        success: false,
        error: temporalErr.message,
        status: "workflow_failed",
        results: [],
        stepResults: {},
        summary: `Temporal workflow failed: ${temporalErr.message}`,
      };
    }
  }

  /**
   * Map Temporal workflow result to executor result format
   */
  _mapTemporalResult(workflowResult, plan, onProgress) {
    const executionId = workflowResult.workflowId || uuidv4();

    this._emitProgress(onProgress, {
      type: "temporal_complete",
      workflowId: executionId,
      success: workflowResult.type !== "error",
    });

    // Handle error responses
    if (workflowResult.type === "error") {
      return {
        id: executionId,
        planId: plan.id || null,
        success: false,
        error: workflowResult.message || workflowResult.error,
        status: "failed",
        results: [],
        stepResults: {},
        summary: workflowResult.message || "Workflow execution failed",
        _temporal: true,
        workflowId: executionId,
      };
    }

    // Handle success responses
    const results = workflowResult.results || [];
    const stepResults = {};

    // Build stepResults from results array
    results.forEach((r, idx) => {
      const stepId = r.stepId || r.taskId || `step_${idx}`;
      stepResults[stepId] = r;
    });

    return {
      id: executionId,
      planId: plan.id || null,
      template: plan.template || "TEMPORAL",
      success: workflowResult.type === "success" || workflowResult.type === "execution_result",
      results,
      stepResults,
      summary: workflowResult.message || `Executed via Temporal workflow ${executionId}`,
      _temporal: true,
      workflowId: executionId,
      // Include any additional data from workflow
      data: workflowResult.data || null,
    };
  }

  async _executeInternal({ plan, userId, entityId, conversationId, options = {}, onProgress = null, resumeFrom = null }) {
    const executionId = uuidv4();
    const startedAt = Date.now();

    await this._storePlanSafe(plan, userId, conversationId);

    const steps = this._normalizeSteps(plan.steps || []);

    // Fix 5: start event
    this._emitProgress(onProgress, {
      type: "execution_start",
      executionId,
      planId: plan.id,
      totalSteps: steps.length,
      timestamp: startedAt,
    });

    // Fix 11: resume pre-population
    const initialStepResults = {};
    if (resumeFrom?.stepResults && typeof resumeFrom.stepResults === "object") {
      for (const [stepId, result] of Object.entries(resumeFrom.stepResults)) {
        if (result?.success) {
          initialStepResults[stepId] = result;

          // best-effort restore into idempotency cache
          const step = steps.find((s) => s.id === stepId);
          if (step) {
            const requestId = step.idempotencyKey || `resumed_${stepId}_${Date.now()}`;
            if (typeof this.idempotencyGateway.markCompleted === "function") {
              try {
                this.idempotencyGateway.markCompleted(requestId, result.data);
              } catch (_) { }
            }
          }
        }
      }

      this._emitProgress(onProgress, {
        type: "resume_start",
        executionId,
        resumedSteps: Object.keys(initialStepResults).length,
        totalSteps: steps.length,
      });
    }

    const dag = await this._executeDag({ steps, entityId, userId, plan, options, onProgress, initialStepResults });

    const finishedAt = Date.now();

    // Fix 5: complete event
    this._emitProgress(onProgress, {
      type: "execution_complete",
      executionId,
      planId: plan.id,
      success: dag.success,
      totalSteps: steps.length,
      completedSteps: dag.results.filter((r) => r.success).length,
      failedSteps: dag.results.filter((r) => !r.success).length,
      duration: finishedAt - startedAt,
      timestamp: finishedAt,
    });

    const result = {
      id: executionId,
      planId: plan.id || null,
      template: plan.template || "DAG",
      success: dag.success,
      results: dag.results,
      stepResults: dag.stepResults,
      summary: dag.summary,
      startTime: startedAt,
      endTime: finishedAt,
      duration: finishedAt - startedAt,
    };

    // Fix 11: include resume token if failed
    if (!dag.success) {
      result.resumeToken = {
        planId: plan.id,
        stepResults: dag.stepResults,
        context: { userId, entityId, conversationId },
        failedAt: Date.now(),
      };
    }

    await this._updatePlanStatusSafe(plan.id, result.success ? "completed" : "failed", result);
    return result;
  }

  /**
   * Execute UnifiedSlotFiller tool chain output.
   *
   * tools: [{ name, composio_action, sequence, params }]
   *
   * PRIMARY: Temporal workflow (durable)
   * FALLBACK: Direct execution
   */
  async executeToolChain({ tools, userId, entityId, conversationId, options = {}, onProgress = null, resumeFrom = null }) {
    if (!Array.isArray(tools) || tools.length === 0) throw new Error("tools[] required");
    const steps = this._toolChainToSteps(tools);
    const plan = {
      id: options.planId || uuidv4(),
      intent: "TOOL_CHAIN",
      type: "multi_step_workflow",
      steps: steps,
      // CRITICAL: Temporal workflow expects `tasks` property, not `steps`
      // Map steps to tasks format with toolkit extraction
      tasks: this._stepsToTemporalTasks(steps),
      ready: true, // Signal that all params are filled
      originalMessage: options.originalMessage || null,
      entityId,
      userId,
      organizationId: options.organizationId || null,
    };
    return this.execute({ plan, userId, entityId, conversationId, options, onProgress, resumeFrom });
  }

  /**
   * Check if Temporal is available and connected
   */
  async isTemporalAvailable() {
    try {
      const temporal = await getTemporalClient();
      return temporal && temporal.isConnected();
    } catch {
      return false;
    }
  }

  /**
   * Initialize Temporal connection proactively
   */
  async initTemporal() {
    try {
      const temporal = await getTemporalClient();
      return { connected: temporal && temporal.isConnected() };
    } catch (err) {
      return { connected: false, error: err.message };
    }
  }

  /**
   * Get Temporal workflow status
   */
  async getWorkflowStatus(workflowId) {
    try {
      const temporal = await getTemporalClient();
      if (!temporal || !temporal.isConnected()) {
        return { error: "Temporal not connected" };
      }
      return await temporal.queryWorkflowState(workflowId);
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Cancel a Temporal workflow
   */
  async cancelWorkflow(workflowId) {
    try {
      const temporal = await getTemporalClient();
      if (!temporal || !temporal.isConnected()) {
        return { error: "Temporal not connected" };
      }
      await temporal.cancelWorkflow(workflowId);
      return { cancelled: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Execute IntentGraphBuilder output.
   *
   * intentGraph.actions: [{ id, tool, params, dependsOn, injectFrom }]
   */
  async executeIntentGraph({ intentGraph, userId, entityId, conversationId, options = {}, onProgress = null, resumeFrom = null }) {
    if (!intentGraph || !Array.isArray(intentGraph.actions)) throw new Error("intentGraph.actions required");
    const steps = this._intentGraphToSteps(intentGraph.actions);
    const plan = {
      id: options.planId || uuidv4(),
      intent: intentGraph.reasoning || "INTENT_GRAPH",
      type: "multi_step_workflow",
      steps: steps,
      // CRITICAL: Temporal workflow expects `tasks` property
      tasks: this._stepsToTemporalTasks(steps),
      ready: true,
      originalMessage: options.originalMessage || null,
      entityId,
      userId,
    };
    return this.execute({ plan, userId, entityId, conversationId, options, onProgress, resumeFrom });
  }

  /**
   * Convenience: execute a single action (AutomationEngine-style).
   */
  async executeAction({ actionName, params, userId, entityId, conversationId, options = {}, onProgress = null, resumeFrom = null }) {
    const steps = [
      {
        id: `step_${sha256Short(`${actionName}_${Date.now()}`)}`,
        type: "tool",
        action: actionName,
        params: params || {},
        dependsOn: [],
      },
    ];
    const plan = {
      id: options.planId || uuidv4(),
      intent: "SINGLE_ACTION",
      type: "single_action",
      steps: steps,
      // CRITICAL: Temporal workflow expects `tasks` property
      tasks: this._stepsToTemporalTasks(steps),
      ready: true,
      entityId,
      userId,
    };
    return this.execute({ plan, userId, entityId, conversationId, options, onProgress, resumeFrom });
  }

  // ---------------------------------------------------------------------------
  // Normalization / conversion helpers
  // ---------------------------------------------------------------------------

  _normalizeSteps(steps) {
    const out = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i] || {};
      out.push({
        id: s.id || `step_${i + 1}_${uuidv4().slice(0, 8)}`,
        type: s.type || "tool",
        action: s.action || s.composio_action || s.tool || null,
        params: s.params && typeof s.params === "object" ? s.params : {},
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.slice() : [],
        parallelGroup: s.parallelGroup || null,
        retryConfig: s.retryConfig || null,
        timeoutMs: s.timeoutMs || null,
        optional: !!s.optional,
        useTransformedData: !!s.useTransformedData,
        idempotencyKey: s.idempotencyKey || null,
        phase: s.phase || null,
        injectFrom: s.injectFrom || null,
        metadata: s.metadata || {},
        sessionId: s.sessionId || null,
      });
    }
    return out;
  }

  _intentGraphToSteps(actions) {
    return actions.map((a, idx) => ({
      id: String(a.id || `a${idx + 1}`),
      type: "tool",
      action: a.tool,
      params: a.params || {},
      dependsOn: Array.isArray(a.dependsOn) ? a.dependsOn.slice() : [],
      parallelGroup: null,
      injectFrom: a.injectFrom || {},
      retryConfig: { maxRetries: 3, backoffMs: 1000 },
    }));
  }

  _toolChainToSteps(tools) {
    const sorted = tools.slice().sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    const steps = [];
    const groupIdBySequence = new Map();

    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i] || {};
      const action = t.composio_action || t.action || t.name;
      const seq = Number.isFinite(t.sequence) ? t.sequence : i + 1;
      const stepId = t.id || `tc_${seq}_${i + 1}_${sha256Short(action)}`;

      if (!groupIdBySequence.has(seq)) groupIdBySequence.set(seq, `seq_${seq}_${uuidv4().slice(0, 8)}`);

      const params = t.params && typeof t.params === "object" ? t.params : {};
      const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn.slice() : [];

      // Best-effort ordering for toolchain:
      // - if injection sentinel used, enforce dependency on previous step
      // - if usePreviousOutput is true, enforce dependency on previous step
      // - otherwise keep groups by sequence in _executeLevel (group order)
      const hasInjectionSentinel = containsValueDeep(params, this.config.injectSentinel);
      const needsPreviousOutput = !!t.usePreviousOutput;

      if (i > 0 && dependsOn.length === 0 && (hasInjectionSentinel || needsPreviousOutput)) {
        dependsOn.push(steps[i - 1].id);
        console.log(`[ExecutorV2] Step "${action}" depends on "${steps[i - 1].action}" for data injection`);
      }

      // CRITICAL: Tasks with dependencies should NOT get parallelGroup
      // They must run as sequential tasks so that injection can happen
      const hasDepOrNeedsData = dependsOn.length > 0 || needsPreviousOutput || hasInjectionSentinel;

      steps.push({
        id: stepId,
        type: "tool",
        action,
        params,
        dependsOn,
        // Only assign parallelGroup to tasks that don't depend on previous results
        parallelGroup: hasDepOrNeedsData ? null : groupIdBySequence.get(seq),
        retryConfig: { maxRetries: 3, backoffMs: 1000 },
        metadata: { sequence: seq, toolName: t.name || null, usePreviousOutput: needsPreviousOutput },
      });
    }

    return steps;
  }

  /**
   * Convert steps to Temporal's expected task format.
   *
   * Temporal workflow (orchestrationWorkflow.js) expects:
   * - executionPlan.tasks (NOT executionPlan.steps)
   * - Each task needs: id, action, params, dependsOn, parallelGroup, toolkit, optional
   *
   * This ensures schema compatibility between ExecutorV2 and Temporal.
   */
  _stepsToTemporalTasks(steps) {
    if (!Array.isArray(steps)) return [];

    return steps.map((step) => {
      // Extract toolkit from action name (e.g., GMAIL_SEND_EMAIL -> GMAIL)
      const action = step.action || '';
      const toolkit = this._extractToolkitFromAction(action);

      return {
        id: step.id,
        action: step.action,
        params: step.params || {},
        dependsOn: step.dependsOn || [],
        parallelGroup: step.parallelGroup || null,
        toolkit: toolkit,
        optional: step.optional || false,
        // Include injection metadata for Temporal's injectPreviousTaskData
        _injectResultTo: step.injectFrom ? Object.keys(step.injectFrom)[0] : null,
        _sourceTaskId: step.injectFrom ? Object.values(step.injectFrom)[0]?.split('.')[0] : null,
        // Preserve metadata
        metadata: step.metadata || {},
      };
    });
  }

  /**
   * Extract toolkit name from action.
   * Examples:
   *   GMAIL_SEND_EMAIL -> GMAIL
   *   GOOGLECALENDAR_CREATE_EVENT -> GOOGLECALENDAR
   *   FRAPPE_CREATE_CUSTOMER -> FRAPPE
   *   JIRA_SEARCH_ISSUES -> JIRA
   */
  _extractToolkitFromAction(action) {
    if (!action) return 'UNKNOWN';

    const actionStr = String(action).toUpperCase();

    // Handle known multi-word toolkit names first
    if (actionStr.startsWith('GOOGLECALENDAR_')) return 'GOOGLECALENDAR';
    if (actionStr.startsWith('GOOGLE_CALENDAR_')) return 'GOOGLECALENDAR';

    // Standard pattern: TOOLKIT_ACTION_NAME
    const parts = actionStr.split('_');
    if (parts.length >= 2) {
      return parts[0];
    }

    return 'UNKNOWN';
  }

  // ---------------------------------------------------------------------------
  // DAG validation and scheduling
  // ---------------------------------------------------------------------------

  _validateDag(steps) {
    const ids = new Set(steps.map((s) => s.id));
    const errors = [];

    for (const s of steps) {
      for (const dep of s.dependsOn || []) {
        if (!ids.has(dep)) errors.push(`Step ${s.id} depends on missing step ${dep}`);
      }
    }

    // Kahn cycle detection
    const indegree = new Map();
    const adj = new Map();
    for (const s of steps) {
      indegree.set(s.id, 0);
      adj.set(s.id, []);
    }
    for (const s of steps) {
      for (const dep of s.dependsOn || []) {
        indegree.set(s.id, (indegree.get(s.id) || 0) + 1);
        adj.get(dep)?.push(s.id);
      }
    }

    const queue = [];
    for (const [id, deg] of indegree.entries()) if (deg === 0) queue.push(id);

    let visited = 0;
    while (queue.length) {
      const id = queue.shift();
      visited += 1;
      for (const nxt of adj.get(id) || []) {
        indegree.set(nxt, indegree.get(nxt) - 1);
        if (indegree.get(nxt) === 0) queue.push(nxt);
      }
    }

    if (visited !== steps.length) errors.push("Circular dependency detected in steps");
    return { valid: errors.length === 0, errors };
  }

  _buildLevels(steps) {
    const indegree = new Map();
    const adj = new Map();
    const byId = new Map(steps.map((s) => [s.id, s]));

    for (const s of steps) {
      indegree.set(s.id, 0);
      adj.set(s.id, []);
    }
    for (const s of steps) {
      for (const dep of s.dependsOn || []) {
        indegree.set(s.id, (indegree.get(s.id) || 0) + 1);
        adj.get(dep)?.push(s.id);
      }
    }

    const ready = [];
    for (const [id, deg] of indegree.entries()) if (deg === 0) ready.push(id);

    const levels = [];
    let processed = 0;

    while (ready.length) {
      const levelIds = ready.splice(0, ready.length);
      processed += levelIds.length;
      levels.push(levelIds.map((id) => byId.get(id)).filter(Boolean));

      for (const id of levelIds) {
        for (const nxt of adj.get(id) || []) {
          indegree.set(nxt, indegree.get(nxt) - 1);
          if (indegree.get(nxt) === 0) ready.push(nxt);
        }
      }
    }

    return processed === steps.length ? levels : [steps];
  }

  async _executeDag({ steps, entityId, userId, plan, options, onProgress = null, initialStepResults = {} }) {
    const validation = this._validateDag(steps);
    if (!validation.valid) {
      const msg = `Invalid execution DAG: ${validation.errors.join("; ")}`;
      return { success: false, results: [], stepResults: {}, summary: msg, error: msg };
    }

    const levels = this._buildLevels(steps);

    // Fix 11: start with resumed results
    const stepResults = { ...initialStepResults };
    const results = Object.values(initialStepResults || {});

    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      const level = levels[levelIdx];

      // Skip already completed steps (resume)
      const pending = level.filter((s) => !stepResults[s.id]);
      if (pending.length === 0) continue;

      // Fix 5: level start
      this._emitProgress(onProgress, {
        type: "level_start",
        levelIndex: levelIdx + 1,
        totalLevels: levels.length,
        stepsInLevel: pending.map((s) => s.id),
        completedSteps: results.filter((r) => r.success).length,
        totalSteps: steps.length,
        percentage: Math.round((results.length / Math.max(1, steps.length)) * 100),
      });

      const levelResults = await this._executeLevel(pending, stepResults, entityId, userId, plan, options);

      for (const r of levelResults) {
        stepResults[r.stepId] = r;
        results.push(r);

        // Fix 5: step complete
        this._emitProgress(onProgress, {
          type: "step_complete",
          stepId: r.stepId,
          action: r.action,
          success: r.success,
          status: r.status,
          error: r.error || null,
          duration: r.duration,
          completedSteps: results.filter((x) => x.success).length,
          totalSteps: steps.length,
          percentage: Math.round((results.length / Math.max(1, steps.length)) * 100),
        });
      }
    }

    const hardFailures = results.filter((r) => !r.success && !r.optional && r.status !== "skipped" && r.status !== "policy_blocked");
    const success = hardFailures.length === 0;
    const okCount = results.filter((r) => r.success).length;
    const summary = `Executed ${okCount}/${results.length} steps`;

    return { success, results, stepResults, summary };
  }

  // Fix 4: per-provider concurrency + rate limit waiting
  async _executeLevel(levelSteps, previousResults, entityId, userId, plan, options) {
    // Preserve existing semantics:
    // - parallelGroup steps run concurrently within group
    // - groups execute in insertion order (important for toolchain sequences)
    // - non-group steps execute sequentially
    const groups = new Map();
    const sequential = [];

    for (const s of levelSteps) {
      if (s.parallelGroup) {
        if (!groups.has(s.parallelGroup)) groups.set(s.parallelGroup, []);
        groups.get(s.parallelGroup).push(s);
      } else {
        sequential.push(s);
      }
    }

    const runStep = async (step) => {
      const provider = this._inferProvider(step.action);

      // Wait for any rate limit
      await this._waitForProviderRateLimit(provider);

      // Acquire global + provider semaphores
      await this.globalSemaphore.acquire();
      const providerSem = this._getProviderSemaphore(provider);
      await providerSem.acquire();

      try {
        return await this._executeStepResolved(step, previousResults, entityId, userId, plan, options);
      } finally {
        providerSem.release();
        this.globalSemaphore.release();
      }
    };

    const out = [];

    for (const group of groups.values()) {
      const groupResults = await Promise.all(group.map(runStep));
      out.push(...groupResults);
    }

    for (const step of sequential) {
      out.push(await runStep(step));
    }

    return out;
  }

  // Fix 7: actually use the policy engine (Option A)
  async _executeStepResolved(step, previousResults, entityId, userId, plan, options) {
    if (this.policyEngine && typeof this.policyEngine.evaluate === "function") {
      const tier =
        (typeof this.sideEffectGateway.getTier === "function" ? this.sideEffectGateway.getTier(step.action) : null) ||
        "WRITE";

      const policyResult = this.policyEngine.evaluate({
        action: step.action,
        params: step.params,
        tier,
        context: {
          userId: userId || entityId,
          planId: plan?.id,
          phase: this.currentPhase,
        },
      });

      if (policyResult?.blocked) {
        return {
          stepId: step.id,
          type: step.type,
          action: step.action,
          success: false,
          status: "policy_blocked",
          error: policyResult.reason || "Blocked by execution policy",
          policyViolation: policyResult,
          duration: 0,
        };
      }
    }

    // Dependency check
    const deps = step.dependsOn || [];
    const depFailures = deps.map((id) => previousResults[id]).filter((r) => r && !r.success);
    if (depFailures.length > 0) {
      return {
        stepId: step.id,
        type: step.type,
        action: step.action,
        success: false,
        status: "skipped",
        error: `Skipped due to failed dependency: ${depFailures[0].stepId || depFailures[0].action}`,
        duration: 0,
      };
    }

    return this._executeStepWithRetry(step, previousResults, entityId, userId, plan, options);
  }

  async _executeStepWithRetry(step, previousResults, entityId, userId, plan, options) {
    const maxRetries = step.retryConfig?.maxRetries ?? this.config.defaultMaxRetries;
    const baseBackoff = step.retryConfig?.backoffMs ?? this.config.defaultBackoffMs;
    const timeoutMs = step.timeoutMs ?? this.config.defaultTimeoutMs;

    let last = null;
    let lastErr = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await withTimeout(
          this._executeStep({ ...step, retryAttempt: attempt }, previousResults, entityId, userId, plan),
          timeoutMs,
          `${step.action || step.id}`
        );
        last = res;

        if (res.success) return res;

        if (res._normalized?.retry?.should_retry === false) return res;

        if (attempt < maxRetries) {
          const delay = res._retryInfo?.delay_ms ?? baseBackoff * Math.pow(2, attempt);
          await sleep(delay);
        }
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) {
          await sleep(baseBackoff * Math.pow(2, attempt));
          continue;
        }
      }
    }

    return (
      last || {
        stepId: step.id,
        type: step.type,
        action: step.action,
        success: false,
        status: "failed",
        error: lastErr ? lastErr.message : "Unknown failure",
      }
    );
  }

  async _executeStep(step, previousResults, entityId, userId, plan) {
    const startedAt = Date.now();
    const base = {
      stepId: step.id,
      type: step.type,
      action: step.action,
      success: false,
      status: "running",
      startTime: startedAt,
    };

    try {
      if (step.type === "transform") {
        if (!this.callGemini) throw new Error("callGemini not configured for transform steps");
        const data = await this._executeTransformStep(step, previousResults, plan);
        return { ...base, success: true, status: "success", data, endTime: Date.now(), duration: Date.now() - startedAt };
      }

      if (step.type === "llm") {
        if (!this.callGemini) throw new Error("callGemini not configured for llm steps");
        const data = await this._executeLLMStep(step, previousResults);
        return { ...base, success: true, status: "success", data, endTime: Date.now(), duration: Date.now() - startedAt };
      }

      const toolResult = await this._executeToolStep(step, previousResults, entityId, userId, plan);
      const ok = isToolSuccess(toolResult);

      const endTime = Date.now();
      const out = { ...base, success: ok, status: ok ? "success" : "failed", data: toolResult, endTime, duration: endTime - startedAt };
      if (!ok) out.error = getToolError(toolResult) || "Tool returned unsuccessful result";

      // Provide deterministic summary for chaining and debugging.
      const payload = unwrapToolPayload(toolResult);
      out.formattedOutput = formatTypedInjection({
        data: payload,
        sourceAction: step.action,
        targetAction: step.action,
        targetParam: "output",
        limits: { maxChars: Math.min(2400, this.config.injectionMaxChars) },
      });

      return out;
    } catch (err) {
      const endTime = Date.now();
      return { ...base, success: false, status: "failed", error: err.message, endTime, duration: endTime - startedAt };
    }
  }

  // ---------------------------------------------------------------------------
  // Tool execution (Composio + Frappe) with side-effect gating and idempotency
  // ---------------------------------------------------------------------------

  isFrappeAction(actionName) {
    return !!actionName && (String(actionName).startsWith("FRAPPE_") || FRAPPE_ACTION_NAMES.includes(actionName));
  }

  isSystemAction(actionName) {
    return !!actionName && String(actionName).startsWith("SYSTEM_");
  }

  async _executeToolStep(step, previousResults, entityId, userId, plan = {}) {
    const actionName = ActionRegistry.resolveAction(step.action);
    const phaseToUse = step.phase || this.currentPhase;

    // 1) Side-effect gateway enforcement
    const sideEffectCheck = this.sideEffectGateway.check(actionName, phaseToUse, step.params || {});
    if (!sideEffectCheck.allowed) {
      return {
        successful: false,
        error: sideEffectCheck.reason,
        blocked_by_gateway: true,
        phase: phaseToUse,
        tier: sideEffectCheck.tier,
        side_effects: sideEffectCheck.sideEffects,
        alternative: sideEffectCheck.alternative,
      };
    }

    // 2) Params: sanitized + typed injection + transform merge + normalization
    let finalParams = { ...(sideEffectCheck.sanitizedParams || step.params || {}) };

    if (step.injectFrom && typeof step.injectFrom === "object") {
      finalParams = this._applyInjectFromMapping({
        params: finalParams,
        injectFrom: step.injectFrom,
        previousResults,
        targetAction: actionName,
      });
    }

    if (containsValueDeep(finalParams, this.config.injectSentinel)) {
      finalParams = this._applySentinelInjection({ params: finalParams, previousResults, step, targetAction: actionName });
    }

    if (step.useTransformedData) {
      const transformResult = Object.values(previousResults).find((r) => r?.type === "transform" || r?.type === "llm");
      if (transformResult?.data && typeof transformResult.data === "object") {
        finalParams = { ...finalParams, ...transformResult.data };
      }
      if (finalParams.transformedData) {
        const td = finalParams.transformedData;
        if (td && typeof td === "object" && !Array.isArray(td)) finalParams = { ...finalParams, ...td };
        delete finalParams.transformedData;
      }
    }

    finalParams = normalizeParams(finalParams);

    // 3) Idempotency (Fix 3: atomic check-and-acquire)
    const requestId = step.idempotencyKey || step.requestId || `req_${Date.now()}_${uuidv4().slice(0, 8)}`;

    const idempotencyCheck = await this.idempotencyGateway.checkAndAcquire(
      requestId,
      actionName,
      finalParams,
      { userId: userId || entityId, sessionId: step.sessionId }
    );

    if (!idempotencyCheck.canProceed) {
      if (idempotencyCheck.cachedResult) {
        return { ...idempotencyCheck.cachedResult, _cached: true, _cacheReason: idempotencyCheck.blocked_by };
      }
      return {
        successful: false,
        error: idempotencyCheck.reason,
        blocked_by_idempotency: true,
        blocked_by: idempotencyCheck.blocked_by,
        semanticKey: idempotencyCheck.semanticKey,
        existingRequestId: idempotencyCheck.originalRequestId,
        existingResourceId: idempotencyCheck.existingResourceId,
      };
    }
    // No markInProgress needed; checkAndAcquire did it atomically

    // 4) Execute
    let rawResult;
    try {
      if (this.isSystemAction(actionName)) {
        const data = await this._executeSystemAction(actionName, finalParams, {
          entityId,
          userId,
          organizationId: plan.organizationId,
        });
        rawResult = { successful: true, data, error: null };
      } else if (this.isFrappeAction(actionName)) {
        // Use per-user FrappeClient if userId available, else fall back to legacy service
        console.log(`[ExecutorV2] Frappe action: ${actionName}, userId: ${userId}, entityId: ${entityId}`);
        let frappe;
        if (userId) {
          // Lazy-load to avoid circular dependency
          const { executeFrappeAction } = require('../integrations/frappe');
          console.log(`[ExecutorV2] Calling executeFrappeAction with userId: ${userId}`);
          frappe = await executeFrappeAction(userId, actionName, finalParams);
        } else if (this.frappeService) {
          frappe = await this.frappeService.execute({
            actionName,
            params: finalParams,
            idempotencyKey: step.idempotencyKey,
          });
        } else {
          throw new Error('No Frappe connection configured. Please connect your ERPNext instance.');
        }
        rawResult = {
          successful: !!frappe.success,
          data: frappe.data ?? frappe,
          error: frappe.success ? null : frappe.error || frappe.message || "Frappe action failed",
        };
      } else {
        const exec = step.provider === 'direct' && this.connectorService
          ? await this.connectorService.executeAction({
            actionName,
            params: finalParams,
            entityId,
            userId,
            organizationId: plan.organizationId,
            preferredProvider: 'direct',
          })
          : this.connectorService
            ? await this.connectorService.executeAction({
              actionName,
              params: finalParams,
              entityId,
              userId,
              organizationId: plan.organizationId,
            })
            : await this._executeComposioAction(actionName, finalParams, entityId);
        rawResult = { successful: !!exec.success, data: exec.data, error: exec.error };
      }
    } catch (err) {
      rawResult = { successful: false, data: null, error: err.message };
    }

    // 5) Normalize result
    const normalized = this.resultNormalizer.normalize(actionName, rawResult, finalParams, { attempt: step.retryAttempt || 0 });
    const enriched = {
      ...rawResult,
      _normalized: normalized,
      _userMessage: normalized.messages?.user || null,
      _debugMessage: normalized.messages?.debug || null,
      _retryInfo: normalized.retry || null,
    };

    // Fix 4: provider rate limit tracking on 429-ish errors
    if (enriched?.error) {
      const errorMsg = String(enriched.error).toLowerCase();
      if (errorMsg.includes("rate limit") || errorMsg.includes("429") || errorMsg.includes("too many")) {
        const retryAfter = this._extractRetryAfter(enriched) || 2000;
        this._setProviderRateLimit(this._inferProvider(actionName), retryAfter);
      }
    }

    if (isToolSuccess(rawResult)) this.idempotencyGateway.markCompleted(requestId, enriched);
    else this.idempotencyGateway.markFailed(requestId, enriched);

    return enriched;
  }

  _sanitizeSecrets(value) {
    const redacted = "[REDACTED]";
    const sensitiveKey = (k) =>
      /token|secret|password|api[_-]?key|refresh|access[_-]?token|client[_-]?(id|secret)/i.test(String(k || ""));

    if (Array.isArray(value)) return value.map((v) => this._sanitizeSecrets(v));
    if (!value || typeof value !== "object") return value;

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sensitiveKey(k) ? redacted : this._sanitizeSecrets(v);
    }
    return out;
  }

  _candidateAppIdsForToolkit(toolkit) {
    const tk = String(toolkit || "").toUpperCase();
    const mapping = {
      GOOGLECALENDAR: ["gcalender", "googlecalendar", "gcalendar"],
      GMAIL: ["gmail"],
      SLACK: ["slack"],
      JIRA: ["jira"],
      GITHUB: ["github"],
      TRELLO: ["trello"],
      ASANA: ["asana"],
      NOTION: ["notion"],
      ZOOM: ["zoom"],
      OUTLOOK: ["outlook"],
    };
    return (mapping[tk] || [tk.toLowerCase()]).map((s) => String(s).toLowerCase());
  }

  async _executeSystemAction(actionName, params, { entityId, userId, organizationId } = {}) {
    if (actionName === "SYSTEM_CHECK_CONNECTIONS") {
      return await this._systemCheckConnections(params, { entityId, userId, organizationId });
    }
    throw new Error(`Unknown system action: ${actionName}`);
  }

  async _systemCheckConnections(params, { entityId, userId: contextUserId, organizationId } = {}) {
    const requestedToolkitsRaw = Array.isArray(params?.toolkits) ? params.toolkits : [];
    const requestedToolkits = [...new Set(requestedToolkitsRaw.map((t) => String(t || "").trim()).filter(Boolean))].map((t) =>
      t.toUpperCase()
    );

    let toolkitsToCheck = [...requestedToolkits];

    const userId = params?.userId ? String(params.userId) : contextUserId ? String(contextUserId) : null;
    const verifyWithComposio = params?.verifyWithComposio !== false;
    const includeAuthUrls = !!params?.includeAuthUrls;

    let dbAccounts = [];
    let dbError = null;
    if (this.query && isValidUUID(userId)) {
      try {
        const res = await this.query(
          `SELECT app_id, composio_connection_id, status, connected_at, metadata
           FROM connected_accounts
           WHERE user_id = $1`,
          [userId]
        );
        dbAccounts = Array.isArray(res?.rows) ? res.rows : [];
      } catch (err) {
        dbError = err.message;
      }
    }

    let composioAccounts = null;
    let composioError = null;
    if (verifyWithComposio) {
      try {
        composioAccounts = await this.composio.listConnectedAccounts([], entityId);
      } catch (err) {
        composioError = err.message;
      }
    }

    const composioConnectedByToolkit = new Set();
    if (composioAccounts?.items && Array.isArray(composioAccounts.items)) {
      for (const item of composioAccounts.items) {
        const tk = (item?.toolkit?.name || item?.toolkit?.slug || item?.appName || item?.app || "").toString().toUpperCase();
        if (tk) composioConnectedByToolkit.add(tk);
      }
    }

    const nativeConnectedByToolkit = new Map();
    if (this.connectorService && organizationId) {
      const nativeCandidates = requestedToolkits.length > 0
        ? requestedToolkits
        : this.connectorService.listCatalog()
          .filter(item => item.providers?.direct?.status === 'available')
          .map(item => item.toolkit);
      for (const toolkit of nativeCandidates) {
        if (!this.connectorService.canExecuteDirect(toolkit) || toolkit === 'FRAPPE') continue;
        try {
          const native = await this.connectorService.getDirectStatus({
            appId: toolkit,
            organizationId,
            userId,
          });
          if (native.connected) nativeConnectedByToolkit.set(toolkit, native);
        } catch (error) {
          console.warn(`[ExecutorV2] Unable to verify native ${toolkit}:`, error.message);
        }
      }
    }

    // "What is connected?" should discover the user's actual apps instead of
    // checking a hard-coded list. Specific requested toolkits remain supported.
    if (toolkitsToCheck.length === 0) {
      toolkitsToCheck = [...new Set([...composioConnectedByToolkit, ...nativeConnectedByToolkit.keys()])];
    }

    let frappeConnected = !!this.frappeService?.isConfigured?.();
    if (!frappeConnected && isValidUUID(userId)) {
      try {
        const { frappeConnectionManager } = require('../integrations/frappe');
        frappeConnected = await frappeConnectionManager.hasActiveConnection(userId);
      } catch (error) {
        console.warn('[ExecutorV2] Unable to verify Frappe connection:', error.message);
      }
    }
    if (frappeConnected && !toolkitsToCheck.includes('FRAPPE')) {
      toolkitsToCheck.push('FRAPPE');
    }

    const connections = {};
    const missing = [];

    for (const toolkit of toolkitsToCheck) {
      if (toolkit === "FRAPPE") {
        const configured = frappeConnected;
        connections.FRAPPE = {
          connected: configured,
          configured,
          baseUrl: this.frappeService?.baseUrl || process.env.FRAPPE_URL || null,
          authMode: this.frappeService?.apiKey ? "token" : this.frappeService?.email ? "session" : "none",
        };
        if (!configured) missing.push("FRAPPE");
        continue;
      }

      const candidateAppIds = this._candidateAppIdsForToolkit(toolkit);
      const dbRow = dbAccounts.find((r) => candidateAppIds.includes(String(r?.app_id || "").toLowerCase()));

      const dbConnected = !!(dbRow && String(dbRow.status || "").toLowerCase() === "active" && dbRow.composio_connection_id);
      const composioConnected = verifyWithComposio ? composioConnectedByToolkit.has(toolkit) : null;
      const nativeConnection = nativeConnectedByToolkit.get(toolkit) || null;

      const connected = verifyWithComposio
        ? !!(dbConnected || composioConnected || nativeConnection)
        : !!(dbConnected || nativeConnection);

      const info = {
        connected,
        toolkit,
        sources: {
          db: dbConnected,
          composio: verifyWithComposio ? composioConnected : null,
          native: !!nativeConnection,
        },
      };
      if (nativeConnection) info.native = this._sanitizeSecrets(nativeConnection);

      if (dbRow) {
        info.db = {
          appId: dbRow.app_id,
          status: dbRow.status,
          connectedAt: dbRow.connected_at || null,
          connectionId: dbRow.composio_connection_id || null,
          metadata: dbRow.metadata ? this._sanitizeSecrets(dbRow.metadata) : null,
        };
      }

      if (!connected && includeAuthUrls) {
        try {
          const init = await this.composio.initiateConnection(toolkit, null, {}, entityId);
          info.authUrl = init?.redirectUrl || null;
        } catch (err) {
          info.authUrlError = err.message;
        }
      }

      connections[toolkit] = info;
      if (!connected) missing.push(toolkit);
    }

    return {
      ok: missing.length === 0,
      checkedAt: new Date().toISOString(),
      entityId: entityId || null,
      userId: isValidUUID(userId) ? userId : null,
      toolkitsChecked: toolkitsToCheck,
      connections,
      missing,
      diagnostics: {
        db: {
          attempted: !!(this.query && isValidUUID(userId)),
          accountCount: dbAccounts.length,
          error: dbError,
        },
        composio: {
          attempted: verifyWithComposio,
          accountCount: composioAccounts?.items?.length ?? null,
          error: composioError,
        },
      },
    };
  }

  // Fix 10: injection path warnings (upgraded)
  _applyInjectFromMapping({ params, injectFrom, previousResults, targetAction }) {
    const out = { ...params };

    for (const [targetParam, sourceSpec] of Object.entries(injectFrom || {})) {
      if (!sourceSpec) continue;
      const spec = String(sourceSpec);
      const [sourceStepId, ...pathParts] = spec.split(".");
      const source = previousResults[sourceStepId];

      if (!source) {
        console.warn(`[ExecutorV2] Injection source step "${sourceStepId}" not found for ${targetParam}`);
        continue;
      }
      if (!source.success) {
        console.warn(`[ExecutorV2] Injection source step "${sourceStepId}" failed, skipping injection for ${targetParam}`);
        continue;
      }

      let payload = unwrapToolPayload(source.data);
      const originalPayload = payload;

      const effectivePath = pathParts.length > 0 && pathParts[0] === "result" ? pathParts.slice(1) : pathParts;

      for (const p of effectivePath) {
        if (!payload || typeof payload !== "object") {
          console.warn(
            `[ExecutorV2] Injection path "${spec}" failed at "${p}" - payload is ${payload === null ? "null" : typeof payload}`
          );
          payload = undefined;
          break;
        }
        payload = payload[p];
      }

      if (payload === undefined) {
        console.warn(
          `[ExecutorV2] Injection "${spec}" -> "${targetParam}" resulted in undefined. Available keys: ${originalPayload && typeof originalPayload === "object" ? Object.keys(originalPayload).join(", ") : "(none)"
          }`
        );
        continue;
      }

      out[targetParam] = formatTypedInjection({
        data: payload,
        sourceAction: source.action,
        targetAction,
        targetParam,
        limits: { maxChars: this.config.injectionMaxChars },
      });
    }

    return out;
  }

  _applySentinelInjection({ params, previousResults, step, targetAction }) {
    const deps = step.dependsOn || [];
    const sourceStep =
      deps.slice().reverse().map((id) => previousResults[id]).find((r) => r && r.success) ||
      Object.values(previousResults).slice().reverse().find((r) => r && r.success);

    if (!sourceStep) {
      return mapObjectDeep(params, (v) => (v === this.config.injectSentinel ? "" : v));
    }

    const sourcePayload = unwrapToolPayload(sourceStep.data);
    return mapObjectDeep(params, (v, path) => {
      if (v !== this.config.injectSentinel) return v;
      const targetParam = path[path.length - 1] || "content";
      return formatTypedInjection({
        data: sourcePayload,
        sourceAction: sourceStep.action,
        targetAction,
        targetParam,
        limits: { maxChars: this.config.injectionMaxChars },
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Transform / LLM steps (optional)
  // ---------------------------------------------------------------------------

  async _executeTransformStep(step, previousResults, plan) {
    const dependentData = (step.dependsOn || []).map((id) => previousResults[id]?.data).filter(Boolean);
    if (dependentData.length === 0) throw new Error("No data to transform");

    const transformGuidance =
      step.transformInstructions ||
      `Transform the data for the next action:
- Calendar descriptions: agenda-style
- Slack: concise markdown
- Email: professional body + short subject
- Otherwise: a compact summary`;

    const systemPrompt = `You are a data transformer. Transform the following data for use in a ${step.outputFormat?.type || "tool"}.

Input data (from previous steps):
${JSON.stringify(dependentData, null, 2)}

Intent: ${step.intent || plan?.intent || "Transform this data"}
Output format: ${step.outputFormat?.type || "object"}
Required fields: ${(step.outputFormat?.fields || []).join(", ") || "appropriate fields"}
Operation: ${step.operation || "merge_and_format"}

${transformGuidance}

Respond with ONLY a JSON object.`;

    const response = await this.callGemini(systemPrompt, "", 0.3);
    let jsonStr = response;

    // Fix 1: regex escape error
    const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) jsonStr = fenced[1].trim();

    // Fix 9: better error logging
    try {
      return JSON.parse(jsonStr);
    } catch (parseErr) {
      console.warn(
        "[ExecutorV2] Transform step JSON parse failed:",
        parseErr.message,
        "\nRaw response (first 500 chars):",
        String(jsonStr).slice(0, 500)
      );
      return {
        description: response,
        message: response,
        body: response,
        _parseError: parseErr.message,
        _rawResponse: String(response).slice(0, 1000),
      };
    }
  }

  async _executeLLMStep(step, previousResults) {
    const ctxIds = Array.isArray(step.contextFromSteps) ? step.contextFromSteps : [];
    let context = "";
    for (const id of ctxIds) if (previousResults[id]?.data) context += JSON.stringify(previousResults[id].data) + "\n";

    const prompt = step.prompt || step.systemPrompt || "";
    const response = await this.callGemini(prompt, context, 0.3);
    return { response };
  }

  // ---------------------------------------------------------------------------
  // Optional DB persistence hooks (best effort)
  // ---------------------------------------------------------------------------

  async _storePlanSafe(plan, userId, conversationId) {
    if (!this.query) return;
    try {
      await this.query(
        `INSERT INTO execution_plans (id, user_id, conversation_id, plan_type, template, steps, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'running')
         ON CONFLICT (id) DO NOTHING`,
        [plan.id, userId || null, conversationId || null, plan.type || null, plan.template || "DAG", JSON.stringify(plan.steps || [])]
      );
    } catch (err) {
      console.warn("[ExecutorV2] storePlan skipped:", err.message);
    }
  }

  async _updatePlanStatusSafe(planId, status, results) {
    if (!this.query || !planId) return;
    try {
      await this.query(
        `UPDATE execution_plans
         SET status = $1, step_results = $2, completed_at = NOW()
         WHERE id = $3`,
        [status, JSON.stringify(results), planId]
      );
    } catch (err) {
      console.warn("[ExecutorV2] updatePlanStatus skipped:", err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Fix 8: cleanup + stats
  // ---------------------------------------------------------------------------

  /**
   * Cleanup resources - call when shutting down
   */
  destroy() {
    if (this.idempotencyGateway?.clear) {
      this.idempotencyGateway.clear();
    }
    if (this._providerSemaphores) this._providerSemaphores.clear();
    if (this._providerRateLimitUntil) this._providerRateLimitUntil.clear();
    console.log("[ExecutorV2] Resources cleaned up");
  }

  /**
   * Get current execution stats for monitoring
   */
  getStats() {
    return {
      idempotency: this.idempotencyGateway?.getStats?.() || {},
      globalConcurrency: {
        max: this.globalSemaphore?.max || 0,
        current: this.globalSemaphore?.current || 0,
        queued: this.globalSemaphore?.queue?.length || 0,
      },
      providerConcurrency: Object.fromEntries(
        Array.from(this._providerSemaphores?.entries() || []).map(([p, sem]) => [
          p,
          { max: sem.max, current: sem.current, queued: sem.queue?.length || 0 },
        ])
      ),
      providerRateLimits: Object.fromEntries(
        Array.from(this._providerRateLimitUntil?.entries() || []).map(([p, until]) => [
          p,
          { blockedUntil: until, remainingMs: Math.max(0, until - Date.now()) },
        ])
      ),
    };
  }
}

module.exports = {
  ExecutorV2,
  // Export the same constants as the legacy executor for compatibility.
  EXECUTION_PHASES,
  SIDE_EFFECT_TIERS,
  EXECUTION_STATES,
  EXECUTION_POLICIES,
  STEP_STATUS,
  CHECKPOINT_ACTIONS,
  NORMALIZED_STATUS,
};
