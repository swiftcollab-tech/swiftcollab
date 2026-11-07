/**
 * UnifiedSlotFiller.js
 *
 * Drop-in, production-oriented slot filler that combines:
 * ✅ IntelligentSlotFiller-style STATE MACHINE (confirmations, fallback/defaults, cancellation, progressive disclosure)
 * ✅ Dynamic schemas from Composio (no SlotDefinitions.js, no per-action hardcoding)
 * ✅ Multi-tool chains from your ToolRouter output (Jira → Gmail → Slack → Calendar etc.)
 * ✅ Tool-scoped parameter storage (prevents cross-tool param bleed)
 * ✅ Deterministic missing-field computation from schema.required (LLM cannot "decide" missingness)
 * ✅ Timezone-safe datetime enforcement (RFC3339 with offset or Z)
 *
 * Integrates with your ToolRouter:
 * - Input: routingResult = await toolRouter.route(message, enabledToolkits, context)
 * - Then: slotFiller.startSession(sessionId, routingResult, context)
 * - Then: slotFiller.process(sessionId) -> ASK_QUESTION / CONFIRM_VALUES / COMPLETE / etc.
 * - Then: slotFiller.process(sessionId, userReply)
 *
 * Requires:
 * - composioToolSet.getTools({ apps: [toolkit] })
 * - callGemini(systemPrompt, prompt, temperature)
 */

class UnifiedSlotFiller {
  // =============================================================================
  // STATES
  // =============================================================================
  static STATE = {
    INITIALIZING: "INITIALIZING",
    INFERRING: "INFERRING",
    GATHERING: "GATHERING",
    ASKING: "ASKING",
    PARSING: "PARSING",
    CONFIRMING: "CONFIRMING",
    FALLBACK: "FALLBACK",
    COMPLETE: "COMPLETE",
    CANCELLED: "CANCELLED",
    ERROR: "ERROR",
  };

  // =============================================================================
  // DEFAULT CONFIG
  // =============================================================================
  static DEFAULT_CONFIG = {
    maxQuestionRounds: 15,
    maxFieldsPerQuestion: 6,
    confirmInferredHighStakes: true,
    confirmationThreshold: 0.75,
    enableLLMFallback: true,
    progressiveDisclosure: true, // ask required first, optional later (currently only required)
    userTimeZone: "UTC",
    schemaCacheTtlMs: 10 * 60 * 1000,
    maxIterationsInStateLoop: 30,
    // If we cannot resolve missing required fields after max rounds, we offer defaults if any exist, else cannot complete.
    allowOfferDefaults: true,
  };

