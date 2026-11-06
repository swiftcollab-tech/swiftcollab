/**
 * ToolRouter - Production-hardened Composio router with integrated Preflight
 *
 * Works with: Jira, Asana, Trello, Gmail, Slack, Calendar, Zoom, Frappe, and any Composio app
 *
 * Features:
 * ✅ 2-stage routing (small prompt → select tools; then schema prompt → extract params)
 * ✅ Deterministic required-field detection using schema.required
 * ✅ Schema-based injection targeting
 * ✅ Timezone-safe datetime enforcement
 * ✅ Strict tool-name matching + one-shot repair
 * ✅ INTEGRATED PREFLIGHT: Auto-fills params by discovering list actions dynamically
 * ✅ Pattern-based preflight config (not hardcoded per-integration)
 * ✅ Frappe direct API support (non-Composio)
 * ✅ CONNECTION VALIDATION: Checks OAuth before execution
 * ✅ ENTITY RESOLUTION: Resolves names to emails, project names to keys
 *
 * Constructor:
 * new ToolRouter({ composioToolSet, callGemini, frappeService?, query?, options? })
 */

class ToolRouter {
  constructor({ composioToolSet, connectorService = null, callGemini, frappeService = null, query = null, options = {} }) {
    if (!composioToolSet) throw new Error("composioToolSet required");
    if (!callGemini) throw new Error("callGemini required");

    this.composioToolSet = composioToolSet;
    this.connectorService = connectorService;
    this.callGemini = callGemini;
    this.frappeService = frappeService;
    this.query = query; // Database query function for entity resolution

    // Cache Composio tools per (entityId + toolkits set)
    this.toolCache = new Map();
    this.CACHE_TTL = options.cacheTtlMs ?? 5 * 60 * 1000;

    // Preflight cache (avoid duplicate API calls within same session)
    this.preflightCache = new Map();
    this.PREFLIGHT_CACHE_TTL = options.preflightCacheTtlMs ?? 60 * 1000;

    // Connection cache
    this.connectionCache = new Map();
    this.CONNECTION_CACHE_TTL = options.connectionCacheTtlMs ?? 2 * 60 * 1000;

    // Entity resolution cache
    this.entityCache = new Map();
    this.ENTITY_CACHE_TTL = options.entityCacheTtlMs ?? 5 * 60 * 1000;

    // Safety limits
    this.MAX_TOOLS_PER_TOOLKIT = options.maxToolsPerToolkit ?? 80;
    this.MAX_ROUTER_CANDIDATES = options.maxRouterCandidates ?? 30;
    this.MAX_RELEVANT_TOOLKITS = options.maxRelevantToolkits ?? 10;
    this.MAX_ENABLED_TOOLKITS = Number.isFinite(options.maxEnabledToolkits)
      ? options.maxEnabledToolkits
      : null;

    // User timezone for prompt context
    this.USER_TIMEZONE = options.userTimeZone ?? "America/New_York";

    // Toolkit to app name mapping for connection validation
    this.TOOLKIT_TO_APP = {
      JIRA: "jira",
      GMAIL: "gmail",
      GOOGLECALENDAR: "googlecalendar",
      SLACK: "slack",
      GITHUB: "github",
      HUBSPOT: "hubspot",
      TRELLO: "trello",
      ASANA: "asana",
      NOTION: "notion",
      ZOOM: "zoom",
      MICROSOFTTEAMS: "microsoftteams",
      OUTLOOK: "outlook",
      SALESFORCE: "salesforce",
      LINEAR: "linear",
      DISCORD: "discord",
      DROPBOX: "dropbox",
      GOOGLE_DRIVE: "googledrive",
      AIRTABLE: "airtable",
      MONDAY: "monday",
      CLICKUP: "clickup",
      TODOIST: "todoist",
      ZENDESK: "zendesk",
      INTERCOM: "intercom",
      STRIPE: "stripe",
      SHOPIFY: "shopify",
      // Frappe is direct API, not OAuth
      FRAPPE: null,
    };

    // Preflight config: pattern-based discovery
    this.PREFLIGHT_CONFIG = this._buildPreflightConfig(options.preflightConfig);

    // Entity resolution config
    this.ENTITY_CONFIG = this._buildEntityConfig(options.entityConfig);

    // Ajv (optional)
    this.ajv = this._buildAjv();
  }

  // ===========================================================================
  // PREFLIGHT CONFIG: Pattern-based discovery
  // ===========================================================================

  _buildPreflightConfig(customConfig = {}) {
    const defaults = {
      project: {
        paramPatterns: [/project[_-]?(key|id)?$/i, /^project$/i],
        listActionPatterns: [
          /GET[_-]?ALL[_-]?PROJECTS/i,
          /LIST[_-]?PROJECTS/i,
          /GET[_-]?PROJECTS/i,
          /FETCH[_-]?PROJECTS/i,
        ],
        valueExtractor: (item) => item.key || item.id || item.project_key || item.projectKey,
        labelExtractor: (item) => item.name || item.title || item.key || item.id,
        autoSelectIfSingle: true,
        defaultValue: null,
      },

      workspace: {
        paramPatterns: [/workspace[_-]?(id)?$/i, /^workspace$/i, /space[_-]?(id)?$/i],
        listActionPatterns: [
          /LIST[_-]?WORKSPACES/i,
          /GET[_-]?WORKSPACES/i,
          /GET[_-]?ALL[_-]?WORKSPACES/i,
        ],
        valueExtractor: (item) => item.id || item.workspace_id || item.gid,
        labelExtractor: (item) => item.name || item.title || item.id,
        autoSelectIfSingle: true,
        defaultValue: null,
      },

      channel: {
        paramPatterns: [/channel[_-]?(id|name)?$/i, /^channel$/i, /conversation[_-]?id$/i],
        listActionPatterns: [
          /LIST[_-]?CHANNELS/i,
          /GET[_-]?CHANNELS/i,
          /LIST[_-]?CONVERSATIONS/i,
        ],
        valueExtractor: (item) => item.id || item.channel_id || item.name,
        labelExtractor: (item) => (item.name ? `#${item.name}` : item.id),
        autoSelectIfSingle: false,
        defaultValue: null,
      },

      board: {
        paramPatterns: [/board[_-]?(id)?$/i, /^board$/i],
        listActionPatterns: [/LIST[_-]?BOARDS/i, /GET[_-]?BOARDS/i, /GET[_-]?ALL[_-]?BOARDS/i],
        valueExtractor: (item) => item.id || item.board_id,
        labelExtractor: (item) => item.name || item.title || item.id,
        autoSelectIfSingle: true,
        defaultValue: null,
      },

      list: {
        paramPatterns: [/list[_-]?(id)?$/i, /^list$/i, /^idList$/i],
        listActionPatterns: [/LIST[_-]?LISTS/i, /GET[_-]?LISTS/i, /GET[_-]?BOARD[_-]?LISTS/i],
        valueExtractor: (item) => item.id || item.list_id,
        labelExtractor: (item) => item.name || item.title || item.id,
        autoSelectIfSingle: true,
        defaultValue: null,
      },

      calendar: {
        paramPatterns: [/calendar[_-]?(id)?$/i, /^calendar$/i],
        listActionPatterns: [
          /LIST[_-]?CALENDARS/i,
          /GET[_-]?CALENDARS/i,
          /GET[_-]?ALL[_-]?CALENDARS/i,
        ],
        valueExtractor: (item) => item.id || item.calendar_id,
        labelExtractor: (item) => item.summary || item.name || item.title || item.id,
        autoSelectIfSingle: false,
        defaultValue: "primary",
        selectPrimary: true,
        primaryDetector: (item) => item.primary === true || item.id === "primary",
      },

      repo: {
        paramPatterns: [/repo(sitory)?[_-]?(id|name)?$/i, /^repo$/i, /^owner$/i],
        listActionPatterns: [
          /LIST[_-]?REPOS/i,
          /LIST[_-]?REPOSITORIES/i,
          /GET[_-]?REPOS/i,
          /GET[_-]?USER[_-]?REPOS/i,
        ],
        valueExtractor: (item) => item.full_name || item.name || item.id,
        labelExtractor: (item) => item.full_name || item.name || item.id,
        autoSelectIfSingle: true,
        defaultValue: null,
      },

      team: {
        paramPatterns: [/team[_-]?(id)?$/i, /org(anization)?[_-]?(id)?$/i, /^team$/i],
        listActionPatterns: [
          /LIST[_-]?TEAMS/i,
          /GET[_-]?TEAMS/i,
          /LIST[_-]?ORGS/i,
          /LIST[_-]?ORGANIZATIONS/i,
        ],
        valueExtractor: (item) => item.id || item.team_id || item.gid,
        labelExtractor: (item) => item.name || item.title || item.id,
        autoSelectIfSingle: true,
        defaultValue: null,
      },

      meeting: {
        paramPatterns: [/meeting[_-]?(id|type)?$/i, /^type$/i],
        listActionPatterns: [
          /LIST[_-]?MEETINGS/i,
          /GET[_-]?MEETINGS/i,
          /LIST[_-]?MEETING[_-]?TYPES/i,
        ],
        valueExtractor: (item) => item.id || item.type || item.meeting_id,
        labelExtractor: (item) => item.topic || item.name || item.type || item.id,
        autoSelectIfSingle: false,
        defaultValue: 2,
      },

      assignee: {
        paramPatterns: [
          /assignee[_-]?(id)?$/i,
          /^assignee$/i,
          /user[_-]?id$/i,
          /^accountId$/i,
        ],
        listActionPatterns: [
          /LIST[_-]?USERS/i,
          /GET[_-]?USERS/i,
          /GET[_-]?PROJECT[_-]?MEMBERS/i,
          /LIST[_-]?MEMBERS/i,
          /SEARCH[_-]?USERS/i,
        ],
        valueExtractor: (item) => item.accountId || item.id || item.user_id || item.gid,
        labelExtractor: (item) => item.displayName || item.name || item.email || item.id,
        autoSelectIfSingle: false,
        defaultValue: null,
      },

      label: {
        paramPatterns: [/label[_-]?(id|s)?$/i, /tag[_-]?(id|s)?$/i, /^labels$/i, /^tags$/i],
        listActionPatterns: [/LIST[_-]?LABELS/i, /GET[_-]?LABELS/i, /LIST[_-]?TAGS/i],
        valueExtractor: (item) => item.id || item.name,
        labelExtractor: (item) => item.name || item.title || item.id,
        autoSelectIfSingle: false,
        defaultValue: null,
      },

      issueType: {
        paramPatterns: [/issue[_-]?type[_-]?(id|name)?$/i, /^issuetype$/i],
        listActionPatterns: [
          /GET[_-]?ISSUE[_-]?TYPES/i,
          /LIST[_-]?ISSUE[_-]?TYPES/i,
          /GET[_-]?CREATE[_-]?ISSUE[_-]?METADATA/i,
        ],
        valueExtractor: (item) => item.name || item.id,
        labelExtractor: (item) => item.name || item.id,
        autoSelectIfSingle: false,
        defaultValue: "Task",
      },

      priority: {
        paramPatterns: [/priority[_-]?(id|name)?$/i, /^priority$/i],
        listActionPatterns: [/GET[_-]?PRIORITIES/i, /LIST[_-]?PRIORITIES/i],
        valueExtractor: (item) => item.name || item.id,
        labelExtractor: (item) => item.name || item.id,
        autoSelectIfSingle: false,
        defaultValue: "Medium",
      },

      doctype: {
        paramPatterns: [/doc[_-]?type$/i, /^doctype$/i],
        listActionPatterns: [],
        valueExtractor: (item) => item.name || item,
        labelExtractor: (item) => item.name || item,
        autoSelectIfSingle: false,
        defaultValue: null,
        isFrappe: true,
        frappeListMethod: "getDoctypes",
      },
    };

    return { ...defaults, ...customConfig };
  }

  // ===========================================================================
  // ENTITY RESOLUTION CONFIG
  // ===========================================================================

