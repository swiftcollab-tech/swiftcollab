// AssistantOrchestrator.js
const AssistantComposer = require("./AssistantComposer");
const {
  interpretConfirmationResponseWithLLM,
  interpretConfirmationResponseSimple,
  filterToolsByIntent
} = require("./core/ConfirmationInterpreter");
const { classifyToolIntent } = require('./core/ToolIntentGate');

/**
 * AssistantOrchestrator (Redis-backed, drop-in)
 *
 * One entrypoint that coordinates:
 *  - ToolRouter (select tools + initial params)
 *  - UnifiedSlotFiller (dynamic schema-based slot filling, multi-tool chains)
 *  - ExecutorV2 (DAG/toolchain execution, retries, idempotency, side-effect policy)
 *
 * ✅ Redis session persistence (no in-memory Map)
 * ✅ Timezone passthrough (userTimeZone)
 * ✅ Progress publishing via Redis PubSub (safe across processes)
 * ✅ Side-effect confirmation gate BEFORE execution
 * ✅ Optional resume support ONLY if executor supports it
 * ✅ Session locking to avoid double-runs from concurrent requests
 *
 * Expected usage:
 * const orchestrator = new AssistantOrchestrator({
 *   toolRouter, slotFiller, executor, redis
 * });
 *
 * const out = await orchestrator.handleTurn({
 *   sessionId,
 *   message,
 *   enabledToolkits,
 *   context: { userId, entityId, conversationId, conversationHistory, userTimeZone },
 *   progressChannel: `orchestrator:progress:${sessionId}`, // optional
 *   resumeToken: null, // optional
 * });
 */

const crypto = require("crypto");

class AssistantOrchestrator {
  // -------------------------
  // Defaults
  // -------------------------
  static DEFAULTS = {
    userTimeZone: "America/New_York",

    // Safety guards
    maxSelectedTools: 50, // router output guard (natural language shouldn't spawn 50 tools)
    maxExecutionSteps: 200,

    // Confirmation for side-effects
    requireConfirmationForWrites: true,
    confirmationStyle: "short", // "short" | "detailed"

    // Redis keys
    redisKeyPrefix: "orchestrator:sess:",
    redisLockPrefix: "orchestrator:lock:",

    // Locking
    lockTtlMs: 8000,

    // Session TTL (optional). If null, session persists until deleted.
    sessionTtlSeconds: 60 * 60 * 24 * 7, // 7 days
  };

  constructor({ toolRouter, slotFiller, executor, redis, callGemini = null, options = {} }) {
    if (!toolRouter) throw new Error("toolRouter required");
    if (!slotFiller) throw new Error("slotFiller required");
    if (!executor) throw new Error("executor required");
    if (!redis) throw new Error("redis client required");

    this.toolRouter = toolRouter;
    this.slotFiller = slotFiller;
    this.executor = executor;
    this.redis = redis;
    this.callGemini = callGemini;
    this.composer = new AssistantComposer({ callGemini });

    this.config = { ...AssistantOrchestrator.DEFAULTS, ...options };
  }