  constructor({ composioToolSet, callGemini, redis = null, options = {} }) {
    if (!composioToolSet) throw new Error("composioToolSet required");
    if (!callGemini) throw new Error("callGemini required");

    this.composioToolSet = composioToolSet;
    this.callGemini = callGemini;

    this.config = { ...UnifiedSlotFiller.DEFAULT_CONFIG, ...options };
    this.USER_TZ = this.config.userTimeZone;

    // Redis client for session persistence (optional but recommended)
    this.redis = redis;
    this.useRedis = !!redis;
    this.SESSION_PREFIX = 'slotfiller:sess:';
    this.SESSION_TTL = options.sessionTtlSeconds || 60 * 60; // 1 hour default

    // In-memory fallback sessions: sessionId -> session
    this.sessions = new Map();

    // schema cache: actionName -> {schema, time}
    this.schemaCache = new Map();
    this.CACHE_TTL = this.config.schemaCacheTtlMs;

    // regex
    this.RX_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
    this.RX_URL = /\bhttps?:\/\/[^\s<>"')]+/gi;

    if (this.useRedis) {
      console.log('[SlotFiller] Redis session persistence enabled');
    }
  }

  // =============================================================================
  // SESSION PERSISTENCE HELPERS
  // =============================================================================

  /**
   * Get session from Redis or in-memory fallback
   */
  async _getSessionPersisted(sessionId) {
    if (this.useRedis) {
      try {
        const raw = await this.redis.get(this.SESSION_PREFIX + sessionId);
        if (raw) {
          const sess = JSON.parse(raw);
          // Restore Set objects which don't serialize to JSON
          sess.askedKeys = new Set(sess.askedKeys || []);
          sess.slotsNeedingConfirmation = new Set(sess.slotsNeedingConfirmation || []);
          // Restore Date objects
          if (sess.createdAt) sess.createdAt = new Date(sess.createdAt);
          if (sess.updatedAt) sess.updatedAt = new Date(sess.updatedAt);
          return sess;
        }
      } catch (err) {
        console.warn('[SlotFiller] Redis get failed, falling back to memory:', err.message);
      }
    }
    return this.sessions.get(sessionId);
  }

  /**
   * Save session to Redis and in-memory
   */
  async _saveSessionPersisted(sessionId, session) {
    // Always keep in memory for fast access
    this.sessions.set(sessionId, session);

    if (this.useRedis) {
      try {
        // Serialize Set objects to arrays
        const serializable = {
          ...session,
          askedKeys: Array.from(session.askedKeys || []),
          slotsNeedingConfirmation: Array.from(session.slotsNeedingConfirmation || []),
        };
        await this.redis.set(
          this.SESSION_PREFIX + sessionId,
          JSON.stringify(serializable),
          'EX',
          this.SESSION_TTL
        );
      } catch (err) {
        console.warn('[SlotFiller] Redis set failed:', err.message);
      }
    }
  }

  /**
   * Delete session from Redis and in-memory
   */
  async _deleteSessionPersisted(sessionId) {
    this.sessions.delete(sessionId);

    if (this.useRedis) {
      try {
        await this.redis.del(this.SESSION_PREFIX + sessionId);
      } catch (err) {
        console.warn('[SlotFiller] Redis del failed:', err.message);
      }
    }
  }

  // =============================================================================
  // PUBLIC API
  // =============================================================================

  /**
   * Start session from ToolRouter output.
   *
   * @param {string} sessionId
   * @param {object} routingResult - output of ToolRouter.route()
   * @param {object} context - { originalMessage, conversationHistory, storedResults, entityId, ... }
   */
  async startSession(sessionId, routingResult, context = {}) {
    if (!sessionId) throw new Error("sessionId required");
    if (!routingResult || !Array.isArray(routingResult.tools)) {
      throw new Error("routingResult.tools required (ToolRouter output)");
    }

    const tools = this._normalizeTools(routingResult.tools);

    // Prefer the exact provider schemas selected by ToolRouter. Looking up an
    // action again by its name can switch providers (native -> Composio) and
    // introduce fields that the chosen executor does not accept.
    const routedSchemas = routingResult.schemas && typeof routingResult.schemas === "object"
      ? routingResult.schemas
      : {};
    const schemaByToolId = {};
    for (const t of tools) {
      schemaByToolId[t.id] = routedSchemas[t.name] ||
        routedSchemas[t.composio_action] ||
        await this._getSchemaForAction(t.composio_action, context);
    }

    const session = {
      sessionId,
      state: UnifiedSlotFiller.STATE.INITIALIZING,
      createdAt: new Date(),
      updatedAt: new Date(),

      // ToolRouter context
      context: {
        ...context,
        originalMessage: context.originalMessage || context.message || null,
        userTimeZone: context.userTimeZone || context.timezone || this.USER_TZ,
        now: this._nowContext(context.userTimeZone || context.timezone || this.USER_TZ),
      },

      // Multi-tool chain
      tools, // [{id,name,sequence,composio_action,params}]
      schemaByToolId, // toolId -> jsonschema

      // Tool-scoped filled values
      filledByToolId: tools.reduce((acc, t) => {
        acc[t.id] = { ...(t.params || {}) };
        return acc;
      }, {}),

      // tracking
      requiredMissing: [],
      optionalMissing: [],
      currentQuestion: null,
      questionRound: 0,
      askedKeys: new Set(), // toolId.field (anti-loop)
      inferLog: [],
      parseLog: [],
      slotsNeedingConfirmation: new Set(), // toolId.field
      pendingConfirmations: [],
      error: null,
      cancellationReason: null,
    };

    // Persist session (Redis + in-memory)
    await this._saveSessionPersisted(sessionId, session);
    return session;
  }

  async getSession(sessionId) {
    return await this._getSessionPersisted(sessionId);
  }

  async endSession(sessionId) {
    await this._deleteSessionPersisted(sessionId);
  }

  /**
   * Main entry:
   * - call process(sessionId) for first turn after starting
   * - call process(sessionId, userResponse) on follow-up replies
   */
  async process(sessionId, userResponse = null) {
    const session = await this._getSessionPersisted(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    session.updatedAt = new Date();

    // If a user response is provided, process it
    if (userResponse !== null && userResponse !== undefined) {
      await this._processUserResponse(session, String(userResponse));
    }

    // Run state machine until it needs user input or completes
    const result = await this._runStateMachine(session);

    // Persist session after state changes
    await this._saveSessionPersisted(sessionId, session);

    return result;
  }

  // =============================================================================
  // STATE MACHINE
  // =============================================================================

  async _runStateMachine(session) {
    let iterations = 0;
    const maxIterations = this.config.maxIterationsInStateLoop;

    while (iterations++ < maxIterations) {
      const prevState = session.state;

      switch (session.state) {
        case UnifiedSlotFiller.STATE.INITIALIZING:
          await this._handleInitializing(session);
          break;

        case UnifiedSlotFiller.STATE.INFERRING:
          await this._handleInferring(session);
          break;

        case UnifiedSlotFiller.STATE.GATHERING:
          return await this._handleGathering(session);

        case UnifiedSlotFiller.STATE.ASKING:
          return this._handleAsking(session);

        case UnifiedSlotFiller.STATE.PARSING:
          // handled in _processUserResponse; after parsing we go to gathering
          session.state = UnifiedSlotFiller.STATE.GATHERING;
          break;

        case UnifiedSlotFiller.STATE.CONFIRMING:
          return this._handleConfirming(session);

        case UnifiedSlotFiller.STATE.FALLBACK:
          return this._handleFallback(session);

        case UnifiedSlotFiller.STATE.COMPLETE:
          return this._handleComplete(session);

        case UnifiedSlotFiller.STATE.CANCELLED:
          return this._handleCancelled(session);

        case UnifiedSlotFiller.STATE.ERROR:
          return this._handleError(session);

        default:
          session.state = UnifiedSlotFiller.STATE.ERROR;
          session.error = `Unknown state: ${session.state}`;
          break;
      }

      // if stuck
      if (session.state === prevState &&
        session.state !== UnifiedSlotFiller.STATE.GATHERING) {
        break;
      }
    }

    return this._buildResult(session);
  }

  async _handleInitializing(session) {
    // Ensure tool ordering
    session.tools.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    session.state = UnifiedSlotFiller.STATE.INFERRING;
  }

  /**
   * Inference step:
   * - deterministic "don't invent": we only do safe inference:
   *   - if router already put values in params, keep them
   *   - if an injection token exists, keep it
   *   - if schema has defaults, we may set them (low-stakes) with confirmation if high stakes
   * - NOTE: You can expand inference later (storedResults, last email, etc.)
   */
  async _handleInferring(session) {
    const changes = [];

    for (const tool of session.tools) {
      const schema = session.schemaByToolId[tool.id];
      if (!schema) continue;

      const props = schema.properties || {};
      const defaults = this._extractDefaults(schema);

      const current = session.filledByToolId[tool.id] || {};

      for (const [k, defVal] of Object.entries(defaults)) {
        // only set if missing
        if (current[k] === undefined || current[k] === null || current[k] === "") {
          current[k] = defVal;
          changes.push({ toolId: tool.id, tool: tool.name, field: k, value: defVal, source: "schema_default", confidence: 0.85 });
        }
      }

      // =======================================================================
      // NOTE: We intentionally DO NOT auto-default meeting duration.
      // The user should be asked for duration via _computeMissing.
      // If start_datetime is set but end_datetime is missing, it will be
      // flagged as a required field in the gathering phase.
      // =======================================================================

      session.filledByToolId[tool.id] = current;

      // timezone enforcement will be handled in gathering (missing computation)
      // we do not auto-fix datetimes here, because you don't want silent shifts.
    }

    if (changes.length) session.inferLog.push({ at: new Date().toISOString(), changes });

    // After inference, if any inferred values are "high stakes", request confirmation
    // High stakes heuristic: date-time, email, channel/project identifiers
    session.slotsNeedingConfirmation.clear();
    session.pendingConfirmations = [];

    for (const ch of changes) {
      const schema = session.schemaByToolId[ch.toolId];
      const isHigh = this._isHighStakesField(ch.field, schema);

      // Skip confirmation for null/empty/"null" values - nothing meaningful to confirm
      const isNullish = ch.value === null || ch.value === undefined ||
        ch.value === "" || ch.value === "null" || ch.value === "undefined";
      if (isNullish) continue;

      const needs = this.config.confirmInferredHighStakes && isHigh && ch.confidence < 1.0;

      if (needs) {
        const key = `${ch.toolId}.${ch.field}`;
        session.slotsNeedingConfirmation.add(key);
        session.pendingConfirmations.push({
          toolId: ch.toolId,
          toolName: ch.tool,
          field: ch.field,
          value: ch.value,
        });
      }
    }

    if (session.pendingConfirmations.length > 0) {
      session.state = UnifiedSlotFiller.STATE.CONFIRMING;
    } else {
      session.state = UnifiedSlotFiller.STATE.GATHERING;
    }
  }

  async _handleGathering(session) {
    // compute missing deterministically from schema.required
    const missing = this._computeMissing(session);

    session.requiredMissing = missing.required;
    session.optionalMissing = missing.optional;

    // If no required missing -> complete (optionals not requested by default)
    if (session.requiredMissing.length === 0) {
      session.state = UnifiedSlotFiller.STATE.COMPLETE;
      return await this._runStateMachine(session);
    }

    // exceeded rounds?
    if (session.questionRound >= this.config.maxQuestionRounds) {
      session.state = UnifiedSlotFiller.STATE.FALLBACK;
      return await this._runStateMachine(session);
    }

    // choose batch to ask now
    const batch = this._selectNextBatch(session, session.requiredMissing);

    const questionObj = await this._generateQuestion(session, batch);

    session.currentQuestion = {
      fields: batch,
      question: questionObj.text,
      suggestions: questionObj.suggestions || null,
    };

    session.state = UnifiedSlotFiller.STATE.ASKING;
    session.questionRound++;

    return this._buildResult(session, {
      action: "ASK_QUESTION",
      question: session.currentQuestion.question,
      pendingFields: session.currentQuestion.fields,
      suggestions: session.currentQuestion.suggestions,
      contextMessage: this._buildContextMessage(session),
      progress: this._progress(session),
    });
  }

  _handleAsking(session) {
    return this._buildResult(session, {
      action: "ASK_QUESTION",
      question: session.currentQuestion?.question || "I need a bit more info.",
      pendingFields: session.currentQuestion?.fields || [],
      suggestions: session.currentQuestion?.suggestions || null,
      contextMessage: this._buildContextMessage(session),
      progress: this._progress(session),
    });
  }

  _handleConfirming(session) {
    if (!session.pendingConfirmations || session.pendingConfirmations.length === 0) {
      session.state = UnifiedSlotFiller.STATE.GATHERING;
      return this._runStateMachine(session);
    }

    return this._buildResult(session, {
      action: "CONFIRM_VALUES",
      confirmations: session.pendingConfirmations,
      message: this._formatConfirmationMessage(session.pendingConfirmations),
    });
  }

  _handleFallback(session) {
    // Offer defaults only if there exist defaults for missing required fields; otherwise cannot complete.
    const missingReq = session.requiredMissing || [];
    const defaultsToOffer = [];

    for (const m of missingReq) {
      const schema = session.schemaByToolId[m.toolId];
      const defMap = this._extractDefaults(schema);
      if (defMap[m.field] !== undefined) {
        defaultsToOffer.push({
          toolId: m.toolId,
          toolName: m.toolName,
          field: m.field,
          defaultValue: defMap[m.field],
        });
      }
    }

    if (this.config.allowOfferDefaults && defaultsToOffer.length > 0) {
      return this._buildResult(session, {
        action: "OFFER_DEFAULTS",
        defaults: defaultsToOffer,
        message: this._formatDefaultsMessage(defaultsToOffer),
      });
    }

    return this._buildResult(session, {
      action: "CANNOT_COMPLETE",
      missing: missingReq,
      message:
        "I still need a few required details to proceed:\n\n" +
        this._formatMissingList(missingReq) +
        "\n\nReply with those values (you can do it in one message).",
    });
  }

  _handleComplete(session) {
    const toolsToExecute = this._buildToolsToExecute(session);
    return this._buildResult(session, {
      action: "COMPLETE",
      toolsToExecute,
      summary: this._formatCompletionSummary(session),
    });
  }

  _handleCancelled(session) {
    return this._buildResult(session, {
      action: "CANCELLED",
      reason: session.cancellationReason || "User cancelled",
    });
  }

  _handleError(session) {
    return this._buildResult(session, {
      action: "ERROR",
      error: session.error || "Unknown error",
    });
  }

  // =============================================================================
  // USER RESPONSE PROCESSING
  // =============================================================================

  async _processUserResponse(session, response) {
    // cancellation
    if (this._isCancellationResponse(response)) {
      session.state = UnifiedSlotFiller.STATE.CANCELLED;
      session.cancellationReason = "User requested cancellation";
      return;
    }

    // confirmation flow
    if (session.state === UnifiedSlotFiller.STATE.CONFIRMING) {
      const yes = this._isConfirmationResponse(response);
      if (yes) {
        // accept inferred defaults
        session.pendingConfirmations = [];
        session.slotsNeedingConfirmation.clear();
        session.state = UnifiedSlotFiller.STATE.GATHERING;
      } else {
        // user rejected -> remove those values and ask for them
        for (const item of session.pendingConfirmations) {
          const curr = session.filledByToolId[item.toolId] || {};
          delete curr[item.field];
          session.filledByToolId[item.toolId] = curr;
        }
        session.pendingConfirmations = [];
        session.slotsNeedingConfirmation.clear();
        session.state = UnifiedSlotFiller.STATE.GATHERING;
      }
      return;
    }

    // fallback defaults acceptance
    if (session.state === UnifiedSlotFiller.STATE.FALLBACK) {
      const yes = this._isConfirmationResponse(response);
      if (yes) {
        // apply defaults for missing required where available
        for (const m of session.requiredMissing || []) {
          const schema = session.schemaByToolId[m.toolId];
          const defMap = this._extractDefaults(schema);
          if (defMap[m.field] !== undefined) {
            session.filledByToolId[m.toolId] = {
              ...(session.filledByToolId[m.toolId] || {}),
              [m.field]: defMap[m.field],
            };
          }
        }
        session.state = UnifiedSlotFiller.STATE.GATHERING;
      } else {
        session.state = UnifiedSlotFiller.STATE.CANCELLED;
        session.cancellationReason = "User declined defaults";
      }
      return;
    }

    // Check for mid-flow corrections like "actually make it 4pm" or "change to tomorrow"
    const correction = this._detectCorrection(response);
    if (correction) {
      // Apply correction to existing filled values
      for (const tool of session.tools) {
        const current = session.filledByToolId[tool.id] || {};
        if (correction.field && correction.value) {
          // Update the specific field if it exists for this tool
          if (current[correction.field] !== undefined || this._toolHasField(tool.id, correction.field, session)) {
            current[correction.field] = correction.value;
            session.filledByToolId[tool.id] = current;
            console.log(`[SlotFiller] Applied correction: ${correction.field} = ${correction.value}`);
          }
        }
      }
      // Re-enter gathering to check if more fields needed
      session.state = UnifiedSlotFiller.STATE.GATHERING;
      return;
    }

    // parse answers for the current question
    if (session.currentQuestion?.fields?.length) {
      const extracted = await this._extractValues(session, response, session.currentQuestion.fields);

      // merge tool-scoped extracted values
      this._mergeExtracted(session, extracted);

      session.parseLog.push({
        at: new Date().toISOString(),
        response,
        extracted,
        asked: session.currentQuestion.fields.map((f) => ({ toolId: f.toolId, field: f.field })),
      });
    }

    session.state = UnifiedSlotFiller.STATE.PARSING;
  }

  // =============================================================================
  // CORRECTION DETECTION
  // =============================================================================

  /**
   * Detect mid-flow corrections like "actually 4pm" or "make it tomorrow"
   */
  _detectCorrection(response) {
    const text = String(response || "").trim().toLowerCase();

    // Time correction patterns
    const timePatterns = [
      /(?:actually|make it|change (?:it )?to|no,?\s*)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
      /(?:actually|make it|change (?:it )?to)\s*(tomorrow|today|next\s+\w+)/i,
    ];

    for (const pattern of timePatterns) {
      const match = text.match(pattern);
      if (match) {
        return { field: 'start_datetime', value: match[1], type: 'time_correction' };
      }
    }

    // Title/summary correction patterns
    const titlePatterns = [
      /(?:call it|name it|title[:\s]+|change (?:the )?(?:title|name) to)\s*["']?([^"']+)["']?/i,
    ];

    for (const pattern of titlePatterns) {
      const match = text.match(pattern);
      if (match) {
        return { field: 'summary', value: match[1].trim(), type: 'title_correction' };
      }
    }

    // Duration correction
    const durationMatch = text.match(/(?:make it|for)\s+(\d+)\s*(minutes?|hours?|mins?|hrs?)/i);
    if (durationMatch) {
      const num = parseInt(durationMatch[1], 10);
      const unit = durationMatch[2].toLowerCase();
      const minutes = unit.startsWith('h') ? num * 60 : num;
      return { field: 'duration_minutes', value: minutes, type: 'duration_correction' };
    }

    return null;
  }

  /**
   * Check if a tool has a specific field in its schema
   */
  _toolHasField(toolId, fieldName, session) {
    const schema = session.schemaByToolId[toolId];
    if (!schema?.properties) return false;
    return fieldName in schema.properties;
  }

  // =============================================================================
  // MISSING COMPUTATION + PRIORITY
  // =============================================================================

  _computeMissing(session) {
    const required = [];
    const optional = [];

    for (const tool of session.tools) {
      const schema = session.schemaByToolId[tool.id];
      if (!schema) continue;

      const props = schema.properties || {};
      const req = Array.isArray(schema.required) ? schema.required : [];
      const params = session.filledByToolId[tool.id] || {};

      // required missing
      for (const field of req) {
        const v = params[field];

        // injection token counts as satisfied
        if (v === "_inject_from_previous") continue;

        const isNullish = v === undefined || v === null;
        const isEmptyString = typeof v === "string" && v.trim() === "";
        const isEmptyArray = Array.isArray(v) && v.length === 0;

        if (isNullish || isEmptyString || isEmptyArray) {
          required.push(this._missingEntry(tool, schema, field, "required_missing"));
        }
      }

      // timezone enforcement: if date-time present but no tz -> treat as required missing
      const dtNoTz = this._dateTimeFieldsMissingTimezone(params, schema);
      for (const field of dtNoTz) {
        // avoid duplicates
        if (!required.some((m) => m.toolId === tool.id && m.field === field)) {
          required.push(this._missingEntry(tool, schema, field, "datetime_missing_timezone"));
        }
      }

      // CALENDAR DURATION: If start_datetime is set but end_datetime is missing, ask for it
      // This ensures we don't auto-default duration - user should specify
      const isCalendarAction = /CALENDAR.*CREATE|CREATE.*EVENT/i.test(tool.composio_action || tool.name);
      if (isCalendarAction) {
        const hasStart = params.start_datetime && typeof params.start_datetime === 'string' && params.start_datetime.trim();
        const hasEnd = params.end_datetime && typeof params.end_datetime === 'string' && params.end_datetime.trim();

        if (hasStart && !hasEnd && props.end_datetime) {
          // end_datetime exists in schema but not filled - treat as required
          if (!required.some((m) => m.toolId === tool.id && m.field === 'end_datetime')) {
            const entry = this._missingEntry(tool, schema, 'end_datetime', 'calendar_duration_required');
            // Override description to ask for duration in a friendly way
            entry.description = 'meeting duration or end time (e.g., "30 minutes", "1 hour", "until 3pm")';
            required.push(entry);
          }
        }
      }

      // optional (not asked by default; kept for future)
      for (const [field, spec] of Object.entries(props)) {
        if (req.includes(field)) continue;
        // only track optional fields that are truly empty and meaningful
        // (we don't ask them unless you add behavior later)
        const v = params[field];
        if (v === undefined || v === null || v === "") {
          optional.push(this._missingEntry(tool, schema, field, "optional_missing"));
        }
      }
    }

    const dedup = (arr) => {
      const seen = new Set();
      const out = [];
      for (const m of arr) {
        const k = `${m.toolId}.${m.field}.${m.reason}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(m);
      }
      return out;
    };

    const reqDedup = dedup(required);
    reqDedup.sort((a, b) => {
      const pa = this._getFieldPriority(a.field, a.schema);
      const pb = this._getFieldPriority(b.field, b.schema);
      if (pa !== pb) return pa - pb;
      return `${a.sequence}.${a.toolName}.${a.field}`.localeCompare(`${b.sequence}.${b.toolName}.${b.field}`);
    });

    return { required: reqDedup, optional: dedup(optional) };
  }

  _missingEntry(tool, schema, field, reason) {
    const spec = (schema?.properties && schema.properties[field]) ? schema.properties[field] : {};
    return {
      toolId: tool.id,
      toolName: tool.name,
      sequence: tool.sequence,
      field,
      reason,
      schema,
      description: spec.description || field,
      type: spec.type || "string",
      format: spec.format || null,
      enum: spec.enum || null,
    };
  }

  /**
   * Select next batch of fields to ask about.
   * Enhanced to prefer grouping fields from the same tool for clarity.
   */
  _selectNextBatch(session, requiredMissingSorted) {
    // Ask for exactly one tool-scoped value at a time. A response such as
    // "Welcome onboarding call" must not be copied into both a Calendar title
    // and a Spreadsheet title merely because both were missing together.
    for (const m of requiredMissingSorted) {
      const key = `${m.toolId}.${m.field}`;
      if (session.askedKeys.has(key)) continue;
      session.askedKeys.add(key);
      return [m];
    }

    return requiredMissingSorted.length > 0 ? [requiredMissingSorted[0]] : [];
  }

  /**
   * This is the dynamic priority function you asked about.
   * It is schema-aware and cross-app safe (not per-action hardcoding).
   */
  _getFieldPriority(fieldName, schema) {
    const props = schema?.properties?.[fieldName] || {};
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const isRequired = required.includes(fieldName);

    const format = String(props.format || "").toLowerCase();
    const type = props.type;
    const fname = String(fieldName || "").toLowerCase();

    // 1) date/email/url required => critical
    if (isRequired && (format === "date-time" || format === "date")) return 1;
    if (isRequired && (format === "email" || format === "uri")) return 1;
    if (isRequired && type === "array" && props.items?.format === "email") return 1;

    // 2) generic identifiers/targets
    const idish =
      /(^|_)(id|key)(_|$)/i.test(fname) ||
      /(project|workspace|space|board|list|channel|conversation|repo|team|org|account)/i.test(fname) ||
      /(^to$|recipient|assignee|owner|attendee|invitee)/i.test(fname);

    if (isRequired && idish) return 1;

    // 3) title fields
    const titleish = /(summary|subject|title|name)/i.test(fname);
    if (isRequired && titleish) return 2;

    // 4) other required strings
    if (isRequired && (type === "string" || !type)) return 2;

    // 5) enums are useful
    if (Array.isArray(props.enum) && props.enum.length > 0) return isRequired ? 2 : 3;

    return isRequired ? 3 : 5;
  }

  _dateTimeFieldsMissingTimezone(params, schema) {
    const props = schema?.properties || {};
    const out = [];
    for (const [field, spec] of Object.entries(props)) {
      if (spec?.format !== "date-time") continue;
      const v = params?.[field];
      if (!v || typeof v !== "string") continue;
      if (v === "_inject_from_previous") continue;
      const hasTz = /([zZ]|[+\-]\d{2}:\d{2})$/.test(v);
      if (!hasTz) out.push(field);
    }
    return out;
  }

  // =============================================================================
  // QUESTION GENERATION + EXTRACTION
  // =============================================================================

  async _generateQuestion(session, missingBatch) {
    const now = session.context.now;

    const compact = missingBatch.map((m) => ({
      tool: m.toolName,
      sequence: m.sequence,
      field: m.field,
      type: m.type,
      format: m.format || null,
      description: m.description || null,
      enum: Array.isArray(m.enum) ? m.enum.slice(0, 10) : null,
    }));

    const timeZone = session.context.userTimeZone || this.USER_TZ;
    const systemPrompt = `You write short, friendly, NATURAL clarification questions like a helpful assistant.

CURRENT TIME:
- timezone: ${timeZone}
- today: ${now.today}
- tomorrow: ${now.tomorrow}

CRITICAL RULES:
1) Ask in NATURAL LANGUAGE - like talking to a friend.
2) NEVER mention technical formats like "YYYY-MM-DD" or "ISO format" or "RFC3339".
3) For datetime fields, ask naturally: "What time would you like to schedule this?" or "When should we set up this meeting?"
4) For meeting title/summary: ask "What should I call this meeting?" or "What's the meeting about?"
5) If multiple fields missing, ask ONE thing at a time - focus on the most important one first.
6) Give helpful examples in natural form: "tomorrow at 2pm", "next Monday morning", "30 minutes"
7) Keep responses brief and conversational.