  _buildEntityConfig(customConfig = {}) {
    const defaults = {
      // Patterns to detect entity references in user message
      personPatterns: [
        // "send to John", "email John", "meeting with John"
        /(?:send|email|mail|message|invite|meet(?:ing)?|call|contact|notify|ping|slack|dm)\s+(?:to\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
        // "John's email", "for John"
        /(?:for|with|to|cc|bcc)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi,
      ],

      // Common name patterns to exclude (not person names)
      excludePatterns: [
        /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i,
        /^(January|February|March|April|May|June|July|August|September|October|November|December)$/i,
        /^(Today|Tomorrow|Yesterday|Morning|Afternoon|Evening|Night)$/i,
        /^(Jira|Slack|Gmail|Calendar|Zoom|Trello|Asana|Github|Meeting|Email|Task|Ticket|Issue|Project)$/i,
      ],

      // Fields that typically need person/email resolution
      emailFields: ["to", "cc", "bcc", "recipient", "recipients", "attendees", "attendee", "invitees"],

      // Fields that might need project resolution
      projectFields: ["project_key", "project_id", "project", "projectKey"],
    };

    return { ...defaults, ...customConfig };
  }

  // ===========================================================================
  // MAIN ROUTE METHOD
  // ===========================================================================

  async route(message, enabledToolkits = [], context = {}) {
    const startTime = Date.now();
    const trimmedToolkits = this.MAX_ENABLED_TOOLKITS
      ? (enabledToolkits || []).slice(0, this.MAX_ENABLED_TOOLKITS)
      : (enabledToolkits || []);

    // Fast-path: user is asking about integration/connection status
    if (this._looksLikeConnectionStatusQuery(message)) {
      return {
        success: true,
        tools: [
          {
            name: "SYSTEM_CHECK_CONNECTIONS",
            params: {},
            composio_action: "SYSTEM_CHECK_CONNECTIONS",
            sequence: 1,
          },
        ],
        isMultiTool: false,
        needsMoreInfo: false,
        needsConnection: false,
        missingParams: [],
        clarificationQuestion: null,
        chatResponse: null,
        _preflight: null,
        _connections: null,
      };
    }

    // Only connected applications may contribute tools. This is enforced on
    // the server even if a browser sends stale or manipulated selections.
    const connectedToolkits = await this._connectedToolkits(trimmedToolkits, context);
    if (connectedToolkits.length === 0) {
      return this._chatRoutingResult(
        'I could not find a connected app for that request. Connect the app first, then try again.'
      );
    }

    // With many connected apps, first select app categories using only their
    // names. This keeps hundreds of unrelated action schemas away from the LLM.
    const relevantToolkits = await this._selectRelevantToolkits(
      message,
      connectedToolkits,
      context
    );

    // Fetch schemas only after intent gating and connected-app filtering.
    const allConnectedTools = await this.getToolsFromComposio(relevantToolkits, context.entityId, context);
    const availableTools = this._shortlistTools(message, allConnectedTools);

    console.log(
      "[ToolRouter] Routing message:",
      String(message || "").substring(0, 80) + (String(message || "").length > 80 ? "..." : "")
    );
    console.log(
      "[ToolRouter] Available tools:",
      availableTools.length,
      "tools from",
      relevantToolkits.join(", "),
      `(shortlisted from ${allConnectedTools.length})`
    );

    // 1) Resolve high-confidence intents deterministically; use the model for
    // ambiguous and multi-step planning only.
    const stageA = this._deterministicToolSelection(message, availableTools) ||
      await this._stageA_selectTools({ message, availableTools, context });

    // Chat-only response
    if (stageA.selectedTools.length === 1 && stageA.selectedTools[0].name === "chat_response") {
      return {
        success: true,
        tools: [
          {
            name: "chat_response",
            params: { response_type: "general" },
            composio_action: null,
            sequence: 1,
          },
        ],
        isMultiTool: false,
        needsMoreInfo: false,
        needsConnection: false,
        missingParams: [],
        clarificationQuestion: null,
        chatResponse: stageA.chatResponse || null,
        _preflight: null,
        _connections: null,
      };
    }

    // Strict tool matching + one-shot repair if needed
    const validToolNames = new Set(availableTools.map((t) => t.name));
    const invalid = stageA.selectedTools.filter((t) => !validToolNames.has(t.name));
    if (invalid.length > 0) {
      const repaired = await this._stageA_repairInvalidTools({
        message,
        availableTools,
        context,
        invalidTools: invalid.map((t) => t.name),
      });

      if (repaired?.selectedTools?.length) {
        stageA.selectedTools = repaired.selectedTools.filter((t) => validToolNames.has(t.name));
        stageA.chatResponse = repaired.chatResponse || stageA.chatResponse;
      }

      const stillInvalid = stageA.selectedTools.filter((t) => !validToolNames.has(t.name));
      if (stillInvalid.length > 0 || stageA.selectedTools.length === 0) {
        const top = availableTools
          .filter((t) => t.name !== "chat_response")
          .slice(0, 12)
          .map((t) => t.name);

        return {
          success: false,
          error: `Invalid tool(s): ${stillInvalid.map((t) => t.name).join(", ")}`,
          tools: [
            {
              name: "chat_response",
              params: { response_type: "general" },
              composio_action: null,
              sequence: 1,
            },
          ],
          isMultiTool: false,
          needsMoreInfo: true,
          needsConnection: false,
          missingParams: [],
          clarificationQuestion: `I can't access that tool action. Pick one of these instead: ${top.join(", ")}`,
          chatResponse: null,
          _preflight: null,
          _connections: null,
        };
      }
    }

    // =========================================================================
    // 2) CONNECTION VALIDATION - Check OAuth before proceeding
    // =========================================================================
    const connectionResult = await this._validateConnections({
      selectedTools: stageA.selectedTools,
      entityId: context.entityId,
      context,
    });

    if (connectionResult.needsConnection) {
      return {
        success: false,
        needsConnection: true,
        missingConnection: connectionResult.missingToolkit,
        authUrl: connectionResult.authUrl,
        tools: stageA.selectedTools.map((t, i) => ({
          name: t.name,
          params: {},
          composio_action: t.name,
          sequence: t.sequence || i + 1,
        })),
        isMultiTool: stageA.selectedTools.length > 1,
        needsMoreInfo: false,
        missingParams: [],
        clarificationQuestion: connectionResult.message,
        chatResponse: null,
        _preflight: null,
        _connections: connectionResult,
      };
    }

    // 3) Fetch schemas ONLY for selected tools
    const selectedSchemas = this._getSelectedSchemas(stageA.selectedTools, availableTools);

    // 4) Stage B: extract params with selected schemas only
    const stageB = await this._stageB_extractParams({
      message,
      selectedSchemas,
      context,
      stageA,
    });

    // 5) Apply schema-based injection targeting
    const toolsWithInjection = this._applySchemaBasedInjection(stageB.tools, selectedSchemas);

    // 5b) Auto-detect and enforce data dependencies for multi-action workflows
    const toolsWithDependencies = this._enforceDataDependencies(toolsWithInjection, selectedSchemas, message);

    // =========================================================================
    // 6) ENTITY RESOLUTION - Resolve names to emails before preflight
    // =========================================================================
    const entityResult = await this._resolveEntities({
      tools: toolsWithDependencies,
      selectedSchemas,
      message,
      context,
    });

    const toolsWithEntities = this._mergeEntityResults(toolsWithDependencies, entityResult);

    // =========================================================================
    // 7) PREFLIGHT: Auto-fill params
    // =========================================================================
    const preflightResult = await this._runPreflight({
      tools: toolsWithEntities,
      selectedSchemas,
      availableTools,
      context,
      message,
      connections: connectionResult.connections,
    });

    const toolsWithPreflight = this._mergePreflightResults(toolsWithEntities, preflightResult);

    // 8) Deterministic validation + missing required fields
    const validation = this._validateAgainstSchemas(toolsWithPreflight, selectedSchemas);

    // Build result
    const result = {
      success: true,
      tools: validation.tools,
      isMultiTool: validation.tools.length > 1,
      needsMoreInfo: validation.missing.length > 0,
      needsConnection: false,
      missingParams: validation.missing.map((m) => `${m.tool}.${m.field}`),
      clarificationQuestion: null,
      chatResponse: stageA.chatResponse || stageB.chatResponse || null,
      _preflight: {
        autoFilled: preflightResult.autoFilled,
        availableOptions: preflightResult.availableOptions,
        suggestions: preflightResult.suggestions,
      },
      _entities: {
        resolved: entityResult.resolved,
        unresolved: entityResult.unresolved,
      },
      _connections: connectionResult,
    };

    // Enhance clarification with preflight options
    if (result.needsMoreInfo) {
      result.clarificationQuestion = this._buildClarificationQuestion(
        validation.missing,
        preflightResult.availableOptions
      );
    }

    // Sort tools by sequence
    result.tools.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

    console.log(`[ToolRouter] Routed in ${Date.now() - startTime}ms:`, {
      tools: result.tools.map((t) => t.name),
      isMultiTool: result.isMultiTool,
      needsMoreInfo: result.needsMoreInfo,
      missing: result.missingParams?.slice(0, 10) || [],
      autoFilled: Object.keys(preflightResult.autoFilled),
      entitiesResolved: entityResult.resolved.length,
    });

    return result;
  }

  // ===========================================================================
  // CONNECTION VALIDATION
  // ===========================================================================

  _chatRoutingResult(chatResponse) {
    return {
      success: true,
      tools: [{
        name: 'chat_response',
        params: { response_type: 'general' },
        composio_action: null,
        sequence: 1,
      }],
      isMultiTool: false,
      needsMoreInfo: false,
      needsConnection: false,
      missingParams: [],
      clarificationQuestion: null,
      chatResponse,
      _preflight: null,
      _connections: null,
    };
  }

  async _connectedToolkits(requestedToolkits, context = {}) {
    const requested = [...new Set((requestedToolkits || []).map(value => String(value).toUpperCase()))];
    const composioRequested = requested.filter(toolkit => toolkit !== 'FRAPPE');
    const allowed = new Set();
    let discovered = [];

    if (context.entityId) {
      const connectedApps = await this.composioToolSet.getConnectedApps(context.entityId);
      const connected = new Set((connectedApps || []).map(app => String(app.toolkit || '').toUpperCase()));
      discovered = [...connected];
      for (const toolkit of composioRequested) {
        if (connected.has(toolkit)) allowed.add(toolkit);
      }
    }

    // Native connectors participate in the same routing decision. Only
    // adapters with implemented action execution are advertised here; a
    // connection-only adapter must not cause the router to choose tools it
    // cannot execute.
    if (this.connectorService && context.organizationId) {
      const nativeCandidates = requested.length > 0
        ? requested.filter(toolkit => toolkit !== 'FRAPPE')
        : this.connectorService.listCatalog()
          .filter(item => item.providers?.direct?.status === 'available')
          .map(item => item.toolkit);
      for (const toolkit of nativeCandidates) {
        if (!this.connectorService.canExecuteDirect(toolkit)) continue;
        try {
          const direct = await this.connectorService.getDirectStatus({
            appId: toolkit,
            organizationId: context.organizationId,
            userId: context.userId,
          });
          if (direct.connected) {
            allowed.add(toolkit);
            discovered.push(toolkit);
          }
        } catch (error) {
          console.warn(`[ToolRouter] Unable to verify native ${toolkit} connection:`, error.message);
        }
      }
    }

    if (requested.length === 0 || requested.includes('FRAPPE')) {
      try {
        if (await this._hasConnectedFrappe(context)) {
          if (requested.length === 0) discovered.push('FRAPPE');
          else allowed.add('FRAPPE');
        }
      } catch (error) {
        console.warn('[ToolRouter] Unable to verify Frappe connection:', error.message);
      }
    }

    if (requested.length === 0) return [...new Set(discovered)];

    const filtered = requested.filter(toolkit => allowed.has(toolkit));
    const omitted = requested.filter(toolkit => !allowed.has(toolkit));
    if (omitted.length > 0) {
      console.log(`[ToolRouter] Ignoring unconnected toolkits: ${omitted.join(', ')}`);
    }
    return filtered;
  }

  async _hasConnectedFrappe(context = {}) {
    const { frappeConnectionManager } = require('../integrations/frappe');
    const userId = context.userId || this._extractUserId(context.entityId);
    const perUserConnected = userId
      ? await frappeConnectionManager.hasActiveConnection(userId)
      : false;
    return perUserConnected || Boolean(this.frappeService?.isConfigured?.());
  }

  _toolkitSearchTerms(toolkit) {
    const normalized = String(toolkit || '').toUpperCase();
    const aliases = {
      GOOGLECALENDAR: ['google calendar', 'calendar', 'meeting', 'event', 'reminder'],
      GMAIL: ['gmail', 'email', 'mail'],
      OUTLOOK: ['outlook', 'email', 'calendar', 'meeting'],
      GITHUB: ['github', 'repository', 'repo', 'pull request', 'commit'],
      GITLAB: ['gitlab', 'repository', 'repo', 'merge request', 'commit'],
      BITBUCKET: ['bitbucket', 'repository', 'repo', 'pull request'],
      SLACK: ['slack', 'channel', 'message'],
      MICROSOFTTEAMS: ['microsoft teams', 'teams', 'channel', 'meeting'],
      DISCORD: ['discord', 'channel', 'message'],
      JIRA: ['jira', 'issue', 'ticket', 'bug', 'story'],
      LINEAR: ['linear', 'issue', 'ticket'],
      ASANA: ['asana', 'task', 'project'],
      TRELLO: ['trello', 'board', 'card'],
      CLICKUP: ['clickup', 'task', 'project'],
      NOTION: ['notion', 'page', 'database', 'document'],
      GOOGLEDRIVE: ['google drive', 'drive', 'file', 'document'],
      GOOGLEDOCS: ['google docs', 'document'],
      DROPBOX: ['dropbox', 'file'],
      HUBSPOT: ['hubspot', 'contact', 'deal', 'company'],
      SALESFORCE: ['salesforce', 'lead', 'contact', 'opportunity', 'account'],
      ZENDESK: ['zendesk', 'support ticket', 'ticket'],
      ZOOM: ['zoom', 'meeting', 'call'],
      FRAPPE: ['frappe', 'erpnext', 'customer', 'invoice', 'sales order'],
    };
    return [normalized.toLowerCase().replaceAll('_', ' '), ...(aliases[normalized] || [])];
  }

  _toolkitBrandTerms(toolkit) {
    const normalized = String(toolkit || '').toUpperCase();
    const brands = {
      GOOGLECALENDAR: ['google calendar'],
      GMAIL: ['gmail'],
      OUTLOOK: ['outlook'],
      GITHUB: ['github'],
      GITLAB: ['gitlab'],
      BITBUCKET: ['bitbucket'],
      SLACK: ['slack'],
      MICROSOFTTEAMS: ['microsoft teams', 'teams'],
      DISCORD: ['discord'],
      JIRA: ['jira'],
      LINEAR: ['linear'],
      ASANA: ['asana'],
      TRELLO: ['trello'],
      CLICKUP: ['clickup'],
      NOTION: ['notion'],
      GOOGLEDRIVE: ['google drive'],
      GOOGLEDOCS: ['google docs'],
      DROPBOX: ['dropbox'],
      HUBSPOT: ['hubspot'],
      SALESFORCE: ['salesforce'],
      ZENDESK: ['zendesk'],
      ZOOM: ['zoom'],
      FRAPPE: ['frappe', 'erpnext'],
    };
    return brands[normalized] || [normalized.toLowerCase().replaceAll('_', ' ')];
  }

  _uniqueCapabilityMatches(message, connectedToolkits) {
    const groups = [
      { pattern: /\b(email|mail|send an? email)\b/i, toolkits: ['GMAIL', 'OUTLOOK', 'SENDGRID'] },
      { pattern: /\b(calendar|schedule|meeting|event|remind|reminder)\b/i, toolkits: ['GOOGLECALENDAR', 'OUTLOOK', 'ZOOM'] },
      { pattern: /\b(repository|repo|pull request|merge request|commit)\b/i, toolkits: ['GITHUB', 'GITLAB', 'BITBUCKET'] },
      { pattern: /\b(channel|chat message|notify the team)\b/i, toolkits: ['SLACK', 'MICROSOFTTEAMS', 'DISCORD'] },
      { pattern: /\b(file|document|folder)\b/i, toolkits: ['GOOGLEDRIVE', 'GOOGLEDOCS', 'DROPBOX', 'NOTION'] },
    ];
    const connected = new Set(connectedToolkits);
    const matches = [];
    for (const group of groups) {
      if (!group.pattern.test(message)) continue;
      const candidates = group.toolkits.filter(toolkit => connected.has(toolkit));
      if (candidates.length === 1) matches.push(candidates[0]);
    }
    return matches;
  }

  async _selectRelevantToolkits(message, connectedToolkits, context = {}) {
    const connected = [...new Set((connectedToolkits || []).map(value => String(value).toUpperCase()))];
    if (connected.length <= 1) return connected;

    const text = String(message || '').toLowerCase();
    const explicitMatches = connected.filter(toolkit =>
      this._toolkitBrandTerms(toolkit).some(term => term && text.includes(term))
    );
    const deterministicMatches = [...new Set([
      ...explicitMatches,
      ...this._uniqueCapabilityMatches(message, connected),
    ])];

    // Explicit cross-app requests are deterministic and require no extra LLM call.
    if (deterministicMatches.length > 0) {
      return deterministicMatches.slice(0, this.MAX_RELEVANT_TOOLKITS);
    }

    const systemPrompt = `Select the connected SwiftCollab apps needed for this work request.
Connected app toolkits: ${JSON.stringify(connected)}
Return JSON only: {"toolkits":["EXACT_TOOLKIT_NAME"]}
Choose only connected names. Usually choose 1-3 apps. Include multiple apps only when the request transfers data or performs actions across them.`;

    try {
      const response = await this.callGemini(systemPrompt, message, 0);
      const parsed = this._parseJson(response) || {};
      const allowed = new Set(connected);
      const selected = [...new Set((parsed.toolkits || [])
        .map(value => String(value || '').toUpperCase())
        .filter(value => allowed.has(value)))];
      if (selected.length > 0) return selected.slice(0, this.MAX_RELEVANT_TOOLKITS);
    } catch (error) {
      console.warn('[ToolRouter] App selection model failed:', error.message);
    }

    // Safe fallback: keep a small set instead of expanding every connected app.
    console.warn('[ToolRouter] Could not identify a specific app; using a limited connected-app fallback');
    return connected.slice(0, Math.min(3, this.MAX_RELEVANT_TOOLKITS));
  }

  _shortlistTools(message, tools) {
    const systemTools = tools.filter(tool => ['chat_response', 'SYSTEM_CHECK_CONNECTIONS'].includes(tool.name));
    const candidates = tools.filter(tool => !systemTools.includes(tool));
    if (candidates.length <= this.MAX_ROUTER_CANDIDATES) return tools;

    const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'from', 'in', 'on', 'of', 'my', 'our', 'please', 'and']);
    const tokens = String(message || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(token => token.length > 1 && !stopWords.has(token));

    const score = tool => {
      const haystack = `${tool.name || ''} ${tool.description || ''}`.toLowerCase().replaceAll('_', ' ');
      let value = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) value += tool.name?.toLowerCase().includes(token) ? 4 : 2;
      }
      if (/\b(list|show|find|search|get|fetch|read)\b/i.test(message) && /list|search|find|get|fetch|read/.test(haystack)) value += 3;
      if (/\b(create|add|new|set|schedule|remind)\b/i.test(message) && /create|add|schedule|event|remind/.test(haystack)) value += 3;
      if (/\b(update|edit|change)\b/i.test(message) && /update|edit/.test(haystack)) value += 3;
      if (/\b(delete|remove)\b/i.test(message) && /delete|remove/.test(haystack)) value += 3;
      return value;
    };

    const ranked = candidates
      .map((tool, index) => ({ tool, index, score: score(tool) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    // Reserve capacity for every relevant app. A global top-N can otherwise
    // fill entirely with one toolkit and break cross-app workflows.
    const toolkitCount = new Set(ranked.map(item => item.tool.toolkit).filter(Boolean)).size || 1;
    const perToolkitLimit = toolkitCount === 1 ? 10 : toolkitCount <= 3 ? 6 : 3;
    const perToolkitCounts = new Map();
    const balanced = [];
    for (const item of ranked) {
      const toolkit = item.tool.toolkit || 'UNKNOWN';
      const count = perToolkitCounts.get(toolkit) || 0;
      if (count >= perToolkitLimit) continue;
      balanced.push(item.tool);
      perToolkitCounts.set(toolkit, count + 1);
      if (balanced.length >= this.MAX_ROUTER_CANDIDATES) break;
    }

    return [...balanced, ...systemTools];
  }

  _deterministicToolSelection(message, availableTools) {
    const text = String(message || '');
    const isReminderRequest = /\b(remind|reminder|set|schedule|add|create)\b/i.test(text) &&
      /\b(tomorrow|today|tonight|calendar|meeting|event|remind|reminder|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i.test(text);
    if (!isReminderRequest) return null;

    const calendarCreate = (availableTools || []).find(tool => {
      const name = String(tool.name || '').toUpperCase();
      const description = String(tool.description || '').toLowerCase();
      return name.startsWith('GOOGLECALENDAR_') &&
        ((name.includes('CREATE') && name.includes('EVENT')) ||
          (description.includes('create') && description.includes('event')));
    });
    if (!calendarCreate) return null;

    return {
      selectedTools: [{
        name: calendarCreate.name,
        sequence: 1,
        usePreviousOutput: false,
      }],
      chatResponse: null,
      deterministic: true,
    };
  }

  async _validateConnections({ selectedTools, entityId, context = {} }) {
    const result = {
      needsConnection: false,
      connections: {},
      missingToolkit: null,
      authUrl: null,
      message: null,
    };

    if (!entityId) {
      return result; // Can't validate without entityId
    }

    // Determine which toolkits are needed
    const requiredToolkits = new Set();
    for (const tool of selectedTools) {
      const toolkit = this._inferToolkit(tool.name);
      if (toolkit && toolkit !== "SYSTEM" && toolkit !== "UNKNOWN") {
        requiredToolkits.add(toolkit);
      }
    }

    // Check each required toolkit
    for (const toolkit of requiredToolkits) {
      const appName = this.TOOLKIT_TO_APP[toolkit];

      // Special handling for Frappe - check actual connection
      if (appName === null && toolkit === 'FRAPPE') {
        try {
          // Check if we have per-user Frappe connection
          let frappeConnected = false;
          let frappeInfo = { direct: true };

          // Try to get frappeConnectionManager from require
          try {
            const { frappeConnectionManager } = require('../integrations/frappe');
            if (frappeConnectionManager && typeof frappeConnectionManager.hasActiveConnection === 'function') {
              const userId = this._extractUserId(entityId);
              frappeConnected = await frappeConnectionManager.hasActiveConnection(userId);
              if (frappeConnected) {
                frappeInfo.connectionType = 'per-user';
              }
            }
          } catch (e) {
            // frappeConnectionManager not available, check legacy frappeService
          }

          // Fallback to legacy global frappeService
          if (!frappeConnected && this.frappeService) {
            frappeConnected = !!this.frappeService.isConfigured?.();
            if (frappeConnected) {
              frappeInfo.connectionType = 'global';
            }
          }

          if (frappeConnected) {
            result.connections[toolkit] = { connected: true, ...frappeInfo };
          } else {
            result.needsConnection = true;
            result.missingToolkit = 'FRAPPE';
            result.message = 'Please connect your Frappe/ERPNext instance to continue. Go to Settings > Integrations to configure.';
            return result;
          }
        } catch (error) {
          console.warn(`[ToolRouter] Frappe connection check failed:`, error.message);
          // Don't assume connected for Frappe - explicit check is important
          result.needsConnection = true;
          result.missingToolkit = 'FRAPPE';
          result.message = 'Unable to verify Frappe connection. Please check your ERPNext configuration.';
          return result;
        }
        continue;
      }

      // Skip other null apps (if any future ones exist)
      if (appName === null) {
        result.connections[toolkit] = { connected: true, direct: true };
        continue;
      }

      if (!appName) {
        // Unknown toolkit, assume it works
        result.connections[toolkit] = { connected: true, unknown: true };
        continue;
      }

      if (this.connectorService?.canExecuteDirect(toolkit) && context.organizationId) {
        try {
          const direct = await this.connectorService.getDirectStatus({
            appId: toolkit,
            organizationId: context.organizationId,
            userId: context.userId,
          });
          if (direct.connected) {
            result.connections[toolkit] = { ...direct, direct: true };
            continue;
          }
        } catch (error) {
          console.warn(`[ToolRouter] Native ${toolkit} connection check failed:`, error.message);
        }
      }

      // Check cache first
      const cacheKey = `${entityId}:${toolkit}`;
      const cached = this._getConnectionCache(cacheKey);
      if (cached !== null) {
        if (cached.connected) {
          result.connections[toolkit] = cached;
          continue;
        } else {
          result.needsConnection = true;
          result.missingToolkit = toolkit;
          result.authUrl = cached.authUrl;
          result.message = `Please connect your ${toolkit} account to continue.`;
          return result;
        }
      }

      // Check connection via Composio
      try {
        const connectionStatus = await this._checkConnection(entityId, appName, toolkit);
        this._setConnectionCache(cacheKey, connectionStatus);

        if (connectionStatus.connected) {
          result.connections[toolkit] = connectionStatus;
        } else {
          result.needsConnection = true;
          result.missingToolkit = toolkit;
          result.authUrl = connectionStatus.authUrl;
          result.message = `Please connect your ${toolkit} account to continue.`;
          return result;
        }
      } catch (error) {
        console.warn(`[ToolRouter] Connection check failed for ${toolkit}:`, error.message);
        // Assume connected if check fails (better UX, will fail at execution if not)
        result.connections[toolkit] = { connected: true, assumedOnError: true };
      }
    }

    return result;
  }

  async _checkConnection(entityId, appName, toolkit) {
    try {
      // Method 1: Try getEntity().getConnection()
      if (typeof this.composioToolSet.getEntity === "function") {
        const entity = await this.composioToolSet.getEntity(entityId);
        if (entity && typeof entity.getConnection === "function") {
          const connection = await entity.getConnection({ app: appName });
          if (connection) {
            return {
              connected: true,
              connectionId: connection.id,
              appName,
            };
          }
        }
      }

      // Method 2: Try client.connectedAccounts
      if (this.composioToolSet.client?.connectedAccounts) {
        const accounts = await this.composioToolSet.client.connectedAccounts.list({
          user_uuid: entityId,
        });
        const account = accounts?.items?.find(
          (a) => a.appName?.toLowerCase() === appName.toLowerCase()
        );
        if (account) {
          return {
            connected: true,
            connectionId: account.id,
            appName,
          };
        }
      }

      // Method 3: Try ComposioService.listConnectedAccounts if available
      if (typeof this.composioToolSet.listConnectedAccounts === "function") {
        try {
          const accounts = await this.composioToolSet.listConnectedAccounts([toolkit], entityId);
          const isConnected = Array.isArray(accounts?.items) && accounts.items.length > 0;
          if (isConnected) {
            return { connected: true, verifiedByList: true, appName };
          }
          const authUrl = await this._getAuthUrl(entityId, appName);
          return { connected: false, authUrl, appName };
        } catch (err) {
          console.warn(`[ToolRouter] listConnectedAccounts failed for ${toolkit}:`, err.message);
        }
      }

      // Method 4: Try executing a simple read action to test connection
      const testActions = {
        jira: "JIRA_GET_PROJECTS",
        gmail: "GMAIL_FETCH_EMAILS",
        googlecalendar: "GOOGLECALENDAR_LIST_CALENDARS",
        slack: "SLACK_LIST_CHANNELS",
        github: "GITHUB_LIST_REPOS",
        trello: "TRELLO_LIST_BOARDS",
      };

      const testAction = testActions[appName];
      if (testAction) {
        try {
          const result = await this._executeComposioAction(testAction, {}, entityId);
          if (result?.success === false) {
            const msg = String(result?.error || result?.message || "").toLowerCase();
            if (msg.includes("not connected") || msg.includes("unauthorized") || msg.includes("authentication")) {
              const authUrl = await this._getAuthUrl(entityId, appName);
              return { connected: false, authUrl, appName };
            }
            return { connected: true, assumedOnError: true, appName };
          }
          return { connected: true, verifiedByAction: true, appName };
        } catch (e) {
          if (
            e.message?.includes("not connected") ||
            e.message?.includes("unauthorized") ||
            e.message?.includes("authentication")
          ) {
            // Definitely not connected
            const authUrl = await this._getAuthUrl(entityId, appName);
            return { connected: false, authUrl, appName };
          }
          // Other error, assume connected
          return { connected: true, assumedOnError: true, appName };
        }
      }

      // Default: assume connected
      return { connected: true, unverified: true, appName };
    } catch (error) {
      console.warn(`[ToolRouter] Connection check error for ${appName}:`, error.message);

      // Try to get auth URL anyway
      const authUrl = await this._getAuthUrl(entityId, appName);
      if (authUrl) {
        return { connected: false, authUrl, appName };
      }

      // Can't determine, assume connected
      return { connected: true, assumedOnError: true, appName };
    }
  }

  async _getAuthUrl(entityId, appName) {
    try {
      if (typeof this.composioToolSet.getEntity === "function") {
        const entity = await this.composioToolSet.getEntity(entityId);
        if (entity && typeof entity.initiateConnection === "function") {
          const connectionRequest = await entity.initiateConnection({ appName });
          return connectionRequest?.redirectUrl || connectionRequest?.authUrl || null;
        }
      }

      if (typeof this.composioToolSet.initiateConnection === "function") {
        const connectionRequest = await this.composioToolSet.initiateConnection(
          appName,
          null,
          {},
          entityId
        );
        return connectionRequest?.redirectUrl || connectionRequest?.authUrl || null;
      }

      // Alternative method
      if (this.composioToolSet.client?.connectedAccounts) {
        const result = await this.composioToolSet.client.connectedAccounts.initiate({
          appName,
          user_uuid: entityId,
        });
        return result?.redirectUrl || result?.authUrl || null;
      }

      return null;
    } catch (error) {
      console.warn(`[ToolRouter] Failed to get auth URL for ${appName}:`, error.message);
      return null;
    }
  }

  _getConnectionCache(key) {
    const cached = this.connectionCache.get(key);
    if (cached && Date.now() - cached.time < this.CONNECTION_CACHE_TTL) {
      return cached.data;
    }
    return null;
  }

  _setConnectionCache(key, data) {
    this.connectionCache.set(key, { data, time: Date.now() });
  }

  // ===========================================================================
  // ENTITY RESOLUTION
  // ===========================================================================

  async _resolveEntities({ tools, selectedSchemas, message, context }) {
    const result = {
      resolved: [], // [{ raw, resolved, field, type }]
      unresolved: [], // [{ raw, type, reason }]
      byField: {}, // field -> resolved value
    };

    // ENHANCEMENT: Extract emails directly from message first
    const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
    const extractedEmails = [...new Set((message.match(emailRegex) || []).map(e => e.toLowerCase()))];

    if (extractedEmails.length > 0) {
      console.log("[ToolRouter:Entity] Emails found in message:", extractedEmails);

      // Apply extracted emails to relevant fields
      for (const tool of tools) {
        const schema = selectedSchemas.get(tool.name);
        if (!schema?.parameters?.properties) continue;

        const properties = schema.parameters.properties;
        const action = String(tool.name || '').toUpperCase();

        for (const [paramName, paramSchema] of Object.entries(properties)) {
          // Target email-like fields
          const isEmailField = /^(to|recipient|attendees|attendee|email|cc|bcc)$/i.test(paramName);
          const isEmailFormat = paramSchema.format === 'email' ||
            (paramSchema.type === 'array' && paramSchema.items?.format === 'email');

          if (!isEmailField && !isEmailFormat) continue;

          // Skip if already has value
          if (tool.params[paramName] &&
            tool.params[paramName] !== '' &&
            tool.params[paramName] !== null) {
            continue;
          }

          const fieldKey = `${tool.name}.${paramName}`;

          // For GMAIL_SEND_EMAIL "to" field or similar
          if (/SEND.*EMAIL|EMAIL.*SEND/i.test(action) && /^(to|recipient)$/i.test(paramName)) {
            const emailValue = paramSchema.type === 'array' ? extractedEmails : extractedEmails[0];
            result.resolved.push({
              raw: extractedEmails.join(', '),
              resolved: emailValue,
              field: paramName,
              type: 'email_extracted',
              toolName: tool.name,
            });
            result.byField[fieldKey] = emailValue;
          }

          // For CALENDAR events with attendees
          if (/CALENDAR.*CREATE|CREATE.*EVENT/i.test(action) && /^(attendees|attendee)$/i.test(paramName)) {
            // Format attendees as array of objects or just array of emails depending on schema
            const attendeesValue = extractedEmails.map(e => ({ email: e }));
            result.resolved.push({
              raw: extractedEmails.join(', '),
              resolved: attendeesValue,
              field: paramName,
              type: 'attendee_extracted',
              toolName: tool.name,
            });
            result.byField[fieldKey] = attendeesValue;
          }
        }
      }
    }

    // Extract potential person names from message
    const potentialNames = this._extractPotentialNames(message);

    if (potentialNames.length === 0 && extractedEmails.length === 0) {
      return result;
    }

    console.log("[ToolRouter:Entity] Potential names found:", potentialNames);

    // For each tool, check if it has email/person fields that need resolution
    for (const tool of tools) {
      const schema = selectedSchemas.get(tool.name);
      if (!schema?.parameters?.properties) continue;

      const properties = schema.parameters.properties;

      for (const [paramName, paramSchema] of Object.entries(properties)) {
        // Check if this field typically needs person/email resolution
        const isEmailField = this.ENTITY_CONFIG.emailFields.some(
          (f) => paramName.toLowerCase().includes(f.toLowerCase())
        );

        const isEmailFormat = paramSchema.format === "email" ||
          (paramSchema.type === "array" && paramSchema.items?.format === "email");

        if (!isEmailField && !isEmailFormat) continue;

        // Skip if already has value
        if (tool.params[paramName] && !this._looksLikeName(tool.params[paramName])) {
          continue;
        }

        // Check if param value is a name that needs resolution
        const paramValue = tool.params[paramName];
        if (paramValue && this._looksLikeName(paramValue)) {
          const resolved = await this._resolveNameToEmail(paramValue, context);
          if (resolved) {
            result.resolved.push({
              raw: paramValue,
              resolved,
              field: paramName,
              type: "person",
              toolName: tool.name,
            });
            result.byField[`${tool.name}.${paramName}`] = resolved;
          } else {
            result.unresolved.push({
              raw: paramValue,
              type: "person",
              field: paramName,
              reason: "Could not resolve name to email",
            });
          }
        }

        // Also try to match extracted names to this field
        for (const name of potentialNames) {
          const fieldKey = `${tool.name}.${paramName}`;
          if (result.byField[fieldKey]) continue; // Already resolved

          // Check if this name appears in context for this field
          if (this._nameRelevantToField(name, paramName, message)) {
            const resolved = await this._resolveNameToEmail(name, context);
            if (resolved) {
              result.resolved.push({
                raw: name,
                resolved,
                field: paramName,
                type: "person",
                toolName: tool.name,
                inferredFromMessage: true,
              });
              result.byField[fieldKey] = resolved;
            }
          }
        }
      }
    }

    return result;
  }

  _extractPotentialNames(message) {
    const names = new Set();

    for (const pattern of this.ENTITY_CONFIG.personPatterns) {
      // Reset regex state
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(message)) !== null) {
        const name = match[1]?.trim();
        if (name && this._isValidName(name)) {
          names.add(name);
        }
      }
    }

    return Array.from(names);
  }

  _isValidName(name) {
    if (!name || name.length < 2 || name.length > 50) return false;

    // Check against exclusion patterns
    for (const pattern of this.ENTITY_CONFIG.excludePatterns) {
      if (pattern.test(name)) return false;
    }

    // Must start with capital letter (basic name heuristic)
    if (!/^[A-Z]/.test(name)) return false;

    // Should not be all caps (likely acronym)
    if (name === name.toUpperCase() && name.length > 2) return false;

    return true;
  }

  _looksLikeName(value) {
    if (!value || typeof value !== "string") return false;

    // If it's an email, it's not a name
    if (value.includes("@")) return false;

    // Check if it looks like a person name
    return this._isValidName(value);
  }

  _nameRelevantToField(name, fieldName, message) {
    const msgLower = message.toLowerCase();
    const nameLower = name.toLowerCase();
    const fieldLower = fieldName.toLowerCase();

    // Check if name appears near field-relevant keywords
    const relevancePatterns = {
      to: [/send\s+to/i, /email\s+to/i, /mail\s+to/i, /message\s+to/i],
      attendees: [/meet(?:ing)?\s+with/i, /invite/i, /schedule.*with/i],
      cc: [/cc/i, /copy/i],
      assignee: [/assign\s+to/i, /assignee/i],
    };

    const patterns = relevancePatterns[fieldLower] || [];
    for (const pattern of patterns) {
      if (pattern.test(message) && msgLower.includes(nameLower)) {
        return true;
      }
    }

    // Generic check: name appears in message
    return msgLower.includes(nameLower);
  }

  async _resolveNameToEmail(name, context) {
    if (!name) return null;

    // Check cache
    const cacheKey = `${context.userId || "default"}:${name.toLowerCase()}`;
    const cached = this._getEntityCache(cacheKey);
    if (cached !== null) {
      return cached;
    }

    let resolved = null;

    // Method 1: Database lookup (if query function provided)
    if (this.query && context.userId) {
      try {
        const contacts = await this.query(
          `SELECT email FROM contacts 
           WHERE user_id = $1 
           AND (LOWER(name) LIKE $2 OR LOWER(nickname) LIKE $2)
           LIMIT 1`,
          [context.userId, `%${name.toLowerCase()}%`]
        );

        if (contacts?.rows?.[0]?.email) {
          resolved = contacts.rows[0].email;
        }
      } catch (error) {
        console.warn("[ToolRouter:Entity] Database lookup failed:", error.message);
      }
    }

    // Method 2: Google Contacts (if Gmail connected)
    if (!resolved && context.entityId) {
      resolved = await this._searchGoogleContacts(name, context.entityId);
    }

    // Method 3: Check if it's already a valid email pattern
    if (!resolved) {
      // Try common email patterns
      const emailPatterns = this._generateEmailPatterns(name, context);
      // We can't validate these, so don't auto-resolve
      // Just return null and let the user specify
    }

    // Cache result (even if null)
    this._setEntityCache(cacheKey, resolved);

    if (resolved) {
      console.log(`[ToolRouter:Entity] Resolved "${name}" → ${resolved}`);
    }

    return resolved;
  }

  async _searchGoogleContacts(name, entityId) {
    try {
      // Try to search Google Contacts via Composio
      const result = await this._executeComposioAction(
        "GOOGLECONTACTS_SEARCH_CONTACTS",
        { query: name, pageSize: 5 },
        entityId
      );

      const contacts = result?.data?.results || result?.data?.connections || [];

      // Find best match
      for (const contact of contacts) {
        const emails = contact.emailAddresses || [];
        if (emails.length > 0) {
          const contactName = contact.names?.[0]?.displayName || "";
          if (contactName.toLowerCase().includes(name.toLowerCase())) {
            return emails[0].value;
          }
        }
      }

      return null;
    } catch (error) {
      // Google Contacts not connected or action not available
      return null;
    }
  }

  _generateEmailPatterns(name, context) {
    // Generate possible email patterns (for suggestion, not auto-fill)
    const parts = name.toLowerCase().split(/\s+/);
    const domain = context.emailDomain || "company.com";

    if (parts.length === 1) {
      return [
        `${parts[0]}@${domain}`,
        `${parts[0][0]}@${domain}`,
      ];
    }

    if (parts.length >= 2) {
      const first = parts[0];
      const last = parts[parts.length - 1];
      return [
        `${first}.${last}@${domain}`,
        `${first}${last}@${domain}`,
        `${first[0]}${last}@${domain}`,
        `${first}@${domain}`,
      ];
    }

    return [];
  }

  _getEntityCache(key) {
    const cached = this.entityCache.get(key);
    if (cached && Date.now() - cached.time < this.ENTITY_CACHE_TTL) {
      return cached.data;
    }
    return null;
  }

  _setEntityCache(key, data) {
    this.entityCache.set(key, { data, time: Date.now() });
  }

  _mergeEntityResults(tools, entityResult) {
    return tools.map((tool) => {
      const mergedParams = { ...tool.params };

      for (const resolved of entityResult.resolved) {
        if (resolved.toolName === tool.name && resolved.field) {
          const currentValue = mergedParams[resolved.field];

          // Only override if empty or is the raw name
          if (
            !currentValue ||
            currentValue === resolved.raw ||
            this._looksLikeName(currentValue)
          ) {
            // Handle array fields (like attendees)
            const schema = tool._schema?.parameters?.properties?.[resolved.field];
            if (schema?.type === "array") {
              const existing = Array.isArray(currentValue) ? currentValue : [];
              if (!existing.includes(resolved.resolved)) {
                mergedParams[resolved.field] = [...existing, resolved.resolved];
              }
            } else {
              mergedParams[resolved.field] = resolved.resolved;
            }
          }
        }
      }

      return { ...tool, params: mergedParams };
    });
  }

  // ===========================================================================
  // PREFLIGHT: Pattern-based discovery and auto-fill
  // ===========================================================================

  async _runPreflight({ tools, selectedSchemas, availableTools, context, message, connections }) {
    const result = {
      autoFilled: {},
      availableOptions: {},
      suggestions: {},
    };

    // Build action map by toolkit
    const actionsByToolkit = new Map();
    for (const tool of availableTools) {
      const toolkit = tool.toolkit || this._inferToolkit(tool.name);
      if (!actionsByToolkit.has(toolkit)) {
        actionsByToolkit.set(toolkit, []);
      }
      actionsByToolkit.get(toolkit).push(tool);
    }

    // Process each tool
    for (const tool of tools) {
      const schema = selectedSchemas.get(tool.name);
      if (!schema?.parameters) continue;

      const toolkit = schema.toolkit || this._inferToolkit(tool.name);
      const toolkitActions = actionsByToolkit.get(toolkit) || [];
      const required = schema.parameters.required || [];
      const properties = schema.parameters.properties || {};

      for (const paramName of required) {
        // Skip if already has value
        if (
          tool.params[paramName] &&
          tool.params[paramName] !== "_inject_from_previous" &&
          tool.params[paramName] !== ""
        ) {
          continue;
        }

        // Find matching preflight config
        const preflightConfig = this._findPreflightConfig(paramName, properties[paramName]);
        if (!preflightConfig) continue;

        // Check cache
        const cacheKey = `${context.entityId}:${toolkit}:${preflightConfig.configKey}`;
        const cached = this._getPreflightCache(cacheKey);
        if (cached) {
          this._applyPreflightData(result, paramName, cached, preflightConfig);
          continue;
        }

        // Fetch data
        let items = null;

        if (preflightConfig.isFrappe && this.frappeService) {
          items = await this._fetchFrappeData(preflightConfig, context);
        } else {
          const listAction = this._findListAction(toolkitActions, preflightConfig);
          if (listAction) {
            items = await this._executeListAction(listAction, context);
          }
        }

        if (items && items.length > 0) {
          this._setPreflightCache(cacheKey, items);
          this._applyPreflightData(result, paramName, items, preflightConfig);
        } else if (
          preflightConfig.defaultValue !== null &&
          preflightConfig.defaultValue !== undefined
        ) {
          result.autoFilled[paramName] = preflightConfig.defaultValue;
        }
      }
    }

    // Extract time from message
    const timeExtracted = this._extractTimeFromMessage(message);
    if (timeExtracted) {
      if (!result.autoFilled.start_datetime) {
        result.autoFilled.start_datetime = timeExtracted.start;
      }
      if (!result.autoFilled.end_datetime && timeExtracted.end) {
        result.autoFilled.end_datetime = timeExtracted.end;
      }
    }

    return result;
  }

  _findPreflightConfig(paramName, paramSchema) {
    for (const [configKey, config] of Object.entries(this.PREFLIGHT_CONFIG)) {
      for (const pattern of config.paramPatterns) {
        if (pattern.test(paramName)) {
          return { ...config, configKey };
        }
      }
    }

    // Fallback patterns
    const identifierPatterns = [
      { key: "project", pattern: /project/i },
      { key: "workspace", pattern: /workspace|space/i },
      { key: "channel", pattern: /channel|conversation/i },
      { key: "board", pattern: /board/i },
      { key: "list", pattern: /list/i },
      { key: "calendar", pattern: /calendar/i },
      { key: "repo", pattern: /repo|repository/i },
      { key: "team", pattern: /team|org/i },
      { key: "assignee", pattern: /assignee|user|member/i },
    ];

    const paramLower = paramName.toLowerCase();
    for (const { key, pattern } of identifierPatterns) {
      if (pattern.test(paramLower) && this.PREFLIGHT_CONFIG[key]) {
        return { ...this.PREFLIGHT_CONFIG[key], configKey: key };
      }
    }

    return null;
  }

  _findListAction(toolkitActions, preflightConfig) {
    if (!preflightConfig.listActionPatterns?.length) return null;

    for (const pattern of preflightConfig.listActionPatterns) {
      const match = toolkitActions.find((action) => pattern.test(action.name));
      if (match) return match;
    }

    return null;
  }

  async _executeListAction(listAction, context) {
    try {
      const entityId = context.entityId || "default";
      console.log(`[ToolRouter:Preflight] Executing ${listAction.name}`);

      const result = await this._executeComposioAction(
        listAction.composio_action || listAction.name,
        {},
        entityId
      );

      const data = result?.data || result?.response?.data || result;

      if (Array.isArray(data)) return data;

      const arrayKeys = [
        "items", "values", "results", "data", "projects", "channels",
        "boards", "lists", "calendars", "repositories", "repos", "teams",
        "users", "members", "workspaces", "organizations", "labels", "tags",
      ];

      for (const key of arrayKeys) {
        if (Array.isArray(data?.[key])) return data[key];
      }

      if (data && typeof data === "object" && (data.id || data.key || data.name)) {
        return [data];
      }

      return [];
    } catch (error) {
      console.warn(`[ToolRouter:Preflight] Failed ${listAction.name}:`, error.message);
      return [];
    }
  }

  async _executeComposioAction(actionName, params, entityId) {
    try {
      return await this.composioToolSet.executeAction(actionName, params, entityId);
    } catch (e) {
      // Try alternate signature
      return await this.composioToolSet.executeAction({
        action: actionName,
        params,
        entityId,
      });
    }
  }

  async _fetchFrappeData(preflightConfig, context) {
    if (!this.frappeService) return [];

    try {
      const method = preflightConfig.frappeListMethod || "getDoctypes";

      if (typeof this.frappeService[method] === "function") {
        const result = await this.frappeService[method](context);
        return Array.isArray(result) ? result : result?.data || [];
      }

      if (typeof this.frappeService.listDoctype === "function") {
        const result = await this.frappeService.listDoctype({
          doctype: preflightConfig.configKey,
          ...context,
        });
        return Array.isArray(result) ? result : result?.data || [];
      }

      return [];
    } catch (error) {
      console.warn(`[ToolRouter:Preflight] Frappe fetch failed:`, error.message);
      return [];
    }
  }

  _applyPreflightData(result, paramName, items, config) {
    if (!items?.length) return;

    const options = items
      .map((item) => ({
        value: config.valueExtractor(item),
        label: config.labelExtractor(item),
        _raw: item,
      }))
      .filter((opt) => opt.value != null);

    if (!options.length) return;

    result.availableOptions[paramName] = options;

    if (options.length === 1 && config.autoSelectIfSingle) {
      result.autoFilled[paramName] = options[0].value;
      console.log(`[ToolRouter:Preflight] Auto-selected ${paramName}: ${options[0].value}`);
    } else if (config.selectPrimary && config.primaryDetector) {
      const primary = items.find((item) => config.primaryDetector(item));
      if (primary) {
        result.autoFilled[paramName] = config.valueExtractor(primary);
        console.log(`[ToolRouter:Preflight] Auto-selected primary ${paramName}`);
      }
    } else if (config.defaultValue != null) {
      result.suggestions[paramName] = config.defaultValue;
    }
  }

  _mergePreflightResults(tools, preflightResult) {
    return tools.map((tool) => {
      const mergedParams = { ...tool.params };

      for (const [param, value] of Object.entries(preflightResult.autoFilled)) {
        if (
          mergedParams[param] === undefined ||
          mergedParams[param] === null ||
          mergedParams[param] === ""
        ) {
          mergedParams[param] = value;
        }
      }

      return { ...tool, params: mergedParams };
    });
  }

  // ===========================================================================
  // SCHEMA-BASED INJECTION TARGETING
  // ===========================================================================

  /**
   * Apply schema-based injection targeting.
   * Analyzes schemas to identify which params should receive data from previous steps.
   * 
   * For example:
   * - GMAIL_SEND_EMAIL.body should receive content when it's empty
   * - SLACK_SENDS_A_MESSAGE.text should receive content when it's empty
   */
  _applySchemaBasedInjection(tools, selectedSchemas) {
    if (!Array.isArray(tools) || tools.length === 0) {
      return tools;
    }

    // Patterns for fields that typically need injected content
    const CONTENT_FIELD_PATTERNS = [
      /^body$/i, /^text$/i, /^content$/i, /^message$/i, /^description$/i,
      /^notes$/i, /^details$/i, /^html_body$/i, /^plain_text$/i
    ];

    return tools.map((tool, idx) => {
      const action = String(tool.name || tool.action || '').toUpperCase();
      const schema = selectedSchemas.get ?
        selectedSchemas.get(tool.name) :
        selectedSchemas[tool.name];

      const params = { ...tool.params };
      const schemaProps = schema?.properties || {};

      // For SEND actions, check if content fields need injection
      if (/SEND|POST|CREATE/.test(action)) {
        for (const [field, spec] of Object.entries(schemaProps)) {
          const isContentField = CONTENT_FIELD_PATTERNS.some(p => p.test(field));

          if (isContentField) {
            const currentValue = params[field];
            // Only mark for injection if empty and there might be data sources
            if (currentValue === undefined || currentValue === null || currentValue === '') {
              // We'll inject later based on data dependency detection
              // For now, mark with placeholder
              // params[field] = '_inject_from_previous';
            }
          }
        }
      }

      return { ...tool, params };
    });
  }

  // ===========================================================================
  // TIME EXTRACTION
  // ===========================================================================

  _extractTimeFromMessage(message) {
    if (!message) return null;

    const now = new Date();
    const offset = this._getOffsetForTimeZone(now, this.USER_TIMEZONE);

    const time12Match = message.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    const time24Match = message.match(/(?:at\s+)?(\d{1,2}):(\d{2})(?!\s*[ap]m)/i);

    const durationMatch = message.match(/(?:for\s+)?(\d+)\s*(min(?:ute)?s?|hours?|hrs?)/i);

    if (!time12Match && !time24Match) return null;

    let hours, minutes;

    if (time12Match) {
      hours = parseInt(time12Match[1]);
      minutes = parseInt(time12Match[2] || "0");
      const meridiem = time12Match[3].toLowerCase();
      if (meridiem === "pm" && hours < 12) hours += 12;
      if (meridiem === "am" && hours === 12) hours = 0;
    } else {
      hours = parseInt(time24Match[1]);
      minutes = parseInt(time24Match[2]);
    }

    // Get the current date in user's timezone to determine the correct calendar date
    const userDate = this._getDateInTimezone(now, this.USER_TIMEZONE);
    const msgLower = message.toLowerCase();

    const datePatterns = { today: 0, tonight: 0, tomorrow: 1, tmrw: 1 };
    const weekdays = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    };

    let daysToAdd = 0;
    let foundDatePattern = false;

    for (const [word, daysOffset] of Object.entries(datePatterns)) {
      if (msgLower.includes(word)) {
        daysToAdd = daysOffset;
        foundDatePattern = true;
        break;
      }
    }

    if (!foundDatePattern) {
      for (const [day, dayNum] of Object.entries(weekdays)) {
        if (msgLower.includes(day)) {
          const currentDay = userDate.dayOfWeek;
          let daysUntil = dayNum - currentDay;
          if (daysUntil <= 0) daysUntil += 7;
          daysToAdd = daysUntil;
          foundDatePattern = true;
          break;
        }
      }
    }

    // If time is in past and no explicit date, use tomorrow
    // Check in user's timezone context
    const currentUserHour = userDate.hours;
    const currentUserMinute = userDate.minutes;
    const timeInPast = (hours < currentUserHour) ||
      (hours === currentUserHour && minutes <= currentUserMinute);

    if (!foundDatePattern && timeInPast) {
      daysToAdd = 1;
    }

    // Calculate target date by adding days to user's current date
    const targetYear = userDate.year;
    const targetMonth = userDate.month;
    const targetDay = userDate.day + daysToAdd;

    // Handle month overflow (simple approach - let Date handle it)
    const tempDate = new Date(targetYear, targetMonth - 1, targetDay);
    const finalYear = tempDate.getFullYear();
    const finalMonth = tempDate.getMonth() + 1;
    const finalDay = tempDate.getDate();

    // Calculate duration
    let durationMinutes = 30; // Default 30 minutes
    if (durationMatch) {
      const amount = parseInt(durationMatch[1]);
      const unit = durationMatch[2].toLowerCase();
      durationMinutes = unit.startsWith("h") ? amount * 60 : amount;
    }

    // Format dates directly with user timezone - don't go through Date object
    // This avoids server timezone conversion issues
    const formatDateTime = (year, month, day, h, min) => {
      const y = String(year);
      const m = String(month).padStart(2, "0");
      const d = String(day).padStart(2, "0");
      const hStr = String(h).padStart(2, "0");
      const minStr = String(min).padStart(2, "0");
      return `${y}-${m}-${d}T${hStr}:${minStr}:00${offset}`;
    };

    // Calculate end time by adding duration
    let endHours = hours;
    let endMinutes = minutes + durationMinutes;
    let endDay = finalDay;
    let endMonth = finalMonth;
    let endYear = finalYear;

    // Handle minute overflow
    while (endMinutes >= 60) {
      endMinutes -= 60;
      endHours++;
    }
    // Handle hour overflow
    while (endHours >= 24) {
      endHours -= 24;
      endDay++;
    }
    // Handle day overflow (simple - use Date for complex cases)
    const endTempDate = new Date(endYear, endMonth - 1, endDay);
    endYear = endTempDate.getFullYear();
    endMonth = endTempDate.getMonth() + 1;
    endDay = endTempDate.getDate();

    console.log(`[ToolRouter] Extracted time: ${hours}:${minutes} ${offset} on ${finalYear}-${finalMonth}-${finalDay}`);

    return {
      start: formatDateTime(finalYear, finalMonth, finalDay, hours, minutes),
      end: formatDateTime(endYear, endMonth, endDay, endHours, endMinutes),
      durationMinutes,
    };
  }

  /**
   * Get current date/time components in a specific timezone
   * Returns an object with year, month, day, hours, minutes, dayOfWeek
   */
  _getDateInTimezone(date, timeZone) {
    try {
      const options = {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        weekday: 'short'
      };

      const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(date);
      const get = (type) => parts.find(p => p.type === type)?.value;

      const weekdays = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };

      return {
        year: parseInt(get('year')),
        month: parseInt(get('month')),
        day: parseInt(get('day')),
        hours: parseInt(get('hour')),
        minutes: parseInt(get('minute')),
        dayOfWeek: weekdays[get('weekday')] ?? new Date().getDay()
      };
    } catch (e) {
      // Fallback to local time if timezone parsing fails
      return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hours: date.getHours(),
        minutes: date.getMinutes(),
        dayOfWeek: date.getDay()
      };
    }
  }

  // ===========================================================================
  // HELPER UTILITIES
  // ===========================================================================

  /**
   * Extract userId from entityId (entityId may be formatted as "user_<id>" or just the id)
   */
  _extractUserId(entityId) {
    if (!entityId) return null;
    const str = String(entityId);
    if (str.startsWith('user_')) return str.slice(5);
    return str;
  }

  // ===========================================================================
  // CACHES
  // ===========================================================================

  _getPreflightCache(key) {
    const cached = this.preflightCache.get(key);
    if (cached && Date.now() - cached.time < this.PREFLIGHT_CACHE_TTL) {
      return cached.data;
    }
    return null;
  }

  _setPreflightCache(key, data) {
    this.preflightCache.set(key, { data, time: Date.now() });
  }

  clearAllCaches() {
    this.toolCache.clear();
    this.preflightCache.clear();
    this.connectionCache.clear();
    this.entityCache.clear();
    console.log("[ToolRouter] All caches cleared");
  }

  // ===========================================================================
  // TOOLKIT INFERENCE
  // ===========================================================================

  _inferToolkit(actionName) {
    if (!actionName) return "UNKNOWN";
    const parts = actionName.split("_");
    return parts[0]?.toUpperCase() || "UNKNOWN";
  }

  // ===========================================================================
  // CLARIFICATION BUILDER
  // ===========================================================================

  _buildClarificationQuestion(missingList, availableOptions = {}) {
    const top = missingList.slice(0, 6);
    const lines = [];

    for (let idx = 0; idx < top.length; idx++) {
      const m = top[idx];
      const desc = m.description && m.description !== m.field ? ` (${m.description})` : "";
      let line = `${idx + 1}. ${m.tool}.${m.field}${desc}`;

      const options = availableOptions[m.field];
      if (options?.length > 0) {
        const optionHint = options
          .slice(0, 5)
          .map((o) => o.label || o.value)
          .join(", ");
        line += `\n   Options: ${optionHint}${options.length > 5 ? "..." : ""}`;
      }

      lines.push(line);
    }

    return `I need a few more details:\n\n${lines.join("\n")}\n\nReply with the values.`;
  }

  // ===========================================================================
  // COMPOSIO TOOL FETCHING
  // ===========================================================================

  async getToolsFromComposio(toolkits = [], entityId = "default", context = {}) {
    if (!toolkits.length) return [this.systemCheckTool(), this.chatTool()];

    const cacheKey = `${entityId}:${context.userId || 'default'}:${toolkits.slice().sort().join(",")}`;
    const cached = this.toolCache.get(cacheKey);

    if (cached && Date.now() - cached.time < this.CACHE_TTL) {
      return cached.tools;
    }

    const toolkitResults = await Promise.all(toolkits.map(async toolkit => {
      try {
        // Handle FRAPPE specially - fetch from FrappeSchemaService
        if (toolkit.toUpperCase() === 'FRAPPE') {
          const frappeTools = await this._getFrappeTools(context.userId);
          return frappeTools;
        }

        if (this.connectorService?.canExecuteDirect(toolkit) && context.organizationId) {
          const directStatus = await this.connectorService.getDirectStatus({
            appId: toolkit,
            organizationId: context.organizationId,
            userId: context.userId,
          });
          if (directStatus.connected) {
            const directTools = this.connectorService.getDirectTools(toolkit);
            if (directTools.length) {
              return directTools.map(tool => this.normalizeSchema(tool, toolkit));
            }
          }
        }

        // Use getToolsForToolkit which is the method available in ComposioService
        const result = await this.composioToolSet.getToolsForToolkit(toolkit, entityId);
        if (result?.length) {
          const normalized = result.map((t) => this.normalizeSchema(t, toolkit));
          return normalized.slice(0, this.MAX_TOOLS_PER_TOOLKIT);
        }
        return [];
      } catch (err) {
        console.warn(`[ToolRouter] Failed to fetch ${toolkit}:`, err.message);
        return [];
      }
    }));

    const tools = toolkitResults.flat();

    tools.push(this.systemCheckTool());
    tools.push(this.chatTool());

    this.toolCache.set(cacheKey, { tools, time: Date.now() });
    console.log(`[ToolRouter] Cached ${tools.length} tools for: ${toolkits.join(", ")}`);

    return tools;
  }

  /**
   * Get Frappe tools from FrappeSchemaService for per-user connection
   */
  async _getFrappeTools(userId) {
    if (!userId) {
      console.warn('[ToolRouter] No userId for Frappe tools - returning generic tools');
      return this._getGenericFrappeTools();
    }

    try {
      // Lazy-load FrappeSchemaService to avoid circular dependencies
      const { frappeSchemaService, frappeConnectionManager } = require('../integrations/frappe');

      // Check if user has active connection
      const hasConnection = await frappeConnectionManager.hasActiveConnection(userId);
      if (!hasConnection) {
        console.log('[ToolRouter] No active Frappe connection for user');
        return this._getGenericFrappeTools();
      }

      // Get dynamically generated tools from cached schemas
      const tools = await frappeSchemaService.getAvailableTools(userId);
      console.log(`[ToolRouter] Loaded ${tools.length} Frappe tools for user`);
      return tools;
    } catch (err) {
      console.warn('[ToolRouter] Failed to fetch Frappe tools:', err.message);
      return this._getGenericFrappeTools();
    }
  }

  /**
   * Get generic Frappe tools (when no user-specific schemas available)
   */
  _getGenericFrappeTools() {
    return [
      {
        name: 'FRAPPE_LIST_DOCUMENTS',
        description: 'List documents of any DocType from ERPNext with optional filters',
        toolkit: 'FRAPPE',
        parameters: {
          type: 'object',
          properties: {
            doctype: { type: 'string', description: 'The DocType to list (e.g., Customer, Sales Order, Item)' },
            filters: { type: 'object', description: 'Filter conditions as key-value pairs' },
            fields: { type: 'array', items: { type: 'string' }, description: 'Fields to include' },
            limit: { type: 'integer', default: 20, description: 'Max documents to return' }
          },
          required: ['doctype']
        }
      },
      {
        name: 'FRAPPE_GET_DOCUMENT',
        description: 'Get a specific document from ERPNext by DocType and name',
        toolkit: 'FRAPPE',
        parameters: {
          type: 'object',
          properties: {
            doctype: { type: 'string', description: 'The DocType (e.g., Customer, Sales Order)' },
            name: { type: 'string', description: 'The document name/ID' }
          },
          required: ['doctype', 'name']
        }
      },
      {
        name: 'FRAPPE_CREATE_DOCUMENT',
        description: 'Create a new document in ERPNext',
        toolkit: 'FRAPPE',
        parameters: {
          type: 'object',
          properties: {
            doctype: { type: 'string', description: 'The DocType to create' },
            data: { type: 'object', description: 'Document data as key-value pairs' }
          },
          required: ['doctype', 'data']
        }
      },
      {
        name: 'FRAPPE_UPDATE_DOCUMENT',
        description: 'Update an existing document in ERPNext',
        toolkit: 'FRAPPE',
        parameters: {
          type: 'object',
          properties: {
            doctype: { type: 'string', description: 'The DocType' },
            name: { type: 'string', description: 'The document name/ID to update' },
            data: { type: 'object', description: 'Fields to update' }
          },
          required: ['doctype', 'name', 'data']
        }
      },
      {
        name: 'FRAPPE_DELETE_DOCUMENT',
        description: 'Delete a document from ERPNext',
        toolkit: 'FRAPPE',
        parameters: {
          type: 'object',
          properties: {
            doctype: { type: 'string', description: 'The DocType' },
            name: { type: 'string', description: 'The document name/ID to delete' }
          },
          required: ['doctype', 'name']
        }
      },
      {
        name: 'FRAPPE_LIST_CUSTOMERS',
        description: 'List customers from ERPNext',
        toolkit: 'FRAPPE',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', default: 20 },
            search: { type: 'string', description: 'Search by customer name' }
          },
          required: []
        }
      },
      {
        name: 'FRAPPE_CREATE_CUSTOMER',
        description: 'Create a new customer in ERPNext',
        toolkit: 'FRAPPE',
        parameters: {
          type: 'object',
          properties: {
            customer_name: { type: 'string', description: 'Customer name' },
            customer_type: { type: 'string', enum: ['Company', 'Individual'], default: 'Company' },
            email_id: { type: 'string', description: 'Email address' }
          },
          required: ['customer_name']
        }
      }
    ];
  }

  normalizeSchema(tool, toolkit) {
    if (tool.type === "function" && tool.function) {
      return {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        toolkit,
        composio_action: tool.function.name,
      };
    }

    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || tool.inputParameters,
      toolkit,
      composio_action: tool.name,
    };
  }

  chatTool() {
    return {
      name: "chat_response",
      description: "For greetings, general questions, or when no tool action is needed",
      parameters: { type: "object", properties: {} },
      toolkit: "SYSTEM",
      composio_action: null,
    };
  }

  systemCheckTool() {
    return {
      name: "SYSTEM_CHECK_CONNECTIONS",
      description: "Check which apps are connected and ready to use (Calendar, Gmail, Slack, Jira, etc.)",
      parameters: {
        type: "object",
        properties: {
          toolkits: {
            type: "array",
            items: { type: "string" },
            description: "Toolkits to check (defaults to the apps currently in your workspace)",
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
      },
      toolkit: "SYSTEM",
      composio_action: "SYSTEM_CHECK_CONNECTIONS",
    };
  }

  _looksLikeConnectionStatusQuery(message) {
    const s = String(message || "").toLowerCase();
    if (!s) return false;
    const hasConnectionWord = /\b(connect(?:ed|ion)?|integrations?|oauth|auth|linked)\b/i.test(s);
    const hasCheckWord = /\b(check|status|verify|cross\s*check|working|configured|list|which|what|show|give)\b/i.test(s);
    // Also match direct "are my apps connected"
    const hasAppsWord = /\b(apps?|tools?)\b/i.test(s);
    return (hasConnectionWord && (hasCheckWord || hasAppsWord)) ||
      /\b(what|which)(?:'s| is| are)?\s+connected\b/i.test(s) ||
      /\bconnected\s+(apps?|tools?|accounts?|integrations?)\b/i.test(s);
  }

  // ===========================================================================
  // STAGE A: Tool Selection
  // ===========================================================================

  async _stageA_selectTools({ message, availableTools, context }) {
    const now = this._nowContext();
    const shortlist = availableTools
      .filter(tool => !tool.name.includes('JQL') && !tool.name.includes('_JQL_'))
      .map(tool => ({ name: tool.name, description: tool.description, toolkit: tool.toolkit }));

    const systemPrompt = `You route SwiftCollab work requests to connected-app tools.

Time: ${now.nowRfc3339} (${this.USER_TIMEZONE})
Available tools:
${JSON.stringify(shortlist)}

Choose only exact names from the list. Include every step needed for the request. Use the same sequence for independent parallel steps and increasing sequences for dependent steps. Set usePreviousOutput=true when a later step consumes earlier results. If none matches, select chat_response. Return JSON only:
{"selectedTools":[{"name":"EXACT_NAME","sequence":1,"usePreviousOutput":false}],"chatResponse":null}`;

    const response = await this.callGemini(systemPrompt, message, 0);
    const parsed = this._parseJson(response) || {};
    let selectedTools = Array.isArray(parsed.selectedTools) ? parsed.selectedTools : [];
    if (!selectedTools.length) selectedTools = [{ name: 'chat_response', sequence: 1 }];

    selectedTools = selectedTools
      .map((tool, index) => ({
        name: String(tool.name || '').trim(),
        sequence: Number.isFinite(tool.sequence) ? tool.sequence : index + 1,
        usePreviousOutput: Boolean(tool.usePreviousOutput),
      }))
      .filter(tool => tool.name)
      .sort((a, b) => a.sequence - b.sequence);

    return { selectedTools, chatResponse: parsed.chatResponse || null };
  }

  async _stageA_selectToolsLegacy({ message, availableTools, context }) {
    const now = this._nowContext();

    // Filter out JQL-based Jira actions - they require complex query syntax users don't know
    const filteredTools = availableTools.filter((t) => {
      if (t.name.includes('JQL') || t.name.includes('_JQL_')) {
        return false;
      }
      return true;
    });

    const shortlist = filteredTools.map((t) => ({
      name: t.name,
      description: t.description,
      toolkit: t.toolkit,
    }));

    const systemPrompt = `You are a tool router. Select the best tool action(s) for the user's request.

CURRENT TIME:
- timezone: ${this.USER_TIMEZONE}
- now_rfc3339: ${now.nowRfc3339}
- today: ${now.today}
- tomorrow: ${now.tomorrow}
- yesterday: ${now.yesterday}

AVAILABLE TOOLS (name + description only):
${JSON.stringify(shortlist, null, 2)}

CONTEXT:
${this._formatContextForPrompt(context)}

RULES:
1) Choose tools ONLY from AVAILABLE TOOLS.
2) If multi-step (get data then send/post/schedule), output multiple tools with correct sequence.
3) If no tool needed, choose "chat_response" and include chatResponse.
4) If a later tool should use earlier tool output, set usePreviousOutput=true.
5) Output JSON only.
6) COMPLEX WORKFLOWS: Support 10-20+ tools in single request. Each step should have correct sequence and dependencies.

MULTI-APP ORCHESTRATION (CRITICAL - UNIVERSAL PATTERNS):

The user may request complex workflows involving MANY apps and actions. You MUST:
1) Identify ALL actions mentioned/implied in the request
2) Determine correct execution ORDER (dependencies)
3) Set usePreviousOutput=true when later actions need data from earlier ones

UNIVERSAL DEPENDENCY PATTERNS:
- CREATE actions that produce data → later actions can reference the created item
  Example: CREATE_CUSTOMER → CREATE_SALES_INVOICE (invoice needs customer)
  Example: CREATE_ITEM → CREATE_SALES_ORDER (order needs items)
  
- SEARCH/GET/LIST/FETCH actions → produce data for SEND/EMAIL/SLACK/CREATE actions
  Example: JIRA_SEARCH_ISSUES → GMAIL_SEND_EMAIL (email contains ticket data)
  Example: GOOGLECALENDAR_FIND_EVENT → SLACK_SEND_MESSAGE (message contains events)

- Multi-CREATE chains with final notification:
  Example: "create customer, item, invoice, then email details" →
    1. FRAPPE_CREATE_CUSTOMER (sequence: 1)
    2. FRAPPE_CREATE_ITEM (sequence: 1, parallel with customer)
    3. FRAPPE_CREATE_SALES_INVOICE (sequence: 2, usePreviousOutput: true - needs customer & item)
    4. GMAIL_SEND_EMAIL (sequence: 3, usePreviousOutput: true - email contains all created data)

PARALLEL vs SEQUENTIAL:
- CREATE actions that don't depend on each other can have SAME sequence (parallel execution)
- CREATE actions that need output of previous CREATE must have HIGHER sequence (sequential)
- SEND/EMAIL actions should ALWAYS be LAST and have usePreviousOutput: true

CROSS-APP DATA FLOW:
- ANY create/search result can flow to ANY destination (email body, calendar description, slack message, etc.)
- When user says "send details", "share info", "email the data", "post to slack", etc. → the data from previous steps should flow to that action
- The system will automatically inject data from previous tasks into content fields (body, description, text, notes)

FRAPPE/ERPNEXT SPECIFIC:
- CREATE_CUSTOMER, CREATE_ITEM, CREATE_SUPPLIER are independent (parallel)
- CREATE_SALES_INVOICE, CREATE_SALES_ORDER need customer + items first
- When creating invoices/orders, the customer and items fields will auto-populate from earlier CREATE results
- Prefer specific FRAPPE_LIST_* / FRAPPE_CREATE_* actions over FRAPPE_LIST_DOCUMENTS/FRAPPE_GET_DOCUMENT when the user mentions a known entity (customers, items, sales orders, sales invoices, tasks, projects, suppliers, employees, leave applications, purchase orders)
- Use FRAPPE_LIST_DOCUMENTS/FRAPPE_GET_DOCUMENT only when the user explicitly asks for an arbitrary DocType or provides a doctype name

MULTI-TOOL PATTERN DETECTION:
- When user wants to GET/SEARCH data AND then SEND/EMAIL/SHARE it:
  1. First select a GET/SEARCH/FETCH action to retrieve the data (sequence 1)
  2. Then select a SEND/EMAIL/POST action to deliver it (sequence 2, usePreviousOutput=true)
- Look at each tool's schema - prefer tools with fewer required params when multiple options exist

TOOL SELECTION PRINCIPLES:
- Always select tools that match the user's intent based on their descriptions and parameter schemas
- Prefer tools with fewer required params when multiple similar options exist
- For sending data via external channels (email, slack), use the appropriate send action (GMAIL_SEND_EMAIL, SLACK_SENDS_A_MESSAGE)
- Internal notification actions (like system notification features) are NOT for external delivery

CONTEXTUAL FOLLOW-UP QUERIES (CRITICAL):
- Use conversationHistory in CONTEXT to understand follow-up requests
- If user says "give me all", "show me all", "show me more", "list them" after a previous search:
  - Re-run the same type of search/list action from the previous request
  - Example: If previous was "what's on my calendar" and now "give me all" → select GOOGLECALENDAR_FIND_EVENT or similar list action
- If user says "send that", "email that", "share that" after a previous search:
  - The data from previous result should be sent using appropriate action
- Short follow-up messages like "give me all", "more details", "show all" are NOT standalone - they ALWAYS refer to the previous conversation

CRITICAL - JIRA ACTION SELECTION (understand the difference):
- JIRA_SEARCH_ISSUES → returns actual work items: tickets, bugs, stories, tasks, issues (the things people work on)
- JIRA_GET_ALL_PROJECTS → returns project containers/metadata (project names, keys) - NOT work items
- When user says "tickets", "issues", "tasks", "bugs", "stories", "my work" → use JIRA_SEARCH_ISSUES
- When user says "projects", "which projects", "list projects" → use JIRA_GET_ALL_PROJECTS
- DO NOT select JQL-based actions unless user explicitly provides JQL syntax

CONCRETE MULTI-ACTION EXAMPLES:

Example 1: "create a customer in frappe, send all jira tickets and frappe customers to john@test.com, schedule a meeting with john@test.com"
Detection: 5 distinct actions needed
{
  "selectedTools": [
    { "name": "FRAPPE_CREATE_CUSTOMER", "sequence": 1, "usePreviousOutput": false },
    { "name": "JIRA_SEARCH_ISSUES", "sequence": 1, "usePreviousOutput": false },
    { "name": "FRAPPE_LIST_CUSTOMERS", "sequence": 1, "usePreviousOutput": false },
    { "name": "GMAIL_SEND_EMAIL", "sequence": 2, "usePreviousOutput": true },
    { "name": "GOOGLECALENDAR_CREATE_EVENT", "sequence": 2, "usePreviousOutput": false }
  ]
}
Note: The 3 data-gathering actions run in parallel (sequence 1), then email (depends on jira+frappe data) and calendar (independent) are sequence 2.

Example 2: "get my calendar for tomorrow and all jira tickets, then email a summary to team@company.com"
{
  "selectedTools": [
    { "name": "GOOGLECALENDAR_FIND_EVENT", "sequence": 1, "usePreviousOutput": false },
    { "name": "JIRA_SEARCH_ISSUES", "sequence": 1, "usePreviousOutput": false },
    { "name": "GMAIL_SEND_EMAIL", "sequence": 2, "usePreviousOutput": true }
  ]
}

Example 3: "create a sales order for customer ABC with 3 widgets"
{
  "selectedTools": [
    { "name": "FRAPPE_CREATE_SALES_ORDER", "sequence": 1, "usePreviousOutput": false }
  ]
}
Note: Single action - customer name and item details will be extracted as params.

Example 4: "create a customer in frappe and send all customer details to john@test.com"
CRITICAL: "all customer details" means ALL customers, not just the created one!
{
  "selectedTools": [
    { "name": "FRAPPE_CREATE_CUSTOMER", "sequence": 1, "usePreviousOutput": false },
    { "name": "FRAPPE_LIST_CUSTOMERS", "sequence": 1, "usePreviousOutput": false },
    { "name": "GMAIL_SEND_EMAIL", "sequence": 2, "usePreviousOutput": true }
  ]
}
Note: When user says "all X details", you MUST add a LIST action to get all of them!

CRITICAL RULE - "ALL" KEYWORD DETECTION:
When the user says "all customers", "all invoices", "all tickets", "all items", etc., you MUST include a LIST/SEARCH action:
- "send all customers" → FRAPPE_LIST_CUSTOMERS + GMAIL_SEND_EMAIL
- "send all invoices" → FRAPPE_LIST_SALES_INVOICE + GMAIL_SEND_EMAIL  
- "send all tickets" → JIRA_SEARCH_ISSUES + GMAIL_SEND_EMAIL
- "all items" → FRAPPE_LIST_ITEMS
- "all orders" → FRAPPE_LIST_SALES_ORDER

The CREATE action alone does NOT give you "all" of something - it creates ONE new item.
To send "all X", you need: CREATE (optional) + LIST (required) + SEND

KEYWORD-TO-ACTION MAPPING:
- "jira tickets", "issues", "my tickets", "bugs" → JIRA_SEARCH_ISSUES
- "frappe customers", "customers list", "all customers", "all customer details" → FRAPPE_LIST_CUSTOMERS  
- "create customer", "new customer" → FRAPPE_CREATE_CUSTOMER
- "create invoice", "new invoice", "sales invoice", "create sales invoice" → FRAPPE_CREATE_SALES_INVOICE
- "purchase invoice", "create purchase invoice" → FRAPPE_CREATE_PURCHASE_INVOICE
- "all invoices", "invoice list", "list invoices" → FRAPPE_LIST_SALES_INVOICES
- "all items", "item list" → FRAPPE_LIST_ITEMS
- "create order", "sales order", "new order" → FRAPPE_CREATE_SALES_ORDER
- "send email", "email X to Y" → GMAIL_SEND_EMAIL
- "schedule meeting", "create event", "calendar event" → GOOGLECALENDAR_CREATE_EVENT
- "slack message", "post to slack" → SLACK_SENDS_A_MESSAGE

AMBIGUITY HANDLING:
If user says just "invoice" without specifying type, assume Sales Invoice (FRAPPE_CREATE_SALES_INVOICE).
If user says "create document" or is unclear about the DocType, ask for clarification via chatResponse.

OUTPUT JSON:
{
  "selectedTools": [
    { "name": "EXACT_TOOL_NAME", "sequence": 1, "usePreviousOutput": false },
    { "name": "EXACT_TOOL_NAME", "sequence": 1, "usePreviousOutput": false },
    { "name": "EXACT_TOOL_NAME", "sequence": 2, "usePreviousOutput": true },
    { "name": "EXACT_TOOL_NAME", "sequence": 3, "usePreviousOutput": true }
  ],
  "chatResponse": null
}`;

    const response = await this.callGemini(systemPrompt, message, 0);
    const parsed = this._parseJson(response) || {};

    let selectedTools = Array.isArray(parsed.selectedTools) ? parsed.selectedTools : [];

    if (!selectedTools.length) {
      selectedTools = [{ name: "chat_response", sequence: 1, usePreviousOutput: false }];
    }

    selectedTools = selectedTools
      .map((t, i) => ({
        name: String(t.name || "").trim(),
        sequence: Number.isFinite(t.sequence) ? t.sequence : i + 1,
        usePreviousOutput: !!t.usePreviousOutput,
      }))
      .filter((t) => t.name);

    selectedTools.sort((a, b) => a.sequence - b.sequence);

    return { selectedTools, chatResponse: parsed.chatResponse || null };
  }

  async _stageA_repairInvalidTools({ message, availableTools, context, invalidTools = [] }) {
    const now = this._nowContext();
    const allowed = availableTools.map((t) => t.name);

    const systemPrompt = `You previously selected invalid tool names: ${invalidTools.join(", ")}.
Repair the selection by choosing ONLY from this allowed tool list.

CURRENT TIME:
- timezone: ${this.USER_TIMEZONE}
- now_rfc3339: ${now.nowRfc3339}
- today: ${now.today}
- tomorrow: ${now.tomorrow}
- yesterday: ${now.yesterday}

ALLOWED TOOL NAMES:
${JSON.stringify(allowed, null, 2)}

CONTEXT:
${this._formatContextForPrompt(context)}

OUTPUT JSON:
{
  "selectedTools": [
    { "name": "EXACT_TOOL_NAME", "sequence": 1, "usePreviousOutput": false }
  ],
  "chatResponse": null
}`;

    try {
      const response = await this.callGemini(systemPrompt, message, 0);
      const parsed = this._parseJson(response) || {};

      let selectedTools = Array.isArray(parsed.selectedTools) ? parsed.selectedTools : [];
      selectedTools = selectedTools
        .map((t, i) => ({
          name: String(t.name || "").trim(),
          sequence: Number.isFinite(t.sequence) ? t.sequence : i + 1,
          usePreviousOutput: !!t.usePreviousOutput,
        }))
        .filter((t) => t.name);

      selectedTools.sort((a, b) => a.sequence - b.sequence);

      return { selectedTools, chatResponse: parsed.chatResponse || null };
    } catch (_) {
      return null;
    }
  }

  // ===========================================================================
  // STAGE B: Parameter Extraction
  // ===========================================================================

  _getSelectedSchemas(selectedTools, availableTools) {
    const map = new Map();
    for (const st of selectedTools) {
      const schema = availableTools.find((t) => t.name === st.name);
      if (schema) map.set(st.name, schema);
    }
    return map;
  }

  async _stageB_extractParams({ message, selectedSchemas, context, stageA }) {
    const now = this._nowContext();

    const schemasForPrompt = [...selectedSchemas.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const selectedMeta = stageA.selectedTools.map((t) => ({
      name: t.name,
      sequence: t.sequence,
      usePreviousOutput: t.usePreviousOutput,
    }));

    const systemPrompt = `You extract tool parameters for a productivity assistant.

CURRENT TIME:
- timezone: ${this.USER_TIMEZONE}
- now_rfc3339: ${now.nowRfc3339}
- today: ${now.today}
- tomorrow: ${now.tomorrow}
- yesterday: ${now.yesterday}

SELECTED TOOLS:
${JSON.stringify(selectedMeta, null, 2)}

SELECTED TOOL SCHEMAS (JSON Schema):
${JSON.stringify(schemasForPrompt, null, 2)}

CONTEXT:
${this._formatContextForPrompt(context)}

DATE/TIME RULES (CRITICAL):
1) For any field with format="date-time", output RFC3339 with timezone offset or Z.
2) NEVER output datetimes without timezone.
3) If user gave date but no time, assume 09:00 local with timezone.
4) If user says "for X minutes/hours", calculate end_datetime accordingly.
5) MEETING DURATION: If start time is given but no end/duration specified, DEFAULT to 30 minutes.
   Example: "meeting at 6pm" → start_datetime=18:00, end_datetime=18:30

GMAIL_FETCH_EMAILS QUERY RULES:
- For "yesterday's emails", use query: "after:${now.yesterday}"
- For "today's emails", use query: "after:${now.today}"
- For "unread emails", use query: "is:unread"
- ALWAYS set maxResults to at least 25 unless user specifies a different limit
- Example: "send yesterday's email summary" → GMAIL_FETCH_EMAILS with query="after:${now.yesterday}", maxResults=25

SEARCH/GET ACTION RULES:
- Check each action's schema for required params - prefer actions with fewer requirements
- Only for JIRA search/get actions: if a "fields" param exists and the user did not specify it, set fields to include key data (key, summary, status, assignee, priority, project, created, updated)
- For non-JIRA toolkits, do NOT add "fields" unless the user explicitly provided them
- Let the action's schema guide what params are needed

CRITICAL - DO NOT INVENT PARAMETER VALUES:
- ONLY set params that the user explicitly provided values for OR that are marked required in the schema
- If a param is optional and user didn't specify a value, DO NOT set it at all - leave it undefined/null
- For "jql" or query params: ONLY set if user provided specific filter criteria. If user says "all issues" or "my issues", leave jql EMPTY or null
- Example: "search all jira issues" → do NOT set jql (returns all), do NOT set assignee, do NOT invent filters
- Example: "search my assigned issues" → set assignee filter only
- NEVER invent example values like "PROJ-123", "currentUser()", or "status = 'Done'"

REFERENCE RESOLUTION:
- If user says "the same", "same person", "with them", resolve to the value mentioned earlier in the SAME message.
- Example: "email john@x.com and meet with the same" → attendees = john@x.com

DATA DEPENDENCY RULES (CRITICAL FOR MULTI-ACTION):
- When the user wants to SEND/EMAIL/SHARE data from another system:
  - The SEARCH/GET/FETCH action runs FIRST (sequence 1)
  - The SEND/EMAIL/CREATE action runs SECOND with usePreviousOutput=true
  - Set the body/text/description field to "__INJECT__" to receive the data
  
EXAMPLES of data flow patterns:
- "send [data] to [email]" → SEARCH/GET action (seq 1) → GMAIL_SEND_EMAIL (seq 2, to="email", body="__INJECT__")
- "share [data] on slack" → SEARCH/GET action (seq 1) → SLACK_SENDS_A_MESSAGE (seq 2, text="__INJECT__")
- Pattern: data retrieval first (seq 1), then delivery (seq 2 with usePreviousOutput=true, content="__INJECT__")

EMAIL HANDLING:
- When user provides email addresses in the message, use them EXACTLY as provided
- For multiple recipients like "send to a@x.com, b@y.com", set to=["a@x.com", "b@y.com"] as an array
- Extract ALL email addresses from the user message using regex pattern

CHAINING RULES:
- If a tool has usePreviousOutput=true, you MUST set the content field (body, text, description, message) to "__INJECT__".
- The content field will be automatically populated with formatted data from the previous action.

CRITICAL - DO NOT INVENT VALUES:
- NEVER make up project_key, issue_key, board_id, channel_id, or any identifier
- NEVER invent email addresses - only use emails explicitly provided in the user's message
- Preserve user-provided names, titles, places, and wording exactly; do not autocorrect or replace them
- Example: "go to saloon" must remain "go to saloon" and must not become "Sally's salon"
- If a required field's value is not in the user's message, leave it as null or empty string
- The SlotFiller will ask the user for any missing required values
- Example: If user says "send jira tickets" but doesn't specify which project, set project_key: null (NOT "PROJ-123")
- Example: If user says "schedule meeting" but doesn't say when, set start_datetime: null (NOT some made-up time)

CALENDAR EVENT RULES:
- For GOOGLECALENDAR_CREATE_EVENT, the following are REQUIRED:
  * summary: The title of the meeting (if user says "meeting with X", set summary: null - ask them for title)
  * start_datetime: ONLY set if user provides specific time (e.g., "at 3pm", "tomorrow at 2pm")
  * end_datetime: ONLY set if user provides duration/end time, otherwise set null
- If user says "schedule a meeting with X" without time, set start_datetime: null, end_datetime: null
- For attendees: extract ALL email addresses mentioned, use array format: attendees: ["email1@x.com", "email2@y.com"]
- For reminders, use the requested activity as summary after removing only date/time words
- Example: "set a reminder tomorrow at 10 am go to saloon" → summary: "go to saloon"

OUTPUT JSON ONLY:
{
  "tools": [
    { "name": "EXACT_TOOL_NAME", "sequence": 1, "params": { } },
    { "name": "EXACT_TOOL_NAME", "sequence": 2, "usePreviousOutput": true, "params": { "body": "__INJECT__" } }
  ],
  "chatResponse": null
}`;

    const response = await this.callGemini(systemPrompt, message, 0);
    const parsed = this._parseJson(response) || {};

    let tools = Array.isArray(parsed.tools) ? parsed.tools : [];

    tools = tools
      .map((t, i) => ({
        name: String(t.name || "").trim(),
        sequence: Number.isFinite(t.sequence) ? t.sequence : i + 1,
        params: t.params && typeof t.params === "object" ? t.params : {},
        usePreviousOutput: !!t.usePreviousOutput,
      }))
      .filter((t) => t.name);

    // =========================================================================
    // BLOCK JQL-BASED ACTIONS - Replace with simpler JIRA_SEARCH_ISSUES
    // JQL actions require complex query syntax that users don't know
    // =========================================================================
    tools = tools.map((t) => {
      if (t.name.includes('JQL') || t.name.includes('_JQL_')) {
        console.log(`[ToolRouter] Replacing JQL action ${t.name} with JIRA_SEARCH_ISSUES`);
        return {
          ...t,
          name: 'JIRA_SEARCH_ISSUES',
          params: {
            ...t.params,
            jql: undefined, // Remove JQL param - let it search all
          },
        };
      }
      return t;
    });

    const seqByName = new Map(stageA.selectedTools.map((t) => [t.name, t.sequence]));
    const uPByName = new Map(stageA.selectedTools.map((t) => [t.name, t.usePreviousOutput]));

    const produced = new Set(tools.map((t) => t.name));
    for (const st of stageA.selectedTools) {
      if (!produced.has(st.name)) {
        tools.push({
          name: st.name,
          sequence: seqByName.get(st.name) || tools.length + 1,
          params: {},
          usePreviousOutput: uPByName.get(st.name) || false,
        });
      }
    }

    tools = tools.map((t) => ({
      ...t,
      sequence: seqByName.get(t.name) ?? t.sequence,
      usePreviousOutput: t.usePreviousOutput || uPByName.get(t.name) || false,
    }));

    tools.sort((a, b) => a.sequence - b.sequence);

    // =========================================================================
    // ENSURE SEARCH/GET ACTIONS HAVE FIELDS PARAM IF SCHEMA SUPPORTS IT
    // Dynamically add fields based on action schema
    // =========================================================================
    tools = tools.map((t) => {
      const schema = selectedSchemas.get(t.name);
      const hasFieldsParam = schema?.parameters?.properties?.fields;
      const toolkit = schema?.toolkit || this._inferToolkit(t.name);
      const isJira = toolkit === "JIRA" || /^JIRA_/i.test(t.name);

      // Only default fields for Jira search/get actions.
      if (hasFieldsParam && !t.params?.fields && isJira) {
        console.log(`[ToolRouter] Adding default fields to ${t.name} based on schema`);
        return {
          ...t,
          params: {
            ...t.params,
            fields: ["key", "summary", "status", "assignee", "priority", "project", "created", "updated"],
          },
        };
      }
      return t;
    });

    return { tools, chatResponse: parsed.chatResponse || null };
  }

  // ===========================================================================
  // INJECTION
  // ===========================================================================

  _applySchemaBasedInjection(tools, selectedSchemas) {
    return tools.map((t) => {
      const schemaTool = selectedSchemas.get(t.name);
      const schema = schemaTool?.parameters;

      const hasInjectMarker = this._containsInjectMarker(t.params);
      if (!t.usePreviousOutput && !hasInjectMarker) return t;

      const injectField = this._pickInjectionFieldFromSchema(schema);
      const replaced = this._replaceInjectMarkers(t.params, "_inject_from_previous");

      if (injectField && !replaced[injectField]) {
        replaced[injectField] = "_inject_from_previous";
      }

      return { ...t, params: replaced };
    });
  }

  _containsInjectMarker(obj) {
    if (!obj || typeof obj !== "object") return false;
    for (const v of Object.values(obj)) {
      if (v === "__INJECT__") return true;
      if (v && typeof v === "object" && this._containsInjectMarker(v)) return true;
    }
    return false;
  }

  _replaceInjectMarkers(obj, replacement) {
    if (!obj || typeof obj !== "object") return obj;
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === "__INJECT__") out[k] = replacement;
      else if (v && typeof v === "object") out[k] = this._replaceInjectMarkers(v, replacement);
      else out[k] = v;
    }
    return out;
  }

  _pickInjectionFieldFromSchema(schema) {
    const props = schema?.properties;
    if (!props || typeof props !== "object") return null;

    const preferred = [
      "body", "text", "message", "content", "description",
      "notes", "comment", "html_body",
    ];
    const keys = Object.keys(props);

    for (const p of preferred) {
      if (keys.includes(p) && this._isStringLike(props[p])) return p;
    }

    const keywordRe = /(body|text|message|content|description|note|comment)/i;
    const fuzzy = keys.find((k) => keywordRe.test(k) && this._isStringLike(props[k]));
    if (fuzzy) return fuzzy;

    return null;
  }

  _isStringLike(schemaProp) {
    const t = schemaProp?.type;
    if (!t) return false;
    if (t === "string") return true;
    if (Array.isArray(t) && t.includes("string")) return true;
    return false;
  }

  /**
   * Auto-detect and enforce data dependencies for multi-action workflows.
   * This handles cases like "send jira tickets to email" where:
   * - JIRA_GET_ISSUES runs first (sequence 1) - data producer
   * - GMAIL_SEND_EMAIL runs second (sequence 2) - data consumer
   *
   * UNIVERSAL: Works with ANY app combination (10-20+ apps)
   * We detect patterns where a SEND/CREATE action needs data from a previous GET/SEARCH/CREATE action
   * and automatically set up the injection AND the dependsOn array for proper ordering.
   */
  _enforceDataDependencies(tools, selectedSchemas, message) {
    if (!tools || tools.length < 2) return tools;

    const msgLower = (message || "").toLowerCase();
    const dataSharingIntent =
      /\b(send|email|share|forward|notify|message|slack|include|details|summary|report|digest|attach|post|publish)\b/i.test(msgLower);

    const actionTextFor = (tool) => {
      const schema = selectedSchemas.get(tool.name);
      const desc = schema?.description || "";
      return `${tool.name || ""} ${desc}`.toLowerCase();
    };

    const hasInjectToken = (obj) => {
      if (!obj || typeof obj !== "object") return false;
      for (const v of Object.values(obj)) {
        if (v === "_inject_from_previous" || v === "__INJECT__") return true;
        if (v && typeof v === "object" && hasInjectToken(v)) return true;
      }
      return false;
    };

    const isExplicitConsumer = (tool) =>
      !!tool.usePreviousOutput || this._containsInjectMarker(tool.params) || hasInjectToken(tool.params);

    const producerPattern = /\b(list|search|get|fetch|find|lookup|query|read|retrieve|export|create|add|new|generate|insert|sync|import)\b/i;
    const consumerVerbPattern = /\b(send|email|post|message|notify|share|forward|publish|broadcast|dispatch|slack)\b/i;

    // Assign task IDs if not present
    let taskIdCounter = 1;
    let sortedTools = [...tools]
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
      .map(tool => ({
        ...tool,
        id: tool.id || `t${taskIdCounter++}`,
      }));

    // =========================================================================
    // CRITICAL FIX: Make LIST actions depend on CREATE actions of same DocType
    // This prevents race conditions where LIST runs before CREATE commits to DB
    // =========================================================================
    const createActions = sortedTools.filter(t => /CREATE/i.test(t.name));
    const listActions = sortedTools.filter(t => /LIST/i.test(t.name));

    if (createActions.length > 0 && listActions.length > 0) {
      // Map DocType from action names like FRAPPE_CREATE_CUSTOMER -> CUSTOMER
      const getDocType = (actionName) => {
        const match = actionName.match(/(?:CREATE|LIST)_(.+)$/i);
        return match ? match[1].toUpperCase() : null;
      };

      for (const listTool of listActions) {
        const listDocType = getDocType(listTool.name);
        if (!listDocType) continue;

        // Find matching CREATE actions with same DocType (singular/plural variants)
        for (const createTool of createActions) {
          const createDocType = getDocType(createTool.name);
          if (!createDocType) continue;

          // Match same DocType (handle singular/plural: CUSTOMER vs CUSTOMERS)
          const isSameDocType =
            createDocType === listDocType ||
            createDocType + 'S' === listDocType ||
            createDocType === listDocType.replace(/S$/, '');

          if (isSameDocType) {
            console.log(`[ToolRouter] CREATE->LIST dependency: ${createTool.name} must complete before ${listTool.name}`);

            // Add dependency: LIST depends on CREATE
            if (!listTool.dependsOn) listTool.dependsOn = [];
            if (!listTool.dependsOn.includes(createTool.id)) {
              listTool.dependsOn.push(createTool.id);
            }
          }
        }
      }
    }

    // Find producers and consumers
    const producers = [];
    const consumers = new Set();
    const contentFieldById = new Map();

    for (const tool of sortedTools) {
      const actionText = actionTextFor(tool);
      const schema = selectedSchemas.get(tool.name);
      const contentField = this._pickInjectionFieldFromSchema(schema?.parameters);

      if (contentField) contentFieldById.set(tool.id, contentField);

      if (producerPattern.test(actionText)) producers.push(tool);

      const shouldConsume =
        !!contentField &&
        (isExplicitConsumer(tool) || dataSharingIntent || consumerVerbPattern.test(actionText));

      if (shouldConsume) consumers.add(tool.id);
    }

    // If we have both producers and consumers, set up data flow
    if (producers.length > 0 && consumers.size > 0) {
      // Get producer IDs for dependency tracking
      const producerIds = producers.map(p => p.id);

      const toolsWithDeps = sortedTools.map(tool => {
        if (!consumers.has(tool.id)) return tool;

        const contentField = contentFieldById.get(tool.id);
        if (!contentField) return tool;

        // Check if content field is empty or not set
        const currentValue = tool.params?.[contentField];
        const needsInjection =
          !currentValue ||
          currentValue === "" ||
          currentValue === "__INJECT__" ||
          currentValue === "_inject_from_previous";

        if (needsInjection) {
          console.log(`[ToolRouter] Auto-detected data dependency: ${producers.map(p => p.name).join(', ')} → ${tool.name}.${contentField}`);
          console.log(`[ToolRouter] Setting dependsOn: [${producerIds.join(', ')}]`);

          return {
            ...tool,
            usePreviousOutput: true,
            dependsOn: [...(tool.dependsOn || []), ...producerIds],
            params: {
              ...tool.params,
              [contentField]: "_inject_from_previous",
            },
          };
        }

        return tool;
      });

      // After setting dependencies, reorder tools so producers come before consumers
      // This ensures the correct execution order regardless of AI sequence numbers
      return this._topologicalSortTools(toolsWithDeps);
    }

    return sortedTools;
  }

  /**
   * Topological sort to ensure producers (search/get actions) come before consumers (send/create actions)
   * This respects the dependsOn relationships set by _enforceDataDependencies
   */
  _topologicalSortTools(tools) {
    const toolMap = new Map(tools.map(t => [t.id, t]));
    const visited = new Set();
    const result = [];

    const visit = (toolId) => {
      if (visited.has(toolId)) return;
      visited.add(toolId);

      const tool = toolMap.get(toolId);
      if (!tool) return;

      // Visit dependencies first (producers before consumers)
      for (const depId of (tool.dependsOn || [])) {
        visit(depId);
      }

      result.push(tool);
    };

    // Visit all tools
    for (const tool of tools) {
      visit(tool.id);
    }

    // Reassign sequence numbers based on new order
    return result.map((tool, index) => ({
      ...tool,
      sequence: index + 1,
    }));
  }

  // ===========================================================================
  // VALIDATION
  // ===========================================================================

  _validateAgainstSchemas(tools, selectedSchemas) {
    const missing = [];

    const validatedTools = tools.map((t, i) => {
      const schemaTool = selectedSchemas.get(t.name);
      const schema = schemaTool?.parameters;

      const out = {
        name: t.name,
        params: t.params || {},
        composio_action: schemaTool?.composio_action || t.name,
        sequence: t.sequence || i + 1,
      };

      if (!schema) return out;

      // Timezone check
      const tzMissing = this._findDateTimeMissingTimezone(out.params, schema);
      for (const field of tzMissing) {
        missing.push({
          tool: out.name,
          field,
          description: schema?.properties?.[field]?.description || field,
          type: schema?.properties?.[field]?.type || "string",
          reason: "datetime_missing_timezone",
        });
      }

      // Required fields check
      console.log(`[ToolRouter] Validating ${out.name}: schema.required=${JSON.stringify(schema?.required)}, params=${JSON.stringify(Object.keys(out.params))}`);
      this._collectMissingRequiredTopLevel(out.name, out.params, schema, missing);

      return out;
    });

    // Dedupe and sort
    const seen = new Set();
    const deduped = [];
    for (const m of missing) {
      const key = `${m.tool}.${m.field}.${m.reason || "required"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }

    deduped.sort((a, b) => {
      const sa = selectedSchemas.get(a.tool)?.parameters;
      const sb = selectedSchemas.get(b.tool)?.parameters;
      const pa = this._getFieldPriority(a.field, sa);
      const pb = this._getFieldPriority(b.field, sb);
      if (pa !== pb) return pa - pb;
      return `${a.tool}.${a.field}`.localeCompare(`${b.tool}.${b.field}`);
    });

    return { tools: validatedTools, missing: deduped };
  }

  _collectMissingRequiredTopLevel(toolName, params, schema, missingArr) {
    const required = Array.isArray(schema?.required) ? schema.required : [];
    for (const field of required) {
      const v = params?.[field];

      if (v === "_inject_from_previous") continue;

      const isNullish = v === undefined || v === null;
      const isEmptyString = typeof v === "string" && v.trim() === "";
      const isEmptyArray = Array.isArray(v) && v.length === 0;

      if (isNullish || isEmptyString || isEmptyArray) {
        missingArr.push({
          tool: toolName,
          field,
          description: schema?.properties?.[field]?.description || field,
          type: schema?.properties?.[field]?.type || "string",
          reason: "required_missing",
        });
      }
    }
  }

  _findDateTimeMissingTimezone(params, schema) {
    const props = schema?.properties || {};
    const missing = [];
    for (const [field, spec] of Object.entries(props)) {
      if (spec?.format !== "date-time") continue;
      const v = params?.[field];
      if (!v || typeof v !== "string") continue;
      if (v === "_inject_from_previous") continue;
      const hasTz = /([zZ]|[+\-]\d{2}:\d{2})$/.test(v);
      if (!hasTz) missing.push(field);
    }
    return missing;
  }

  _getFieldPriority(fieldName, schema) {
    const props = schema?.properties?.[fieldName] || {};
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const isRequired = required.includes(fieldName);

    const format = String(props.format || "").toLowerCase();
    const type = props.type;
    const fname = String(fieldName || "").toLowerCase();

    if (isRequired && (format === "date-time" || format === "date")) return 1;
    if (isRequired && (format === "email" || format === "uri")) return 1;
    if (isRequired && type === "array" && props.items?.format === "email") return 1;

    const idish =
      /(^|_)(id|key)(_|$)/i.test(fname) ||
      /(project|workspace|space|board|list|channel|conversation|repo|team|org|account)/i.test(fname) ||
      /(^to$|recipient|assignee|owner)/i.test(fname);

    if (isRequired && idish) return 1;

    const titleish = /(summary|subject|title|name)/i.test(fname);
    if (isRequired && titleish) return 2;

    if (isRequired && (type === "string" || !type)) return 2;

    if (Array.isArray(props.enum) && props.enum.length > 0) return isRequired ? 2 : 3;

    return isRequired ? 3 : 5;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  _buildAjv() {
    let Ajv;
    try {
      Ajv = require("ajv");
    } catch (_) {
      return null;
    }

    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      coerceTypes: true,
      useDefaults: true,
      allowUnionTypes: true,
    });

    try {
      require("ajv-formats")(ajv);
    } catch (_) { }

    return ajv;
  }

  _formatContextForPrompt(context) {
    const parts = [];
    if (context?.entityId) parts.push(`entityId: ${context.entityId}`);
    if (context?.userId) parts.push(`userId: ${context.userId}`);

    if (context?.storedResults && Object.keys(context.storedResults).length > 0) {
      parts.push(
        `storedResults keys: ${Object.keys(context.storedResults).slice(0, 12).join(", ")}`
      );
    }

    if (Array.isArray(context?.conversationHistory) && context.conversationHistory.length > 0) {
      const last = context.conversationHistory.slice(-6);
      parts.push(
        `conversationHistory (last ${last.length}):\n${last
          .map((h) => `${h.role}: ${String(h.content || h.text || h.message || "").slice(0, 200)}`)
          .join("\n")}`
      );
    }

    return parts.length ? parts.join("\n") : "(none)";
  }

  _nowContext() {
    const now = new Date();
    const today = this._formatDateInTz(now, this.USER_TIMEZONE);
    const tomorrowDate = new Date(now.getTime() + 86400000);
    const yesterdayDate = new Date(now.getTime() - 86400000);

    const tomorrow = this._formatDateInTz(tomorrowDate, this.USER_TIMEZONE);
    const yesterday = this._formatDateInTz(yesterdayDate, this.USER_TIMEZONE);

    const offset = this._getOffsetForTimeZone(now, this.USER_TIMEZONE);
    const nowRfc3339 = `${now.toISOString().replace(".000", "")} (local offset ${offset})`;

    return { nowRfc3339, today, tomorrow, yesterday, offset };
  }

  _formatDateInTz(date, timeZone) {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return dtf.format(date);
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

    const offMin = -date.getTimezoneOffset();
    const sign = offMin >= 0 ? "+" : "-";
    const abs = Math.abs(offMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${sign}${hh}:${mm}`;
  }

  _parseJson(raw) {
    if (!raw) return null;
    let s = String(raw).trim();

    // Some open-weight models expose their internal tool-call delimiters even
    // when the prompt requests JSON. They are not part of the JSON payload.
    s = s
      .replace(/<\|(?:tool_call|tool_calls|assistant|analysis|final|end)[^|]*\|>/gi, "")
      .replace(/<\/?(?:tool_call|tool_calls)>/gi, "")
      .trim();

    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) s = fenced[1].trim();

    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first !== -1 && last !== -1) s = s.slice(first, last + 1);

    try {
      return JSON.parse(s);
    } catch (e) {
      console.error("[ToolRouter] JSON parse failed:", e.message);
      return null;
    }
  }
}

module.exports = ToolRouter;