  // -------------------------
  // Public API
  // -------------------------
  async handleTurn({
    sessionId,
    message,
    enabledToolkits = [],
    context = {},
    progressChannel = null,
    resumeToken = null,
  }) {
    if (!sessionId) throw new Error("sessionId required");

    const userText = String(message ?? "").trim();

    const enrichedContext = {
      ...context,
      userTimeZone:
        context.userTimeZone ||
        context.userTimezone ||
        context.timezone ||
        this.config.userTimeZone ||
        "America/New_York",
    };

    const sessKey = this._sessKey(sessionId);
    const lockKey = this._lockKey(sessionId);

    return await this._withSessionLock(lockKey, async () => {
      let sess = await this._getOrCreateSession(sessKey, sessionId);

      // Always update timestamps + store progressChannel string (safe in Redis)
      sess.updatedAt = Date.now();
      sess.progressChannel = progressChannel || sess.progressChannel || this._defaultProgressChannel(sessionId);

      // 0) Resume support (ONLY if executor supports it and caller provided a resumeToken)
      // NOTE: Resume should be used when you have durable execution (Temporal or persisted plan state).
      if (resumeToken?.planId) {
        if (!this._executorSupportsResume()) {
          sess.mode = "IDLE";
          sess.lastAction = "RESUME_UNSUPPORTED";
          await this._saveSession(sessKey, sess);
          return {
            type: "error",
            sessionId,
            reply: "Resume is not supported by the current executor (requires durable execution).",
          };
        }

        const onProgress = this._makeProgressPublisher(sess, enrichedContext.onProgress);
        const result = await this.executor.execute({
          plan: resumeToken.plan,
          entityId: enrichedContext.entityId,
          userId: enrichedContext.userId,
          conversationId: enrichedContext.conversationId,
          resumeFrom: resumeToken,
          onProgress,
          options: { userTimeZone: enrichedContext.userTimeZone },
        });

        sess.mode = "IDLE";
        sess.lastAction = "RESUMED";
        await this._endSlotSessionIfAny(sess);
        await this._saveSession(sessKey, sess);

        return {
          type: "execution_result",
          sessionId,
          result,
          reply: await this._formatExecutionSummary(result),
          isResume: true,
        };
      }

      // 1) If waiting for execution confirmation
      if (sess.mode === "CONFIRM_EXECUTION" && sess.pendingExecution) {
        const out = await this._handleExecutionConfirmation(sess, userText, enrichedContext);
        await this._saveSession(sessKey, sess);
        return out;
      }

      // 2) If in slot filling flow (follow-up answers)
      if (sess.mode === "SLOT_FILL" && sess.slotSessionId) {
        const sfRes = await this.slotFiller.process(sess.slotSessionId, userText);
        const out = await this._handleSlotFillerResult(sess, sfRes, enrichedContext);
        await this._saveSession(sessKey, sess);
        return out;
      }

      // 3) Fresh message → route
      const intent = classifyToolIntent(
        userText,
        enabledToolkits,
        enrichedContext.conversationHistory || []
      );
      if (!intent.requiresTools) {
        const reply = intent.immediateReply || await this.composer.composeChat({
          message: userText,
          conversationHistory: enrichedContext.conversationHistory || [],
        });

        sess.mode = "IDLE";
        sess.lastAction = "CHAT_FAST_PATH";
        await this._endSlotSessionIfAny(sess);
        await this._saveSession(sessKey, sess);

        return {
          type: "chat",
          sessionId,
          reply,
          debug: { route: 'fast_chat', reason: intent.reason },
        };
      }

      const routing = await this.toolRouter.route(userText, enabledToolkits, enrichedContext);

      // Inject safe defaults for SYSTEM_* tools (so they can use app/toolkit context)
      this._injectSystemToolDefaults(routing, enabledToolkits, enrichedContext);

      // Router says chat
      const firstTool = routing?.tools?.[0]?.name;
      if (firstTool === "chat_response" && (routing?.tools?.length || 0) === 1) {
        sess.mode = "IDLE";
        sess.lastAction = "CHAT";
        await this._endSlotSessionIfAny(sess);
        await this._saveSession(sessKey, sess);

        return {
          type: "chat",
          sessionId,
          reply: routing.chatResponse || "How can I help?",
          debug: { routedTools: ["chat_response"] },
        };
      }

      // Guard: don’t let a single message explode into too many tools
      const routedTools = Array.isArray(routing?.tools) ? routing.tools : [];
      if (routedTools.length > this.config.maxSelectedTools) {
        sess.mode = "IDLE";
        sess.lastAction = "TOO_MANY_TOOLS";
        await this._endSlotSessionIfAny(sess);
        await this._saveSession(sessKey, sess);

        return {
          type: "error",
          sessionId,
          reply:
            `That request expands into ${routedTools.length} tool actions, which is unusually large for one prompt.\n` +
            `If you truly want a 50–100 step workflow, send it as an explicit plan/toolchain (or trigger your PlanBuilder mode).`,
          debug: { routedTools: routedTools.map((t) => t.name).slice(0, 30) },
        };
      }

      // 4) Start slot filling using router output
      const slotSessionId = `sf_${sessionId}_${Date.now()}`;
      await this.slotFiller.startSession(slotSessionId, routing, {
        ...enrichedContext,
        originalMessage: userText,
        message: userText,
      });

      sess.slotSessionId = slotSessionId;
      sess.mode = "SLOT_FILL";
      sess.lastAction = "SLOT_FILL_STARTED";

      const sfRes = await this.slotFiller.process(slotSessionId);
      const out = await this._handleSlotFillerResult(sess, sfRes, enrichedContext);

      await this._saveSession(sessKey, sess);
      return out;
    });
  }