GOOD examples:
- "What time would you like to schedule the meeting?"
- "How long should the meeting be? (e.g., 30 minutes, 1 hour)"
- "What should I call this event?"

BAD examples (NEVER do this):
- "Please use YYYY-MM-DDTHH:MM:SS format"
- "What is the start_datetime?"
- "Enter the summary field"

OUTPUT JSON ONLY:
{"text":"your natural question here","suggestions":["tomorrow at 2pm","next Monday at 10am"]}`;

    const userPrompt = `User original request:
${session.context.originalMessage ? `"${session.context.originalMessage}"` : "(unknown)"}

Already collected (per tool):
${JSON.stringify(this._buildToolsToExecute(session), null, 2)}

Missing to ask now:
${JSON.stringify(compact, null, 2)}
`;

    try {
      const resp = await this.callGemini(systemPrompt, userPrompt, 0);
      const parsed = this._parseJson(resp);
      if (parsed?.text) return parsed;
    } catch (_) { }

    // Natural language fallback - don't show technical field names
    return this._naturalLanguageFallback(missingBatch);
  }

  /**
   * Generate a natural language question when LLM fails
   */
  _naturalLanguageFallback(missingBatch) {
    if (missingBatch.length === 0) {
      return { text: "I need a bit more information to continue.", suggestions: null };
    }

    // Focus on the most important missing field
    const first = missingBatch[0];
    const field = first.field;
    const toolName = this._friendlyActionName(first.toolName);

    // Natural language questions for common fields
    const questions = {
      'start_datetime': {
        text: "What time would you like to schedule this?",
        suggestions: ["tomorrow at 2pm", "next Monday at 10am", "today at 3pm"]
      },
      'end_datetime': {
        text: "How long should this be? (or when should it end?)",
        suggestions: ["30 minutes", "1 hour", "until 4pm"]
      },
      'summary': {
        text: "What should I call this event?",
        suggestions: ["Team Meeting", "Quick Sync", "Project Review"]
      },
      'attendees': {
        text: "Who should I invite? (please share their email addresses)",
        suggestions: null
      },
      'to': {
        text: "Who should I send this to?",
        suggestions: null
      },
      'subject': {
        text: "What should the subject line be?",
        suggestions: null
      },
      'body': {
        text: "What would you like the message to say?",
        suggestions: null
      },
      'channel': {
        text: "Which Slack channel should I send this to?",
        suggestions: ["#general", "#random", "#team"]
      },
      'text': {
        text: "What message would you like to send?",
        suggestions: null
      },
      // Frappe invoice fields
      'customer': {
        text: "Who is the customer for this invoice?",
        suggestions: null
      },
      'items': {
        text: "What items should be included in the invoice?",
        suggestions: null
      },
      'due_date': {
        text: "When is the payment due? (e.g., 'in 30 days', '2024-01-15')",
        suggestions: ["In 30 days", "In 15 days", "Today"]
      },
      'supplier': {
        text: "Who is the supplier?",
        suggestions: null
      },
    };

    if (questions[field]) {
      return questions[field];
    }

    // Generic fallback with friendly field name
    const friendlyField = this._friendlyFieldName(field);
    return {
      text: `What ${friendlyField} would you like?`,
      suggestions: null
    };
  }

  async _extractValues(session, userResponse, missingBatch) {
    const now = session.context.now;
    const regexHints = this._regexHints(userResponse);

    const fields = missingBatch.map((m) => ({
      toolId: m.toolId,
      tool: m.toolName,
      field: m.field,
      type: m.type,
      format: m.format || null,
      description: m.description || null,
      enum: Array.isArray(m.enum) ? m.enum.slice(0, 15) : null,
    }));

    const timeZone = session.context.userTimeZone || this.USER_TZ;
    const systemPrompt = `You extract structured parameters from user text.