  /**
   * Optional: if you already have a 50–100 step plan (PlanBuilder) and want to execute it
   */
  async executePlan({ sessionId, plan, context = {}, options = {}, onProgressChannel = null }) {
    if (!sessionId) throw new Error("sessionId required");
    if (!plan) throw new Error("plan required");

    const sessKey = this._sessKey(sessionId);
    const lockKey = this._lockKey(sessionId);

    const enrichedContext = {
      ...context,
      userTimeZone:
        context.userTimeZone ||
        context.userTimezone ||
        context.timezone ||
        this.config.userTimeZone ||
        "America/New_York",
    };

    return await this._withSessionLock(lockKey, async () => {
      const sess = await this._getOrCreateSession(sessKey, sessionId);
      sess.updatedAt = Date.now();
      sess.progressChannel = onProgressChannel || sess.progressChannel || this._defaultProgressChannel(sessionId);

      const stepCount = Array.isArray(plan.steps) ? plan.steps.length : 0;
      if (stepCount > this.config.maxExecutionSteps) {
        sess.mode = "IDLE";
        sess.lastAction = "PLAN_TOO_LARGE";
        await this._saveSession(sessKey, sess);

        return {
          type: "error",
          sessionId,
          reply: `Plan has ${stepCount} steps, which exceeds maxExecutionSteps=${this.config.maxExecutionSteps}.`,
        };
      }

      const onProgress = this._makeProgressPublisher(sess);

      const result = await this.executor.execute({
        plan,
        userId: enrichedContext.userId,
        entityId: enrichedContext.entityId,
        conversationId: enrichedContext.conversationId,
        options: { ...options, userTimeZone: enrichedContext.userTimeZone },
        onProgress,
      });

      sess.mode = "IDLE";
      sess.lastAction = "PLAN_EXECUTED";
      await this._saveSession(sessKey, sess);

      return { type: "execution_result", sessionId, result, reply: await this._formatExecutionSummary(result) };
    });
  }

  /**
   * Backwards-compatible processPrompt wrapper
   * Maps old API to new handleTurn
   */
  async processPrompt({
    message,
    userId,
    entityId,
    organizationId = null,
    conversationId = null,
    selectedToolkits = [],
    followupContext = null,
    answers = [],
    conversationHistory = [],
    onProgress = null,
  }) {
    // The conversation is the durable orchestration boundary. Reusing its ID
    // preserves slot-filling and confirmation state even if the browser loses
    // the optional followupContext object between turns.
    const sessionId = conversationId
      ? `sess_${entityId}_${conversationId}`
      : `sess_${entityId}_${Date.now()}`;

    // If we have followupContext with a sessionId, use that for continuity
    const effectiveSessionId = followupContext?.sessionId || sessionId;

    // Handle old-style answers array by converting to message
    let effectiveMessage = message;
    if (answers && answers.length > 0 && !message) {
      effectiveMessage = answers.map((a) => `${a.field}: ${a.value}`).join(", ");
    }

    try {
      const result = await this.handleTurn({
        sessionId: effectiveSessionId,
        message: effectiveMessage,
        enabledToolkits: selectedToolkits,
        context: {
          userId,
          entityId,
          organizationId,
          conversationId,
          conversationHistory,
          userTimeZone: followupContext?.userTimeZone || "America/New_York",
          onProgress,
        },
        resumeToken: followupContext?.resumeToken || null,
      });

      // Map new result format to old expected format
      return this._mapResultToLegacyFormat(result, effectiveSessionId);
    } catch (err) {
      console.error("[AssistantOrchestrator] processPrompt error:", err);
      return {
        type: "error",
        message: err.message || "An error occurred",
        sessionId: effectiveSessionId,
      };
    }
  }