CURRENT TIME:
- timezone: ${timeZone}
- now: ${now.nowRfc3339}
- today: ${now.today}
- tomorrow: ${now.tomorrow}
- yesterday: ${now.yesterday}
- local offset hint: ${now.offset}

CRITICAL RULES:
1) Output JSON only.
2) Output must be tool-scoped by toolId:
   {"toolId": {"field":"value"}, "toolId2":{"field2":"value2"}}
3) If format is "date-time": output RFC3339 WITH timezone offset or Z.
   Examples:
   - ${now.tomorrow}T10:00:00${now.offset}
   - ${now.tomorrow}T15:00:00Z
   NEVER omit timezone.
4) If format is "date": output YYYY-MM-DD.
5) If type is array: output array.
6) If enum exists: choose EXACT enum value.
7) Do not invent IDs/emails/channels. If not present, omit.
8) For an array whose item type is also array, return a two-dimensional table of rows. You may structure facts explicitly present in the original request and already collected tool parameters into clear headers and rows.

Return only what you can extract confidently.`;

    const userPrompt = `User response:
"${userResponse}"

Missing fields:
${JSON.stringify(fields, null, 2)}

Regex hints (high-confidence):
${JSON.stringify(regexHints, null, 2)}

Original request:
${JSON.stringify(session.context.originalMessage || '')}