  _mapResultToLegacyFormat(result, sessionId) {
    if (!result) {
      return { type: "error", message: "No result", sessionId };
    }

    switch (result.type) {
      case "chat":
        return {
          type: "chat",
          message: result.reply,
          sessionId,
        };

      case "question":
        return {
          type: "needs_info",
          message: result.reply,
          followupContext: {
            sessionId,
            pendingFields: result.ui?.pendingFields || [],
            progress: result.ui?.progress || null,
          },
          suggestions: result.ui?.suggestions || null,
        };

      case "confirm":
        return {
          type: "confirmation_required",
          message: result.reply,
          followupContext: {
            sessionId,
            confirmationType: result.ui?.kind || "confirm",
            // CRITICAL: Include pendingFields so frontend preserves session context
            // The frontend checks for pendingFields to decide whether to store followupContext
            pendingFields: [{ field: "_confirmation", type: "boolean", required: true }],
          },
        };
      case "execution_result":
        const success = result.result?.success !== false;
        return {
          type: success ? "success" : "partial_success",
          message: result.reply,
          results: result.result?.results || [],
          sessionId,
        };

      case "cancelled":
        return {
          type: "cancelled",
          message: result.reply || "Cancelled",
          sessionId,
        };

      case "error":
        return {
          type: "error",
          message: result.reply || "An error occurred",
          sessionId,
        };

      default:
        return {
          type: result.type || "chat",
          message: result.reply || "Done",
          sessionId,
        };
    }
  }

  /**
   * Get AutomationEngine instance (for backwards compatibility)
   */
  getAutomationEngine() {
    return this._automationEngine || null;
  }

  /**
   * Get ProactiveEngine instance (for backwards compatibility)
   */
  getProactiveEngine() {
    return this._proactiveEngine || null;
  }

  /**
   * Set AutomationEngine (called from server setup)
   */
  setAutomationEngine(engine) {
    this._automationEngine = engine;
  }

  /**
   * Set ProactiveEngine (called from server setup)
   */
  setProactiveEngine(engine) {
    this._proactiveEngine = engine;
  }

  destroy() {
    try {
      // Redis belongs to app lifecycle; only quit if you own it.
      // this.redis?.quit?.();
    } catch (_) { }
    try {
      this.executor?.destroy?.();
    } catch (_) { }
  }

  // -------------------------
  // Internal: SlotFiller result handling
  // -------------------------
  async _handleSlotFillerResult(sess, sfRes, context) {
    const action = sfRes?.action;

    if (action === "ASK_QUESTION") {
      sess.lastAction = "ASK_QUESTION";
      return {
        type: "question",
        sessionId: sess.sessionId,
        reply: sfRes.contextMessage ? `${sfRes.contextMessage}\n\n${sfRes.question}` : sfRes.question,
        ui: {
          kind: "clarification",
          progress: sfRes.progress || null,
          pendingFields: sfRes.pendingFields || [],
          suggestions: sfRes.suggestions || null,
        },
        debug: { state: sfRes.state, missing: sfRes.missingRequired || [] },
      };
    }

    if (action === "CONFIRM_VALUES") {
      sess.lastAction = "CONFIRM_VALUES";
      return {
        type: "confirm",
        sessionId: sess.sessionId,
        reply: sfRes.message || "Can you confirm these values? (yes/no)",
        ui: { kind: "confirm_values", confirmations: sfRes.confirmations || [] },
        debug: { state: sfRes.state },
      };
    }

    if (action === "OFFER_DEFAULTS") {
      sess.lastAction = "OFFER_DEFAULTS";
      return {
        type: "confirm",
        sessionId: sess.sessionId,
        reply: sfRes.message || "I can use defaults for the missing fields. Is that okay? (yes/no)",
        ui: { kind: "offer_defaults", defaults: sfRes.defaults || [] },
        debug: { state: sfRes.state },
      };
    }

    if (action === "CANNOT_COMPLETE") {
      sess.mode = "IDLE";
      sess.lastAction = "CANNOT_COMPLETE";
      await this._endSlotSessionIfAny(sess);

      return {
        type: "error",
        sessionId: sess.sessionId,
        reply: sfRes.message || "I can’t complete that without more required details.",
        ui: { kind: "missing_required", missing: sfRes.missing || [] },
        debug: { state: sfRes.state },
      };
    }

    if (action === "CANCELLED") {
      sess.mode = "IDLE";
      sess.lastAction = "CANCELLED";
      await this._endSlotSessionIfAny(sess);
      return { type: "cancelled", sessionId: sess.sessionId, reply: "Okay, cancelled." };
    }

    if (action === "ERROR") {
      sess.mode = "IDLE";
      sess.lastAction = "ERROR";
      await this._endSlotSessionIfAny(sess);
      return { type: "error", sessionId: sess.sessionId, reply: sfRes.error || "Something went wrong." };
    }

    if (action === "COMPLETE") {
      // Slot filling done → decide whether to ask for execution confirmation
      const tools = sfRes.toolsToExecute || [];
      if (!tools.length) {
        sess.mode = "IDLE";
        sess.lastAction = "COMPLETE_EMPTY";
        await this._endSlotSessionIfAny(sess);
        return { type: "error", sessionId: sess.sessionId, reply: "No executable tools found." };
      }

      // Guard for large toolchains
      if (tools.length > this.config.maxExecutionSteps) {
        sess.mode = "IDLE";
        sess.lastAction = "TOO_MANY_EXEC_STEPS";
        await this._endSlotSessionIfAny(sess);
        return {
          type: "error",
          sessionId: sess.sessionId,
          reply: `This toolchain has ${tools.length} steps, exceeding maxExecutionSteps=${this.config.maxExecutionSteps}.`,
        };
      }

      // Side-effect confirmation gate
      const actionNames = tools.map((t) => t.composio_action).filter(Boolean);
      const needsConfirm =
        !!this.config.requireConfirmationForWrites &&
        actionNames.some((a) => {
          try {
            return !!this.executor.requiresConfirmation(a);
          } catch (_) {
            return false;
          }
        });

      if (needsConfirm) {
        sess.mode = "CONFIRM_EXECUTION";
        sess.pendingExecution = {
          tools,
          meta: {
            summary: sfRes.summary || null,
            actionNames,
            sideEffects: this._safeSideEffectSummary(actionNames),
            originalMessage: context.originalMessage || context.message || null,
          },
        };

        // Generate nice LLM-based confirmation message
        const confirmMsg = await this._generateConfirmationMessage(
          tools,
          sess.pendingExecution.meta,
          context
        );

        return {
          type: "confirm",
          sessionId: sess.sessionId,
          reply: confirmMsg,
          ui: {
            kind: "confirm_execution",
            actions: actionNames,
            sideEffects: sess.pendingExecution.meta.sideEffects,
          },
          debug: { state: sfRes.state },
        };
      }

      // Execute immediately
      return await this._executeToolChainNow(sess, tools, context);
    }

    // Default fallthrough
    return {
      type: "chat",
      sessionId: sess.sessionId,
      reply: "Okay. What would you like to do next?",
      debug: { action, state: sfRes?.state },
    };
  }

  // -------------------------
  // Internal: Confirmation → execute

  // -------------------------
  // Internal: Confirmation -> execute (smart interpretation)
  // -------------------------
  async _handleExecutionConfirmation(sess, userText, context) {
    const simpleYes = this._isYes(userText);
    const simpleNo = this._isNo(userText);

    if (simpleNo) {
      sess.mode = "IDLE";
      sess.lastAction = "EXECUTION_DECLINED";
      sess.pendingExecution = null;
      await this._endSlotSessionIfAny(sess);
      return { type: "cancelled", sessionId: sess.sessionId, reply: "Got it - I won't run those actions." };
    }

    if (simpleYes) {
      const tools = sess.pendingExecution?.tools || [];
      sess.pendingExecution = null;
      return await this._executeToolChainNow(sess, tools, context);
    }

    // Not simple yes/no - use intelligent interpretation
    const interpretation = await this._interpretConfirmationResponse(userText, sess.pendingExecution);

    if (interpretation.intent === "reject") {
      sess.mode = "IDLE";
      sess.lastAction = "EXECUTION_DECLINED";
      sess.pendingExecution = null;
      await this._endSlotSessionIfAny(sess);
      return { type: "cancelled", sessionId: sess.sessionId, reply: "Got it - I won't run those actions." };
    }

    if (interpretation.intent === "approve" || interpretation.intent === "approve_with_updates") {
      if (interpretation.updates && Object.keys(interpretation.updates).length > 0) {
        this._applyUpdatesToTools(sess.pendingExecution?.tools || [], interpretation.updates);
      }
      const tools = sess.pendingExecution?.tools || [];
      sess.pendingExecution = null;
      return await this._executeToolChainNow(sess, tools, context);
    }

    if (interpretation.intent === "clarify") {
      return { type: "confirm", sessionId: sess.sessionId, reply: interpretation.response || "Should I proceed?" };
    }

    return { type: "confirm", sessionId: sess.sessionId, reply: "Should I proceed? (yes/no)" };
  }