Already collected tool parameters:
${JSON.stringify(this._buildToolsToExecute(session), null, 2)}
`;

    try {
      const resp = await this.callGemini(systemPrompt, userPrompt, 0);
      console.log(`[SlotFiller] _extractValues LLM response:`, resp?.slice(0, 200));
      const parsed = this._parseJson(resp);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        console.log(`[SlotFiller] _extractValues parsed:`, JSON.stringify(parsed).slice(0, 300));
        return parsed;
      }
    } catch (err) {
      console.warn(`[SlotFiller] _extractValues LLM failed:`, err.message);
    }

    // Enhanced fallback: try to match user response to likely fields
    const response = userResponse.trim();
    console.log(`[SlotFiller] _extractValues fallback for response: "${response}", fields:`, missingBatch.map(m => m.field));

    // Build fallback result
    const fallback = {};

    // Group missing by toolId
    const byToolId = {};
    for (const m of missingBatch) {
      if (!byToolId[m.toolId]) byToolId[m.toolId] = [];
      byToolId[m.toolId].push(m);
    }

    // Try to assign the response to the most likely field
    for (const [toolId, fields] of Object.entries(byToolId)) {
      fallback[toolId] = {};

      // If only one field for this tool, assign directly
      if (fields.length === 1) {
        fallback[toolId][fields[0].field] = response;
        continue;
      }

      // Look for array-type fields (like items) - these likely want the user's item names
      const arrayField = fields.find(f => f.type === 'array');
      if (arrayField && response) {
        const fieldSchema = session.schemaByToolId[toolId]?.properties?.[arrayField.field];
        fallback[toolId][arrayField.field] = fieldSchema?.items?.type === 'array'
          ? [[response]]
          : [response];
        console.log(`[SlotFiller] Fallback assigned "${response}" to array field: ${arrayField.field}`);
        continue;
      }

      // Look for common field patterns
      const fieldMatches = {
        items: /^[a-z,\s]+$/i, // Likely item names
        customer: /^[a-zA-Z\s]+$/, // Customer name pattern
        subject: /.+/, // Subject can be anything
        body: /.+/, // Body can be anything
      };

      for (const f of fields) {
        const pattern = fieldMatches[f.field];
        if (pattern && pattern.test(response)) {
          fallback[toolId][f.field] = response;
          console.log(`[SlotFiller] Fallback matched "${response}" to field: ${f.field}`);
          break;
        }
      }
    }

    console.log(`[SlotFiller] _extractValues fallback result:`, JSON.stringify(fallback).slice(0, 200));
    return Object.keys(fallback).length > 0 &&
      Object.values(fallback).some(v => Object.keys(v).length > 0)
      ? fallback : {};
  }

  _mergeExtracted(session, extracted) {
    if (!extracted || typeof extracted !== "object") return;

    for (const [toolId, obj] of Object.entries(extracted)) {
      if (!session.filledByToolId[toolId]) continue;
      if (!obj || typeof obj !== "object") continue;

      // Get schema for this tool to do type coercion
      const schema = session.schemaByToolId[toolId];
      const props = schema?.properties || {};

      // Coerce values to match schema types
      const coerced = {};
      for (const [field, value] of Object.entries(obj)) {
        const fieldSchema = props[field] || {};
        let finalValue = value;

        // If schema expects array but got string, convert to array
        if (fieldSchema.type === 'array' && typeof value === 'string' && value.trim()) {
          // Split by comma if multiple items, otherwise wrap in array
          if (value.includes(',')) {
            finalValue = value.split(',').map(v => v.trim()).filter(Boolean);
          } else {
            finalValue = [value.trim()];
          }
          console.log(`[SlotFiller] Coerced ${field} from string to array:`, finalValue);
        }

        if (fieldSchema.type === 'array' && fieldSchema.items?.type === 'array' && Array.isArray(finalValue)) {
          finalValue = finalValue.map(row => Array.isArray(row) ? row : [row]);
        }

        coerced[field] = finalValue;
      }

      session.filledByToolId[toolId] = { ...session.filledByToolId[toolId], ...coerced };
    }
  }

  // =============================================================================
  // TOOL EXECUTION SHAPE (to hand to Temporal/executor)
  // =============================================================================

  _buildToolsToExecute(session) {
    return session.tools
      .slice()
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
      .map((t) => ({
        id: t.id,
        name: t.name,
        composio_action: t.composio_action,
        sequence: t.sequence,
        params: { ...(session.filledByToolId[t.id] || {}) },
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.slice() : [],
        usePreviousOutput: !!t.usePreviousOutput,
        injectFrom: t.injectFrom && typeof t.injectFrom === 'object' ? { ...t.injectFrom } : null,
      }));
  }

  // =============================================================================
  // MESSAGES
  // =============================================================================

  _buildContextMessage(session) {
    // Similar to your SmartSlotFiller: show what we have so far (brief)
    // Filter out internal/technical fields that users don't care about
    const HIDDEN_FIELDS = new Set([
      'birthdayProperties', 'fail_fast', 'fields_by_keys', 'expand',
      'fields', 'validateOnly', 'conferenceDataVersion', 'supportsAttachments',
      'sendNotifications', 'sendUpdates', 'maxAttendees', 'calendarId',
      'timeZone', 'colorId', 'guestsCanInviteOthers', 'guestsCanModify',
      'guestsCanSeeOtherGuests', 'source', 'transparency', 'visibility',
      'userId', 'entityId', '_userTimezone', 'properties', 'notifyOnCompletion'
    ]);

    const tools = this._buildToolsToExecute(session);
    const lines = [];

    for (const t of tools) {
      const keys = Object.keys(t.params || {}).filter(k => !HIDDEN_FIELDS.has(k));
      // Also filter out fields with null, _inject_from_previous, or __INJECT__ values
      const visibleKeys = keys.filter(k => {
        const v = t.params[k];
        if (v === null || v === undefined) return false;
        if (v === '_inject_from_previous' || v === '__INJECT__') return false;
        return true;
      });

      if (visibleKeys.length === 0) continue;

      // Use friendly action name instead of raw action name
      const friendlyName = this._friendlyActionName(t.name || t.composio_action);
      lines.push(`**${friendlyName}:**`);
      for (const k of visibleKeys.slice(0, 6)) {
        let v = t.params[k];
        if (Array.isArray(v)) {
          v = v.map(item => {
            if (!item || typeof item !== 'object') return item;
            return item.email || item.name || JSON.stringify(item);
          }).join(", ");
        }
        if (typeof v === "string" && v.length > 60) v = v.slice(0, 60) + "...";
        // Use friendly field name
        const friendlyField = this._friendlyFieldName(k);
        lines.push(`• ${friendlyField}: ${v}`);
      }
    }

    return lines.length ? "Here's what I have so far:\n" + lines.join("\n") : null;
  }

  _friendlyActionName(action) {
    const map = {
      'GOOGLECALENDAR_CREATE_EVENT': 'Create Calendar Event',
      'GOOGLECALENDAR_FIND_EVENT': 'Find Calendar Events',
      'GMAIL_SEND_EMAIL': 'Send Email',
      'GMAIL_FETCH_EMAILS': 'Fetch Emails',
      'SLACK_SENDS_A_MESSAGE': 'Send Slack Message',
      'JIRA_SEARCH_ISSUES': 'Search Jira Issues',
      'JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET': 'Search Jira Issues',
      'JIRA_CREATE_ISSUE': 'Create Jira Issue',
    };
    return map[action] || action?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) || action;
  }

  _friendlyFieldName(field) {
    const map = {
      'start_datetime': 'Start time',
      'end_datetime': 'End time',
      'event_duration_minutes': 'Duration',
      'summary': 'Title',
      'description': 'Description',
      'attendees': 'Attendees',
      'to': 'To',
      'subject': 'Subject',
      'body': 'Message',
      'channel': 'Channel',
      'text': 'Message',
      'jql': 'Search query',
    };
    return map[field] || field.replace(/_/g, ' ');
  }

  _formatMissingList(missing) {
    return missing
      .map((m, i) => {
        const desc = m.description && m.description !== m.field ? ` (${m.description})` : "";
        return `${i + 1}. ${m.toolName}.${m.field}${desc}`;
      })
      .join("\n");
  }

  _formatConfirmationMessage(confirmations) {
    const items = confirmations
      .map((c) => `${c.toolName}.${c.field}: "${c.value}"`)
      .join(", ");
    return `I found defaults: ${items}. Is that correct? (yes/no)`;
  }

  _formatDefaultsMessage(defaults) {
    const items = defaults
      .map((d) => `${d.toolName}.${d.field}="${d.defaultValue}"`)
      .join(", ");
    return `I can use defaults for the remaining required fields: ${items}. Is that okay? (yes/no)`;
  }

  _formatCompletionSummary(session) {
    // Minimal neutral summary across any tools
    const tools = this._buildToolsToExecute(session);
    const names = tools.map((t) => t.name).join(" → ");
    return `Ready to execute: ${names}`;
  }

  // =============================================================================
  // VALIDATION / SAFETY
  // =============================================================================

  _isHighStakesField(field, schema) {
    const props = schema?.properties?.[field] || {};
    const format = String(props.format || "").toLowerCase();
    const fname = String(field || "").toLowerCase();

    // Exclude pagination, sync, and filter tokens - these are NOT high stakes
    const paginationFields = /(pagetoken|synctoken|nexttoken|cursor|offset|limit|pagesize|icaluid|orderby|sortby|sortorder|maxresults|showdeleted|showhidden|updatemin|timemin|timemax|q\b)/i;
    if (paginationFields.test(fname)) return false;

    if (format === "date-time" || format === "date") return true;
    if (format === "email") return true;
    if (/(channel|project|workspace|board|list|assignee|to|recipient)/i.test(fname)) return true;
    // Only treat as high-stakes if it's an entity ID like "userId", "projectId" - not "iCalUID"
    if (/(^id$|userid|projectid|issueid|taskid|boardid|channelid|teamid|accountid)/i.test(fname)) return true;
    return false;
  }

  _isCancellationResponse(response) {
    const s = response.trim();
    const patterns = [
      /^(cancel|stop|never\s*mind|forget\s*it|abort)$/i,
      /^(no|nope|nah),?\s*(cancel|stop|forget)/i,
      /don'?t\s+(do|create|schedule|send)/i,
    ];
    return patterns.some((p) => p.test(s));
  }

  _isConfirmationResponse(response) {
    const s = response.trim();
    const patterns = [
      /^(yes|yeah|yep|yup|sure|ok|okay|correct|right|confirmed?)$/i,
      /^(that'?s?\s+)?(right|correct|good|fine|perfect)/i,
      /^(sounds?\s+)?(good|great|perfect)/i,
    ];
    return patterns.some((p) => p.test(s));
  }

  _progress(session) {
    // percent filled among required fields across all tools
    const missing = session.requiredMissing || [];
    const totalReq = this._countTotalRequired(session);
    const filled = Math.max(totalReq - missing.length, 0);
    const pct = totalReq ? Math.round((filled / totalReq) * 100) : 100;
    return { filled, total: totalReq, percentage: pct };
  }

  _countTotalRequired(session) {
    let total = 0;
    for (const tool of session.tools) {
      const schema = session.schemaByToolId[tool.id];
      if (!schema) continue;
      const req = Array.isArray(schema.required) ? schema.required : [];
      total += req.length;
    }
    return total;
  }

  // =============================================================================
  // SCHEMA HELPERS (Composio)
  // =============================================================================

  async _getSchemaForAction(actionName, context = {}) {
    if (!actionName) return null;

    // Local schemas for internal SYSTEM_* tools (not fetched from Composio)
    if (String(actionName).startsWith("SYSTEM_")) {
      if (actionName === "SYSTEM_CHECK_CONNECTIONS") {
        return {
          type: "object",
          properties: {
            toolkits: {
              type: "array",
              items: { type: "string" },
              description: "Toolkits to check (defaults to apps in your workspace)",
            },
            verifyWithComposio: {
              type: "boolean",
              default: false,
              description: "If true, verify connection status by calling Composio (slower)",
            },
            includeAuthUrls: {
              type: "boolean",
              default: false,
              description: "If true, include connect/auth URLs for missing apps (may initiate an OAuth flow)",
            },
          },
          required: [],
        };
      }

      // Unknown system action: treat as no-params
      return { type: "object", properties: {}, required: [] };
    }

    // Handle FRAPPE_* actions - fetch from FrappeSchemaService (per-user ERPNext)
    if (String(actionName).startsWith("FRAPPE_")) {
      return this._getFrappeSchema(actionName, context);
    }

    const cached = this.schemaCache.get(actionName);
    if (cached && Date.now() - cached.time < this.CACHE_TTL) return cached.schema;

    try {
      const toolkit = String(actionName).split("_")[0] || actionName;
      // Use getToolsForToolkit which is the method available in ComposioService
      const tools = await this.composioToolSet.getToolsForToolkit(toolkit);
      const match = (tools || []).find((t) => (t.function?.name || t.name) === actionName);

      const schema = match ? (match.function?.parameters || match.parameters || match.inputParameters || null) : null;
      this.schemaCache.set(actionName, { schema, time: Date.now() });
      return schema;
    } catch (err) {
      console.warn(`[UnifiedSlotFiller] schema fetch failed for ${actionName}: ${err.message}`);
      this.schemaCache.set(actionName, { schema: null, time: Date.now() });
      return null;
    }
  }

  /**
   * Get schema for FRAPPE_* actions from user's ERPNext instance
   * Parses DocType from action name and fetches dynamic schema
   */
  async _getFrappeSchema(actionName, context = {}) {
    const userId = context.userId;
    const cacheKey = `${actionName}:${userId || 'anonymous'}`;

    // Check cache first
    const cached = this.schemaCache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.CACHE_TTL) {
      return cached.schema;
    }

    try {
      // FIRST: Check if we have a predefined schema in FRAPPE_ACTIONS
      // This contains correct required fields that the generic fallback doesn't know about
      const { FRAPPE_ACTIONS } = require('../../integrations/frappe');
      const predefinedAction = FRAPPE_ACTIONS?.[actionName];
      if (predefinedAction?.parameters) {
        console.log(`[UnifiedSlotFiller] Using predefined schema for ${actionName}`);
        const schema = predefinedAction.parameters;
        this.schemaCache.set(cacheKey, { schema, time: Date.now() });
        return schema;
      }

      // Lazy-load FrappeSchemaService to avoid circular dependencies
      const { frappeSchemaService, frappeConnectionManager } = require('../../integrations/frappe');

      // Parse DocType from action name
      // Format: FRAPPE_<OPERATION>_<DOCTYPE> e.g., FRAPPE_CREATE_CUSTOMER -> Customer
      const parts = actionName.split('_');
      if (parts.length < 3) {
        console.warn(`[UnifiedSlotFiller] Invalid Frappe action name: ${actionName}`);
        return this._getGenericFrappeActionSchema(actionName);
      }


      const operation = parts[1].toLowerCase(); // create, list, get, update, delete
      const docTypeKey = parts.slice(2).join('_'); // CUSTOMER, SALES_ORDER, etc.

      // Convert to proper DocType name (SALES_ORDER -> Sales Order, CUSTOMER -> Customer)
      const docTypeName = docTypeKey
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');

      // Check if user has active Frappe connection
      if (!userId) {
        console.warn('[UnifiedSlotFiller] No userId for Frappe schema - using generic schema');
        return this._getGenericFrappeActionSchema(actionName, docTypeName, operation);
      }

      const hasConnection = await frappeConnectionManager.hasActiveConnection(userId);
      if (!hasConnection) {
        console.log('[UnifiedSlotFiller] No active Frappe connection for user');
        return this._getGenericFrappeActionSchema(actionName, docTypeName, operation);
      }

      // Fetch the DocType schema from user's ERPNext
      console.log(`[UnifiedSlotFiller] Fetching Frappe schema for ${docTypeName} (user: ${userId})`);
      const docTypeSchema = await frappeSchemaService.getDocTypeSchema(userId, docTypeName);

      if (!docTypeSchema) {
        console.warn(`[UnifiedSlotFiller] No schema found for DocType: ${docTypeName}`);
        return this._getGenericFrappeActionSchema(actionName, docTypeName, operation);
      }

      // Generate action-specific schema based on operation
      let schema;
      switch (operation) {
        case 'create':
          // For create, use the full DocType schema
          schema = {
            type: 'object',
            properties: docTypeSchema.properties || {},
            required: docTypeSchema.required || [],
            description: `Create a new ${docTypeName} in ERPNext`
          };
          break;

        case 'update':
          // For update, require 'name' plus any fields to update
          schema = {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                title: 'Document Name',
                description: `The name/ID of the ${docTypeName} to update`
              },
              ...(docTypeSchema.properties || {})
            },
            required: ['name'],
            description: `Update an existing ${docTypeName} in ERPNext`
          };
          break;

        case 'get':
        case 'delete':
          // For get/delete, only require 'name'
          schema = {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                title: 'Document Name',
                description: `The name/ID of the ${docTypeName}`
              }
            },
            required: ['name'],
            description: `${operation === 'get' ? 'Get' : 'Delete'} a ${docTypeName} from ERPNext`
          };
          break;

        case 'list':
          // For list, optional filters
          schema = {
            type: 'object',
            properties: {
              limit: {
                type: 'integer',
                description: 'Maximum number of documents to return',
                default: 20
              },
              filters: {
                type: 'object',
                description: 'Filter conditions as key-value pairs'
              },
              fields: {
                type: 'array',
                items: { type: 'string' },
                description: 'Fields to include in response'
              },
              order_by: {
                type: 'string',
                description: 'Sort order (e.g., "creation desc")',
                default: 'modified desc'
              }
            },
            required: [],
            description: `List ${docTypeName} documents from ERPNext`
          };
          break;

        default:
          schema = this._getGenericFrappeActionSchema(actionName, docTypeName, operation);
      }

      // Cache the schema
      this.schemaCache.set(cacheKey, { schema, time: Date.now() });
      console.log(`[UnifiedSlotFiller] Frappe schema loaded for ${actionName}, required fields: ${JSON.stringify(schema.required)}`);
      return schema;

    } catch (err) {
      console.error(`[UnifiedSlotFiller] Failed to fetch Frappe schema for ${actionName}:`, err.message);
      return this._getGenericFrappeActionSchema(actionName);
    }
  }

  /**
   * Generic Frappe action schema when dynamic schema is unavailable
   * Now includes proper required fields for known DocTypes
   */
  _getGenericFrappeActionSchema(actionName, docTypeName = 'Document', operation = 'unknown') {
    // Required fields for common DocTypes when dynamic schema is unavailable
    const DOCTYPE_REQUIRED_FIELDS = {
      'Customer': {
        required: ['customer_name'],
        properties: {
          customer_name: { type: 'string', description: 'Name of the customer (required)' },
          customer_type: { type: 'string', enum: ['Company', 'Individual'], default: 'Company' },
          customer_group: { type: 'string', default: 'All Customer Groups' },
          territory: { type: 'string', default: 'All Territories' }
        }
      },
      'Item': {
        required: ['item_code', 'item_name'],
        properties: {
          item_code: { type: 'string', description: 'Unique code for the item (required)' },
          item_name: { type: 'string', description: 'Name of the item (required)' },
          item_group: { type: 'string', description: 'Item group classification' },
          stock_uom: { type: 'string', default: 'Nos' }
        }
      },
      'Supplier': {
        required: ['supplier_name'],
        properties: {
          supplier_name: { type: 'string', description: 'Name of the supplier (required)' },
          supplier_group: { type: 'string', default: 'All Supplier Groups' }
        }
      },
      'Sales Invoice': {
        required: ['customer'],
        properties: {
          customer: { type: 'string', description: 'Customer name (required)' },
          items: { type: 'array', description: 'Invoice line items' }
        }
      },
      'Sales Order': {
        required: ['customer'],
        properties: {
          customer: { type: 'string', description: 'Customer name (required)' },
          items: { type: 'array', description: 'Order line items' }
        }
      },
      'Project': {
        required: ['project_name'],
        properties: {
          project_name: { type: 'string', description: 'Project name (required)' }
        }
      },
      'Task': {
        required: ['subject'],
        properties: {
          subject: { type: 'string', description: 'Task subject (required)' },
          project: { type: 'string', description: 'Parent project' }
        }
      }
    };

    const docTypeConfig = DOCTYPE_REQUIRED_FIELDS[docTypeName];

    // Return a basic schema based on operation type
    switch (operation) {
      case 'create':
        if (docTypeConfig) {
          return {
            type: 'object',
            properties: docTypeConfig.properties,
            required: docTypeConfig.required,
            description: `Create a new ${docTypeName} in ERPNext`
          };
        }
        return {
          type: 'object',
          properties: {
            doctype: {
              type: 'string',
              description: 'The DocType to create',
              default: docTypeName !== 'Document' ? docTypeName : undefined
            },
            data: {
              type: 'object',
              description: `Field values for the new ${docTypeName}`
            }
          },
          required: docTypeName === 'Document' ? ['doctype', 'data'] : ['data'],
          description: `Create a new ${docTypeName} in ERPNext. Please connect your ERPNext for full schema.`
        };

      case 'update':
        return {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: `The name/ID of the ${docTypeName} to update`
            },
            data: {
              type: 'object',
              description: 'Field values to update'
            }
          },
          required: ['name'],
          description: `Update a ${docTypeName} in ERPNext`
        };

      case 'get':
      case 'delete':
        return {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: `The name/ID of the ${docTypeName}`
            }
          },
          required: ['name'],
          description: `${operation === 'get' ? 'Get' : 'Delete'} a ${docTypeName} from ERPNext`
        };

      case 'list':
        return {
          type: 'object',
          properties: {
            limit: { type: 'integer', default: 20 },
            filters: { type: 'object' },
            fields: { type: 'array', items: { type: 'string' } }
          },
          required: [],
          description: `List ${docTypeName} documents from ERPNext`
        };

      default:
        return {
          type: 'object',
          properties: {},
          required: [],
          description: `Frappe action: ${actionName}`
        };
    }
  }

  _extractDefaults(schema) {
    // JSON Schema defaults can appear in properties[field].default
    const out = {};
    const props = schema?.properties || {};
    for (const [k, spec] of Object.entries(props)) {
      if (spec && Object.prototype.hasOwnProperty.call(spec, "default")) {
        const value = spec.default;
        if (typeof value === "string" && value.trim() === "") {
          continue;
        }
        out[k] = value;
      }
    }
    return out;
  }

  // =============================================================================
  // NORMALIZATION
  // =============================================================================

  _normalizeTools(routerTools) {
    return routerTools
      .map((t, idx) => {
        // Handle both string format (from ToolRouter) and object format
        // String: 'GOOGLECALENDAR_EVENTS_LIST'
        // Object: {name: 'GOOGLECALENDAR_EVENTS_LIST', params: {...}}
        const isString = typeof t === "string";
        const name = isString ? t.trim() : String(t?.name || "").trim();
        const sequence = Number.isFinite(t?.sequence) ? t.sequence : idx + 1;
        const composio_action = isString ? t.trim() : (t?.composio_action || t?.composioAction || name);
        const params = (!isString && t?.params && typeof t.params === "object") ? { ...t.params } : {};
        const dependsOn = (!isString && Array.isArray(t?.dependsOn)) ? t.dependsOn.slice() : [];
        const usePreviousOutput = !isString && !!t?.usePreviousOutput;
        const injectFrom = (!isString && t?.injectFrom && typeof t.injectFrom === 'object')
          ? { ...t.injectFrom }
          : null;

        return {
          id: isString ? `tool_${sequence}_${t.trim()}` : (t?.id || `tool_${sequence}_${name}`),
          name,
          sequence,
          composio_action,
          params,
          dependsOn,
          usePreviousOutput,
          injectFrom,
        };
      })
      .filter((t) => t.name);
  }

  // =============================================================================
  // DATE/TIME CONTEXT (timezone-aware hints)
  // =============================================================================

  _nowContext(timeZone = this.USER_TZ) {
    const now = new Date();
    const today = this._formatDateInTz(now, timeZone);
    const tomorrow = this._formatDateInTz(new Date(now.getTime() + 86400000), timeZone);
    const yesterday = this._formatDateInTz(new Date(now.getTime() - 86400000), timeZone);
    const offset = this._getOffsetForTimeZone(now, timeZone);

    // We keep ISO UTC too for reference, but we instruct model to output RFC3339 with tz.
    const nowRfc3339 = now.toISOString().replace(".000", "Z"); // already Z

    return { today, tomorrow, yesterday, offset, nowRfc3339 };
  }

  _formatDateInTz(date, timeZone) {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return dtf.format(date); // YYYY-MM-DD
  }

  _getOffsetForTimeZone(date, timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        timeZoneName: "shortOffset",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(date);
      const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "";
      const m = tzPart.match(/GMT([+\-]\d{1,2})(?::?(\d{2}))?/i);
      if (m) {
        const rawH = parseInt(m[1], 10);
        const sign = rawH < 0 ? "-" : "+";
        const hh = String(Math.abs(rawH)).padStart(2, "0");
        const mm = String(m[2] ? parseInt(m[2], 10) : 0).padStart(2, "0");
        return `${sign}${hh}:${mm}`;
      }
    } catch (_) { }
    // fallback to server offset
    const offMin = -date.getTimezoneOffset();
    const sign = offMin >= 0 ? "+" : "-";
    const abs = Math.abs(offMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${sign}${hh}:${mm}`;
  }

  // =============================================================================
  // INTELLIGENT DEFAULTS HELPERS
  // =============================================================================

  /**
   * Find a datetime field that has a value in the params, matching against candidate names.
   */
  _findDateTimeField(params, props, candidates) {
    for (const candidate of candidates) {
      if (params[candidate] && props[candidate]?.format === "date-time") {
        return candidate;
      }
    }
    // Fallback: look for any matching field with a value
    for (const candidate of candidates) {
      if (params[candidate]) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Find the name of an end datetime field from the schema.
   */
  _findDateTimeFieldName(props, candidates) {
    for (const candidate of candidates) {
      if (props[candidate]) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Calculate end datetime by adding minutes to a start datetime string.
   * @param {string} startDateTime - RFC3339 datetime string
   * @param {number} durationMinutes - Duration in minutes to add
   * @returns {string|null} - RFC3339 datetime string for end time
   */
  _calculateEndTime(startDateTime, durationMinutes) {
    if (!startDateTime || typeof startDateTime !== "string") return null;

    try {
      // Parse the start datetime
      const start = new Date(startDateTime);
      if (isNaN(start.getTime())) return null;

      // Add duration
      const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

      // Preserve the timezone offset from the original
      const tzMatch = startDateTime.match(/([zZ]|[+\-]\d{2}:\d{2})$/);
      const offset = tzMatch ? tzMatch[1] : this._getOffsetForTimeZone(end, this.USER_TZ);

      // Format as RFC3339
      const y = end.getFullYear();
      const mo = String(end.getMonth() + 1).padStart(2, "0");
      const d = String(end.getDate()).padStart(2, "0");
      const h = String(end.getHours()).padStart(2, "0");
      const mi = String(end.getMinutes()).padStart(2, "0");
      const s = String(end.getSeconds()).padStart(2, "0");

      return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
    } catch (e) {
      console.warn("[UnifiedSlotFiller] Failed to calculate end time:", e.message);
      return null;
    }
  }

  // =============================================================================
  // REGEX HINTS
  // =============================================================================

  _regexHints(text) {
    const emails = (text.match(this.RX_EMAIL) || []).map((e) => e.trim());
    const urls = (text.match(this.RX_URL) || []).map((u) => u.trim());
    return { emails: [...new Set(emails)], urls: [...new Set(urls)] };
  }

  // =============================================================================
  // JSON PARSING
  // =============================================================================

  _parseJson(raw) {
    if (!raw) return null;
    let s = String(raw).trim();

    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) s = fenced[1].trim();

    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first !== -1 && last !== -1) s = s.slice(first, last + 1);

    try {
      return JSON.parse(s);
    } catch (_) {
      return null;
    }
  }

  // =============================================================================
  // RESULT FORMAT
  // =============================================================================

  _buildResult(session, extra = {}) {
    return {
      sessionId: session.sessionId,
      state: session.state,
      actionName: "MULTI_TOOL_CHAIN",
      questionRound: session.questionRound,
      filledByToolId: session.filledByToolId,
      missingRequired: (session.requiredMissing || []).map((m) => ({
        tool: m.toolName,
        toolId: m.toolId,
        field: m.field,
        reason: m.reason,
      })),
      tools: this._buildToolsToExecute(session),
      ...extra,
    };
  }
}

module.exports = UnifiedSlotFiller;

/**
 * -----------------------------------------------------------------------------
 * INTEGRATION (ToolRouter -> SlotFiller)
 * -----------------------------------------------------------------------------
 *
 * const ToolRouter = require('./ToolRouter');
 * const UnifiedSlotFiller = require('./UnifiedSlotFiller');
 *
 * const router = new ToolRouter({ composioToolSet, callGemini });
 * const slotFiller = new UnifiedSlotFiller({ composioToolSet, callGemini, options: { userTimeZone: 'America/New_York' }});
 *
 * // 1) First user message
 * const routing = await router.route(message, enabledToolkits, { ...ctx, originalMessage: message });
 * const sessionId = `sf_${Date.now()}`;
 * await slotFiller.startSession(sessionId, routing, { ...ctx, originalMessage: message });
 * const res1 = await slotFiller.process(sessionId);
 * if (res1.action === 'ASK_QUESTION') return { reply: res1.contextMessage ? `${res1.contextMessage}\n\n${res1.question}` : res1.question, sessionId };
 * if (res1.action === 'COMPLETE') return { execute: res1.toolsToExecute, sessionId };
 *
 * // 2) Follow-up user response
 * const res2 = await slotFiller.process(sessionId, userReply);
 * ...
 * -----------------------------------------------------------------------------
 */