  async _interpretConfirmationResponse(userText, pendingExecution) {
    if (!this.callGemini) {
      return this._interpretConfirmationResponseSimple(userText);
    }

    const tools = pendingExecution?.tools || [];
    const actionNames = tools.map(t => t.composio_action || t.name).filter(Boolean);

    const prompt = `Interpret user response to confirmation: "${userText}"
Actions: ${actionNames.join(", ")}
Return JSON: {"intent":"approve|approve_with_updates|reject|clarify","updates":{"attendees":[]},"response":""}
Extract email addresses. "yes with email@test.com" = approval with updates.`;

    try {
      const response = await this.callGemini(prompt, "", 0.2);
      const jsonMatch = String(response || "").match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { intent: parsed.intent || "clarify", updates: parsed.updates || {}, response: parsed.response };
      }
    } catch (err) {
      console.warn("[AssistantOrchestrator] LLM interpretation failed:", err.message);
    }
    return this._interpretConfirmationResponseSimple(userText);
  }

  _interpretConfirmationResponseSimple(userText) {
    const text = String(userText || "").trim().toLowerCase();
    if (/^(no|n|nope|nah|don't|do not|stop|cancel)$/i.test(text)) {
      return { intent: "reject", updates: {} };
    }
    const isApproval = /^(yes|y|yeah|yep|ok|okay|sure|go ahead|do it|run it|confirm|proceed)/i.test(text);
    const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];

    if (isApproval || emails.length > 0) {
      if (emails.length > 0) {
        return { intent: "approve_with_updates", updates: { attendees: emails }, response: `Adding ${emails.join(", ")} and proceeding.` };
      }
      return { intent: "approve", updates: {} };
    }
    return { intent: "clarify", updates: {} };
  }

  _applyUpdatesToTools(tools, updates) {
    if (!tools || !updates) return;
    for (const tool of tools) {
      const action = (tool.composio_action || tool.name || "").toUpperCase();
      if (!tool.params) tool.params = {};
      if (action.includes("CALENDAR") && updates.attendees) {
        const existing = tool.params.attendees || [];
        tool.params.attendees = [...existing, ...updates.attendees.map(e => typeof e === "string" ? { email: e } : e)];
        console.log("[AssistantOrchestrator] Added attendees:", updates.attendees);
      }
      if (action.includes("GMAIL") && action.includes("SEND") && updates.to) {
        const existing = Array.isArray(tool.params.to) ? tool.params.to : (tool.params.to ? [tool.params.to] : []);
        tool.params.to = [...existing, ...updates.to];
      }
    }
  }

  async _executeToolChainNow(sess, tools, context) {
    try {
      const onProgress = this._makeProgressPublisher(sess, context.onProgress);

      const execResult = await this.executor.executeToolChain({
        tools,
        userId: context.userId,
        entityId: context.entityId,
        conversationId: context.conversationId,
        options: {
          // execution_plans.id is a PostgreSQL UUID column.
          planId: crypto.randomUUID(),
          userTimeZone: context.userTimeZone,
          organizationId: context.organizationId,
        },
        onProgress,
      });

      sess.mode = "IDLE";
      sess.lastAction = "EXECUTED";
      await this._endSlotSessionIfAny(sess);

      return {
        type: "execution_result",
        sessionId: sess.sessionId,
        reply: await this._formatExecutionSummary(execResult),
        result: execResult,
      };
    } catch (err) {
      sess.mode = "IDLE";
      sess.lastAction = "EXECUTION_FAILED";
      await this._endSlotSessionIfAny(sess);

      return { type: "error", sessionId: sess.sessionId, reply: `Execution failed: ${err.message}` };
    }
  }

  // -------------------------
  // Internal: Side-effect summaries
  // -------------------------
  _safeSideEffectSummary(actionNames) {
    try {
      return this.executor.getSideEffectSummary(actionNames);
    } catch (_) {
      return null;
    }
  }

  /**
   * Generate a nice, human-friendly confirmation message using LLM
   */
  async _generateConfirmationMessage(tools, meta, context) {
    try {
      const confirmMsg = await this.composer.composeConfirmationMessage({
        originalMessage: meta?.originalMessage || context?.originalMessage || context?.message,
        tools: tools,
        sideEffects: meta?.sideEffects,
        timezone: context?.userTimeZone || this.config.userTimeZone,
      });
      return confirmMsg;
    } catch (err) {
      console.warn('[AssistantOrchestrator] LLM confirmation failed, using fallback:', err.message);
      return this._formatExecutionConfirmMessage(meta);
    }
  }

  _formatExecutionConfirmMessage(meta) {
    const actions = (meta?.actionNames || []).slice(0, 10).join(", ");
    const sideEffects = meta?.sideEffects;

    if (this.config.confirmationStyle === "detailed" && sideEffects) {
      return (
        `This will perform these actions:\n- ${actions}\n\n` +
        `Side effects summary:\n${JSON.stringify(sideEffects, null, 2)}\n\n` +
        `Run it? (yes/no)`
      );
    }

    return `This will run ${meta?.actionNames?.length || 0} actions (including write operations). Run it? (yes/no)`;
  }

  // -------------------------
  // Internal: Execution summary (uses AssistantComposer for user-friendly output)
  // -------------------------
  async _formatExecutionSummary(execResult, timezone = "America/New_York") {
    if (!execResult) return "Done.";

    // Use Composer for user-friendly formatting
    try {
      const composed = await this.composer.composeExecutionDeterministic({
        executionResult: execResult,
        timezone,
      });
      if (composed && typeof composed === 'string' && composed.trim()) {
        return composed;
      }
    } catch (err) {
      console.warn("[AssistantOrchestrator] Composer error, using fallback:", err.message);
    }

    // Fallback to simple format if Composer fails
    const results = Array.isArray(execResult.results) ? execResult.results : [];
    const okCount = results.filter((r) => r && r.success).length;
    const failCount = results.filter((r) => r && !r.success && r.status !== "skipped").length;

    if (okCount === 0 && failCount > 0) {
      const firstError = results.find((r) => !r.success);
      return `❌ ${firstError?.error || "Something went wrong."}`;
    }

    return `✅ Completed (${okCount}/${results.length} actions)`;
  }

  // -------------------------
  // Internal: Redis session storage
  // -------------------------
  _sessKey(sessionId) {
    return `${this.config.redisKeyPrefix}${sessionId}`;
  }

  _lockKey(sessionId) {
    return `${this.config.redisLockPrefix}${sessionId}`;
  }

  _defaultProgressChannel(sessionId) {
    return `orchestrator:progress:${sessionId}`;
  }

  async _getOrCreateSession(sessKey, sessionId) {
    const raw = await this.redis.get(sessKey);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        // minimal shape hardening
        return {
          sessionId,
          mode: parsed.mode || "IDLE",
          slotSessionId: parsed.slotSessionId || null,
          pendingExecution: parsed.pendingExecution || null,
          lastAction: parsed.lastAction || null,
          progressChannel: parsed.progressChannel || this._defaultProgressChannel(sessionId),
          createdAt: parsed.createdAt || Date.now(),
          updatedAt: Date.now(),
        };
      } catch (_) {
        // corrupted session -> reset safely
      }
    }

    return {
      sessionId,
      mode: "IDLE",
      slotSessionId: null,
      pendingExecution: null,
      lastAction: null,
      progressChannel: this._defaultProgressChannel(sessionId),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  async _saveSession(sessKey, sess) {
    const payload = JSON.stringify({
      sessionId: sess.sessionId,
      mode: sess.mode,
      slotSessionId: sess.slotSessionId,
      pendingExecution: sess.pendingExecution,
      lastAction: sess.lastAction,
      progressChannel: sess.progressChannel,
      createdAt: sess.createdAt,
      updatedAt: sess.updatedAt,
    });

    if (this.config.sessionTtlSeconds && Number.isFinite(this.config.sessionTtlSeconds)) {
      await this.redis.set(sessKey, payload, "EX", this.config.sessionTtlSeconds);
    } else {
      await this.redis.set(sessKey, payload);
    }
  }

  async _endSlotSessionIfAny(sess) {
    try {
      if (sess.slotSessionId) this.slotFiller.endSession?.(sess.slotSessionId);
    } catch (_) { }
    sess.slotSessionId = null;
  }

  // -------------------------
  // Internal: Redis locking (prevents double execution)
  // -------------------------
  async _withSessionLock(lockKey, fn) {
    const token = crypto.randomBytes(16).toString("hex");
    const acquired = await this.redis.set(lockKey, token, "NX", "PX", this.config.lockTtlMs);

    if (!acquired) {
      return {
        type: "error",
        reply: "I’m already processing another request for this session. Please retry in a moment.",
      };
    }

    try {
      return await fn();
    } finally {
      // release only if we still own the lock
      const lua = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      try {
        await this.redis.eval(lua, 1, lockKey, token);
      } catch (_) {
        // best-effort
      }
    }
  }

  // -------------------------
  // Internal: Progress publishing (Redis PubSub)
  // -------------------------
  _makeProgressPublisher(sess, directPublisher = null) {
    const channel = sess.progressChannel || this._defaultProgressChannel(sess.sessionId);

    // executor will call onProgress(stepEvent)
    return async (evt) => {
      if (typeof directPublisher === 'function') {
        try {
          await directPublisher(evt);
        } catch (_) {
          // Streaming progress is best-effort and must never stop execution.
        }
      }
      try {
        const payload = JSON.stringify({
          sessionId: sess.sessionId,
          ts: Date.now(),
          ...evt,
        });
        // Works with ioredis / node-redis that supports publish
        await this.redis.publish(channel, payload);
      } catch (_) {
        // swallow progress failures; never break execution
      }
    };
  }

  // -------------------------
  // Internal: Yes/No parsing
  // -------------------------
  _isYes(text) {
    const s = String(text || "").trim().toLowerCase();
    return /^(yes|y|yeah|yep|ok|okay|sure|do it|run it|confirm|proceed)$/i.test(s);
  }

  _isNo(text) {
    const s = String(text || "").trim().toLowerCase();
    return /^(no|n|nope|nah|don't|do not|stop|cancel)$/i.test(s);
  }

  _executorSupportsResume() {
    // Accept either explicit flag or method presence
    return !!this.executor?.supportsResume || typeof this.executor?.resume === "function" || typeof this.executor?.execute === "function";
  }

  _injectSystemToolDefaults(routing, enabledToolkits, context) {
    const tools = Array.isArray(routing?.tools) ? routing.tools : [];
    if (tools.length === 0) return;

    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      const actionName = String(tool.composio_action || tool.name || "").trim();
      if (!actionName.startsWith("SYSTEM_")) continue;

      if (!tool.params || typeof tool.params !== "object") tool.params = {};

      if (!Array.isArray(tool.params.toolkits) || tool.params.toolkits.length === 0) {
        tool.params.toolkits = Array.isArray(enabledToolkits) ? enabledToolkits : [];
      }

      if (!tool.params.userId && context?.userId) tool.params.userId = context.userId;
      if (!tool.params.entityId && context?.entityId) tool.params.entityId = context.entityId;
      if (actionName === "SYSTEM_CHECK_CONNECTIONS") {
        // Connection status must use Composio's live per-user state. The local
        // connected_accounts table can lag behind a newly completed OAuth flow.
        tool.params.verifyWithComposio = true;
      }
    }
  }
}

module.exports = AssistantOrchestrator;
