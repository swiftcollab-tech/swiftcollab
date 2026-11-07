// backend/composioService.js
//
// Composio integration service for SwiftCollab
// Handles tool execution through Composio's unified API
//
// FULLY DYNAMIC - No hardcoded app/action names
// All apps and actions are discovered dynamically from Composio API

const { Composio } = require("@composio/core");

// =============================================================================
// LEGACY MAPPINGS (kept for backwards compatibility with existing code)
// These are ONLY used for mapping SwiftCollab UI app IDs to Composio toolkit names
// All action discovery is done dynamically
// =============================================================================
const APP_TO_COMPOSIO_TOOLKIT = {
  // Productivity apps
  gcalender: "GOOGLECALENDAR",
  slack: "SLACK",
  gmail: "GMAIL",
  jira: "JIRA",
  asana: "ASANA",
  clickup: "CLICKUP",
  zoom: "ZOOM",
  notion: "NOTION",
  trello: "TRELLO",
  monday: "MONDAY",

  // CRM & Business
  salesforce: "SALESFORCE",
  axonaut: "AXONAUT",
  hubspot: "HUBSPOT",
  zendesk: "ZENDESK",
  intercom: "INTERCOM",
  servicenow: "SERVICENOW",
  workday: "WORKDAY",

  // Developer tools
  github: "GITHUB",
  linear: "LINEAR",

  // E-commerce & Payments
  stripe: "STRIPE",
  shopify: "SHOPIFY",

  // Productivity & Storage
  airtable: "AIRTABLE",
  dropbox: "DROPBOX",
  drive: "GOOGLEDRIVE",
  docs: "GOOGLEDOCS",
  sheets: "GOOGLESHEETS",
  outlook: "OUTLOOK",

  // Communication & Social
  discord: "DISCORD",
  twitter: "TWITTER",
  linkedin: "LINKEDIN",
  facebook: "FACEBOOK",
  instagram: "INSTAGRAM",
  youtube: "YOUTUBE",

  // Email Marketing
  sendgrid: "SENDGRID",
  mailchimp: "MAILCHIMP",
};

// Reverse mapping for display purposes
const COMPOSIO_TOOLKIT_TO_APP = Object.entries(APP_TO_COMPOSIO_TOOLKIT).reduce(
  (acc, [appId, toolkit]) => {
    acc[toolkit] = appId;
    return acc;
  },
  {}
);

// The Composio SDK returns tools in OpenAI-function format
// ({ type: 'function', function: { name, description, parameters } }).
// Keep compatibility with direct tool objects used by older SDK responses.
const unwrapToolDefinition = (tool) => tool?.function || tool;

// =============================================================================
// CACHE CONFIGURATION
// =============================================================================
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class ComposioService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.composio = new Composio({ apiKey });
    this.entityId = "default"; // Can be changed for multi-user support

    // Dynamic caches with TTL
    this._cache = {
      connectedApps: new Map(),      // entityId -> { data, timestamp }
      appActions: new Map(),          // appName -> { data, timestamp }
      actionSchemas: new Map(),       // actionName -> { data, timestamp }
      allActions: new Map(),          // entityId -> { data, timestamp }
      availableToolkits: null,        // { data, timestamp }
    };
  }

  // ===========================================================================
  // CACHE HELPERS
  // ===========================================================================

  /**
   * Check if cached data is still valid
   */
  _isCacheValid(cacheEntry) {
    if (!cacheEntry) return false;
    return (Date.now() - cacheEntry.timestamp) < CACHE_TTL_MS;
  }

  /**
   * Get from cache if valid, otherwise return null
   */
  _getFromCache(cache, key) {
    const entry = cache.get(key);
    if (this._isCacheValid(entry)) {
      return entry.data;
    }
    return null;
  }

  /**
   * Set cache entry with timestamp
   */
  _setCache(cache, key, data) {
    cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Clear all caches (useful after connections change)
   */
  clearCache() {
    this._cache.connectedApps.clear();
    this._cache.appActions.clear();
    this._cache.actionSchemas.clear();
    this._cache.allActions.clear();
    this._cache.availableToolkits = null;
    console.log('[Composio] Cache cleared');
  }

  /**
   * Clear cache for a specific entity (after they connect/disconnect an app)
   */
  clearEntityCache(entityId) {
    this._cache.connectedApps.delete(entityId);
    this._cache.allActions.delete(entityId);
    console.log(`[Composio] Cache cleared for entity: ${entityId}`);
  }

  // ===========================================================================
  // DYNAMIC DISCOVERY METHODS
  // ===========================================================================

  /**
   * Get all apps the user has connected (dynamically discovered)
   * @param {string} entityId - Entity ID (user ID)
   * @returns {Promise<Array>} Array of connected app objects with name, toolkit, status
   */
  async getConnectedApps(entityId = this.entityId) {
    // Check cache first
    const cached = this._getFromCache(this._cache.connectedApps, entityId);
    if (cached) {
      console.log(`[Composio] getConnectedApps cache hit for ${entityId}`);
      return cached;
    }

    try {
      console.log(`[Composio] Fetching connected apps for entityId: ${entityId}`);

      // Get all connected accounts for this user
      const accounts = await this.composio.connectedAccounts.list({
        statuses: ['ACTIVE'],
        userIds: [entityId],
      });

      const connectedApps = (accounts.items || []).map(account => ({
        id: account.id,
        appName: account.toolkit?.slug || account.appName || 'unknown',
        toolkit: (account.toolkit?.slug || account.appName || '').toUpperCase(),
        displayName: account.toolkit?.name || account.appName || 'Unknown App',
        status: account.status,
        connectedAt: account.createdAt,
        // Include connection metadata if available
        metadata: {
          accountId: account.id,
          memberEmail: account.member?.email,
        },
      }));

      // Cache the result
      this._setCache(this._cache.connectedApps, entityId, connectedApps);
      console.log(`[Composio] Found ${connectedApps.length} connected apps for ${entityId}`);

      return connectedApps;
    } catch (error) {
      console.error(`[Composio] getConnectedApps error:`, error.message);
      return [];
    }
  }

  /**
   * Get all actions available for an app (dynamically discovered)
   * @param {string} appName - App/toolkit name (e.g., 'JIRA', 'GMAIL', 'jira', 'gmail')
   * @param {string} entityId - Optional entity ID (defaults to this.entityId)
   * @returns {Promise<Array>} Array of action objects with name, description, tags
   */
  async getAppActions(appName, entityId = this.entityId) {
    const toolkit = appName.toUpperCase();

    // Check cache first
    const cached = this._getFromCache(this._cache.appActions, toolkit);
    if (cached) {
      console.log(`[Composio] getAppActions cache hit for ${toolkit}`);
      return cached;
    }

    try {
      console.log(`[Composio] Fetching actions for toolkit: ${toolkit}`);

      // Get all tools for this toolkit - API requires entityId as first param
      // Use limit: 100 to get all tools (default is only 20)
      const tools = await this.composio.tools.get(entityId, {
        toolkits: [toolkit],
        limit: 5000,
      });

      const actions = (tools || []).map(rawTool => {
        const tool = unwrapToolDefinition(rawTool);
        return {
          name: tool?.name,
          description: tool?.description || '',
          toolkit: toolkit,
          tags: tool?.tags || [],
          // Indicate if it's a read or write operation
          operationType: this._inferOperationType(tool?.name || ''),
        };
      });

      // Cache the result
      this._setCache(this._cache.appActions, toolkit, actions);
      console.log(`[Composio] Found ${actions.length} actions for ${toolkit}`);

      return actions;
    } catch (error) {
      console.error(`[Composio] getAppActions error for ${appName}:`, error.message);
      return [];
    }
  }

  /**
   * Get full schema for an action including all parameter details
   * @param {string} actionName - Full action name (e.g., 'JIRA_SEARCH_ISSUES')
   * @param {string} entityId - Optional entity ID (defaults to this.entityId)
   * @returns {Promise<Object>} Schema object with name, description, parameters array
   */
  async getActionSchema(actionName, entityId = this.entityId) {
    // Check cache first
    const cached = this._getFromCache(this._cache.actionSchemas, actionName);
    if (cached) {
      console.log(`[Composio] getActionSchema cache hit for ${actionName}`);
      return cached;
    }

    try {
      // Derive toolkit from action name (e.g., JIRA_SEARCH_ISSUES -> JIRA)
      const toolkitMatch = actionName.match(/^([A-Z]+)_/);
      const toolkit = toolkitMatch ? toolkitMatch[1] : null;

      if (!toolkit) {
        console.error(`[Composio] Cannot derive toolkit from action: ${actionName}`);
        return null;
      }

      console.log(`[Composio] Fetching schema for action: ${actionName} (toolkit: ${toolkit})`);

      // Get tools for the toolkit - API requires entityId as first param
      // Use limit: 100 to get all tools (default is only 20)
      const tools = await this.composio.tools.get(entityId, {
        toolkits: [toolkit],
        limit: 5000,
      });

      const tool = tools
        ?.map(unwrapToolDefinition)
        .find(t => t?.name === actionName);

      if (!tool) {
        console.error(`[Composio] Action not found: ${actionName}`);
        return null;
      }

      // Build detailed schema
      const schema = {
        name: tool.name,
        description: tool.description || '',
        toolkit: toolkit,
        operationType: this._inferOperationType(tool.name),
        parameters: this._extractParameters(tool.parameters),
        // Backward compatibility: include properties for code expecting old format
        properties: tool.parameters?.properties || {},
        required: tool.parameters?.required || [],
        rawSchema: tool.parameters, // Keep raw schema for advanced use
      };

      // Cache the result
      this._setCache(this._cache.actionSchemas, actionName, schema);
      console.log(`[Composio] Schema cached for ${actionName} with ${schema.parameters.length} parameters`);

      return schema;
    } catch (error) {
      console.error(`[Composio] getActionSchema error for ${actionName}:`, error.message);
      return null;
    }
  }

  /**
   * Get flat list of all available actions for a user (based on connected apps)
   * @param {string} entityId - Entity ID (user ID)
   * @returns {Promise<Array>} Flat array of all available action objects
   */
  async getAllAvailableActions(entityId = this.entityId) {
    // Check cache first
    const cached = this._getFromCache(this._cache.allActions, entityId);
    if (cached) {
      console.log(`[Composio] getAllAvailableActions cache hit for ${entityId}`);
      return cached;
    }

    try {
      console.log(`[Composio] Fetching all available actions for entityId: ${entityId}`);

      // First get all connected apps
      const connectedApps = await this.getConnectedApps(entityId);

      if (connectedApps.length === 0) {
        console.log(`[Composio] No connected apps for ${entityId}`);
        return [];
      }

      // Get actions for each connected app in parallel
      const toolkits = connectedApps.map(app => app.toolkit);
      const actionPromises = toolkits.map(toolkit => this.getAppActions(toolkit));
      const actionArrays = await Promise.all(actionPromises);

      // Flatten all actions into single array
      const allActions = actionArrays.flat();

      // Cache the result
      this._setCache(this._cache.allActions, entityId, allActions);
      console.log(`[Composio] Found ${allActions.length} total actions across ${toolkits.length} apps for ${entityId}`);

      return allActions;
    } catch (error) {
      console.error(`[Composio] getAllAvailableActions error:`, error.message);
      return [];
    }
  }

  /**
   * Extract parameters into a standardized array format
   * @param {Object} parametersSchema - JSON Schema parameters object
   * @returns {Array} Array of parameter objects
   */
  _extractParameters(parametersSchema) {
    if (!parametersSchema || !parametersSchema.properties) {
      return [];
    }

    const required = parametersSchema.required || [];
    const properties = parametersSchema.properties;

    return Object.entries(properties).map(([name, schema]) => ({
      name,
      type: schema.type || 'string',
      required: required.includes(name),
      description: schema.description || '',
      default: schema.default,
      enum: schema.enum || null,
      format: schema.format || null,
      // Include nested properties for complex types
      properties: schema.properties ? this._extractParameters(schema) : null,
      items: schema.items ? {
        type: schema.items.type,
        properties: schema.items.properties ? this._extractParameters(schema.items) : null,
      } : null,
    }));
  }

  /**
   * Infer operation type from action name
   * @param {string} actionName - Action name
   * @returns {string} 'read' or 'write'
   */
  _inferOperationType(actionName) {
    const writeKeywords = ['CREATE', 'SEND', 'POST', 'UPDATE', 'DELETE', 'ADD', 'REMOVE', 'SET'];
    const upperName = actionName.toUpperCase();

    for (const keyword of writeKeywords) {
      if (upperName.includes(keyword)) {
        return 'write';
      }
    }
    return 'read';
  }

  /**
   * Set the entity ID for multi-user scenarios
   */
  setEntityId(entityId) {
    this.entityId = entityId;
  }

  /**
   * Convert SwiftCollab app IDs to Composio toolkit names
   */
  getComposioToolkits(appIds) {
    return appIds
      .map((id) => APP_TO_COMPOSIO_TOOLKIT[id])
      .filter(Boolean);
  }

  /**
   * Check if a user prompt is related to the selected apps
   * Uses OpenAI to analyze the prompt and determine which apps it relates to
   */
  async analyzePromptRelevance(prompt, selectedAppIds, openAIApiKey) {
    const selectedToolkits = this.getComposioToolkits(selectedAppIds);

    if (selectedToolkits.length === 0) {
      return {
        isRelevant: false,
        message: "No supported apps are selected. Please drag apps into the workspace first.",
        relatedApps: [],
        unresolvedApps: [],
      };
    }

    // Use OpenAI to analyze which apps the prompt relates to
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAIApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `You are an analyzer that determines which apps a user's request relates to.

Given a user prompt and a list of available apps, determine:
1. Which apps from the available list are needed to fulfill the request
2. Which apps the request mentions that are NOT in the available list

Available apps: ${selectedToolkits.join(", ")}

You MUST respond with ONLY a JSON object in this format:
{
  "relatedApps": ["APP1", "APP2"],
  "unresolvedApps": ["APP3"],
  "reasoning": "brief explanation"
}

Rules:
- relatedApps: Only include apps from the available list that are needed
- unresolvedApps: Apps mentioned in the request but NOT in the available list
- If the request needs an app not in the available list, include it in unresolvedApps
- Map common terms: "calendar" -> GOOGLECALENDAR, "email/mail" -> GMAIL, "meeting" -> GOOGLECALENDAR or ZOOM

Examples:
- "Send an email" with available [SLACK] -> relatedApps: [], unresolvedApps: [GMAIL]
- "Send a slack message" with available [SLACK, GMAIL] -> relatedApps: [SLACK], unresolvedApps: []
- "Schedule a meeting at 3pm" with available [SLACK] -> relatedApps: [], unresolvedApps: [GOOGLECALENDAR]
- "Schedule a meeting at 3pm" with available [GOOGLECALENDAR, SLACK] -> relatedApps: [GOOGLECALENDAR], unresolvedApps: []`,
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to analyze prompt relevance");
    }

    const data = await response.json();
    let analysis;

    try {
      analysis = JSON.parse(data.choices[0].message.content);
    } catch (e) {
      console.error("Failed to parse relevance analysis:", data.choices[0].message.content);
      // Fallback: assume all selected apps are relevant
      return {
        isRelevant: true,
        relatedApps: selectedToolkits,
        unresolvedApps: [],
        message: null,
      };
    }

    const relatedApps = analysis.relatedApps || [];
    const unresolvedApps = analysis.unresolvedApps || [];

    // If there are unresolved apps, the request cannot be fulfilled
    if (unresolvedApps.length > 0) {
      const unresolvedNames = unresolvedApps.map(
        (toolkit) => COMPOSIO_TOOLKIT_TO_APP[toolkit] || toolkit.toLowerCase()
      );
      return {
        isRelevant: false,
        relatedApps,
        unresolvedApps,
        message: `I can't complete this request because it requires apps that aren't in your workspace: ${unresolvedNames.join(", ")}. Please drag those apps into AI OS or Work OS first.`,
      };
    }

    // If no apps are related, the request might be general or unrelated
    if (relatedApps.length === 0) {
      return {
        isRelevant: false,
        relatedApps: [],
        unresolvedApps: [],
        message: "I couldn't determine which apps this request relates to. Please be more specific about what you'd like me to do with your connected apps.",
      };
    }

    return {
      isRelevant: true,
      relatedApps,
      unresolvedApps: [],
      message: null,
    };
  }

  /**
   * Get available tools for the selected apps
   */
  async getToolsForApps(appIds) {
    const toolkits = this.getComposioToolkits(appIds);

    if (toolkits.length === 0) {
      return [];
    }

    try {
      // Use limit: 100 to get all tools (default is only 20)
      const tools = await this.composio.tools.get(this.entityId, {
        toolkits,
        limit: 5000,
      });
      return tools.map(unwrapToolDefinition);
    } catch (error) {
      console.error("Error fetching Composio tools:", error);
      throw error;
    }
  }

  /**
   * Execute a natural language request through Composio
   * This is the main method that processes user prompts
   */
  async executeNaturalLanguageRequest({
    prompt,
    selectedAppIds,
    openAIApiKey,
    conversationHistory = [],
  }) {
    // Step 1: Analyze if the prompt relates to selected apps
    const relevanceCheck = await this.analyzePromptRelevance(
      prompt,
      selectedAppIds,
      openAIApiKey
    );

    if (!relevanceCheck.isRelevant) {
      return {
        success: false,
        type: "app_not_available",
        message: relevanceCheck.message,
        relatedApps: relevanceCheck.relatedApps,
        unresolvedApps: relevanceCheck.unresolvedApps,
      };
    }

    // Step 2: Get tools for the relevant apps only
    const relevantAppIds = selectedAppIds.filter((id) =>
      relevanceCheck.relatedApps.includes(APP_TO_COMPOSIO_TOOLKIT[id])
    );

    try {
      const tools = await this.getToolsForApps(relevantAppIds);

      if (!tools || tools.length === 0) {
        return {
          success: false,
          type: "no_tools",
          message: "No tools available for the selected apps. You may need to connect your accounts first.",
        };
      }

      // Step 3: Use OpenAI to determine which tool to call and with what parameters
      const toolDescriptions = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

      const planResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAIApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0,
          messages: [
            {
              role: "system",
              content: `You are a friendly, conversational AI assistant that helps users accomplish tasks across their apps.

Available tools:
${JSON.stringify(toolDescriptions, null, 2)}

Today's date: ${new Date().toISOString().split('T')[0]}

You MUST respond with ONLY a JSON object in this format:
{
  "needsMoreInfo": boolean,
  "followUpQuestions": [
    { "id": "param_name", "question": "Friendly conversational question" }
  ],
  "toolCalls": [
    {
      "toolName": "TOOL_NAME",
      "parameters": { "param1": "value1" }
    }
  ],
  "explanation": "Brief, friendly explanation of what will be done",
  "cannotComplete": boolean,
  "cannotCompleteReason": "Why it can't be completed"
}

CRITICAL RULES:
1. BE CONVERSATIONAL: Write follow-up questions like a friendly assistant, not a form:
   - BAD: "What is the project key?"
   - GOOD: "Which project should I create this issue in? (e.g., PROJ, DEV, TEAM)"

2. SMART DEFAULTS for Jira:
   - If creating an issue and no issue type specified, default to "Task"
   - For project key, if only one project likely exists or user mentioned a project name, try to use it
   - Ask nicely: "I'll create a Task in your Jira. Which project should I add it to?"

3. BE PROACTIVE:
   - If you can reasonably infer a value, DO IT rather than asking
   - Only ask for TRULY required info you can't figure out

4. MULTI-STEP TASKS:
   - If you need to fetch info first (like project list), include that tool call BEFORE the main action
   - Example: For "create Jira issue", first call JIRA_GET_ALL_PROJECTS if project unknown

5. SMART INFERENCE:
   - "today" = ${new Date().toISOString().split('T')[0]}
   - "tomorrow" = next day
   - "3pm" = 15:00 in ISO format
   - "next week" = add 7 days

6. EXECUTION READY:
   - When you have ALL required params, set needsMoreInfo: false and provide toolCalls
   - Include a friendly explanation like "Got it! Creating that issue for you now..."`,
            },
            ...conversationHistory.map((msg) => ({
              role: msg.role,
              content: msg.text,
            })),
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      });

      if (!planResponse.ok) {
        const errorText = await planResponse.text();
        console.error("OpenAI planning error:", errorText);
        throw new Error("Failed to plan tool execution");
      }

      const planData = await planResponse.json();
      let plan;

      try {
        plan = JSON.parse(planData.choices[0].message.content);
      } catch (e) {
        console.error("Failed to parse plan:", planData.choices[0].message.content);
        return {
          success: false,
          type: "planning_error",
          message: "I had trouble understanding how to execute that request. Please try rephrasing.",
        };
      }

      // Step 4: If more info is needed, return follow-up questions
      if (plan.needsMoreInfo && plan.followUpQuestions?.length > 0) {
        return {
          success: true,
          type: "followup",
          followUpQuestions: plan.followUpQuestions,
          explanation: plan.explanation,
        };
      }

      // Step 5: Execute the tool calls
      if (!plan.toolCalls || plan.toolCalls.length === 0) {
        return {
          success: false,
          type: "no_action",
          message: plan.explanation || "I couldn't determine what action to take. Please be more specific.",
        };
      }

      const results = [];
      for (const toolCall of plan.toolCalls) {
        try {
          console.log(`[Composio] Executing tool: ${toolCall.toolName}`, toolCall.parameters);

          const result = await this.composio.tools.execute({
            actionName: toolCall.toolName,
            params: toolCall.parameters,
            entityId: this.entityId,
          });

          results.push({
            tool: toolCall.toolName,
            success: true,
            result,
          });
        } catch (toolError) {
          console.error(`[Composio] Tool execution error for ${toolCall.toolName}:`, toolError);
          results.push({
            tool: toolCall.toolName,
            success: false,
            error: toolError.message,
          });
        }
      }

      // Step 6: Generate a human-readable response
      const summaryResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openAIApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          temperature: 0.3,
          messages: [
            {
              role: "system",
              content: "You are a helpful assistant that summarizes the results of tool executions in a friendly, concise way. Focus on what was accomplished and any important details from the results.",
            },
            {
              role: "user",
              content: `User requested: "${prompt}"

Tool execution results:
${JSON.stringify(results, null, 2)}

Please provide a brief, friendly summary of what was done.`,
            },
          ],
        }),
      });

      let summary = "Actions completed.";
      if (summaryResponse.ok) {
        const summaryData = await summaryResponse.json();
        summary = summaryData.choices[0].message.content;
      }

      return {
        success: true,
        type: "completed",
        message: summary,
        results,
        explanation: plan.explanation,
      };
    } catch (error) {
      console.error("[Composio] Execution error:", error);
      return {
        success: false,
        type: "error",
        message: `An error occurred: ${error.message}`,
      };
    }
  }

  /**
   * Check connection status for apps
   */
  async checkConnections(appIds) {
    const toolkits = this.getComposioToolkits(appIds);
    const connectionStatus = {};

    for (const toolkit of toolkits) {
      try {
        // Try to get tools for this toolkit - if it fails, likely not connected
        // Use limit: 100 to get all tools (default is only 20)
        const tools = await this.composio.tools.get(this.entityId, {
          toolkits: [toolkit],
          limit: 5000,
        });
        connectionStatus[toolkit] = {
          connected: tools && tools.length > 0,
          toolCount: tools?.length || 0,
        };
      } catch (error) {
        connectionStatus[toolkit] = {
          connected: false,
          error: error.message,
        };
      }
    }

    return connectionStatus;
  }

  /**
   * Initiate connection for an app (OAuth flow)
   * ALWAYS uses the project's auth config to ensure custom branding (logo, app name) is applied
   * @param {string} appIdOrToolkit - Can be either an app ID (like 'slack') or toolkit name (like 'SLACK')
   * @param {string|object} redirectUrl - URL to redirect to after OAuth (optional)
   * @param {object} connectionParams - Additional connection params (e.g., subdomain for JIRA)
   * @param {string} entityId - Optional entity ID override
   */
  async initiateConnection(appIdOrToolkit, redirectUrl, connectionParams = {}, entityId = null) {
    // Check if it's already a toolkit name (uppercase) or an app ID (lowercase)
    let toolkit = appIdOrToolkit;
    let effectiveRedirectUrl = redirectUrl;
    let effectiveConnectionParams = connectionParams;
    const effectiveEntityId = entityId || this.entityId;

    if (redirectUrl && typeof redirectUrl === "object" && !Array.isArray(redirectUrl)) {
      effectiveConnectionParams = redirectUrl;
      effectiveRedirectUrl = null;
    }

    // If it looks like a toolkit name (all uppercase), use it directly
    if (appIdOrToolkit === appIdOrToolkit.toUpperCase()) {
      toolkit = appIdOrToolkit.toLowerCase(); // toolkits.authorize needs lowercase
    } else {
      // Otherwise, try to map from app ID
      const mapped = APP_TO_COMPOSIO_TOOLKIT[appIdOrToolkit];
      if (mapped) {
        toolkit = mapped.toLowerCase();
      } else {
        toolkit = appIdOrToolkit.toLowerCase();
      }
    }

    try {
      console.log(`[Composio] Initiating connection for toolkit: ${toolkit} (user: ${effectiveEntityId})`);
      if (effectiveRedirectUrl) console.log(`[Composio] Redirect URL: ${effectiveRedirectUrl}`);
      console.log(`[Composio] Connection params:`, effectiveConnectionParams);

      // Prefer Composio-managed / OAuth auth configs. Never use an API_KEY
      // config on this path — that is a separate user-selected connect method.
      const configs = await this.composio.authConfigs.list();
      const matching = (configs.items || []).filter(
        (c) => c.toolkit?.slug?.toLowerCase() === toolkit.toLowerCase()
      );
      const authConfig =
        matching.find((c) => c.isComposioManaged) ||
        matching.find((c) => {
          const scheme = String(c.authScheme || c.auth_scheme || c.type || "").toUpperCase();
          return scheme.includes("OAUTH");
        }) ||
        matching.find((c) => {
          const scheme = String(c.authScheme || c.auth_scheme || c.type || "").toUpperCase();
          return scheme !== "API_KEY";
        });

      if (authConfig) {
        console.log(`[Composio] Using auth config: ${authConfig.id} for ${toolkit} (custom branding enabled)`);

        // Composio-managed OAuth configurations must use the Connect Link endpoint.
        // The previous `initiate()` endpoint has been retired for that auth type.
        // Custom OAuth and non-OAuth configs retain the legacy initiate flow because
        // they can require pre-filled connection data.
        let connectionRequest;
        const linkOptions = effectiveRedirectUrl
          ? { callbackUrl: effectiveRedirectUrl }
          : undefined;

        if (authConfig.isComposioManaged !== false) {
          try {
            connectionRequest = await this.composio.connectedAccounts.link(
              effectiveEntityId,
              authConfig.id,
              linkOptions
            );
          } catch (linkError) {
            if (authConfig.isComposioManaged) {
              throw linkError;
            }
            connectionRequest = await this.composio.connectedAccounts.initiate(
              effectiveEntityId,
              authConfig.id,
              {
                data: effectiveConnectionParams || {},
                allowMultiple: true,
              }
            );
          }
        } else {
          try {
            connectionRequest = await this.composio.connectedAccounts.initiate(
              effectiveEntityId,
              authConfig.id,
              {
                data: effectiveConnectionParams || {},
                allowMultiple: true,
              }
            );
          } catch (error) {
            // Older SDK responses may not expose isComposioManaged. Retry only
            // the documented retired-endpoint error with the supported link flow.
            if (!error.message?.includes('Composio-managed OAuth auth configs is no longer supported')) {
              throw error;
            }

            connectionRequest = await this.composio.connectedAccounts.link(
              effectiveEntityId,
              authConfig.id,
              linkOptions
            );
          }
        }

        console.log(`[Composio] Connection request created (Connect Link):`, connectionRequest);

        return this._formatConnectionRequest(connectionRequest);
      }

      // Fallback: No OAuth auth config found - use toolkits.authorize (won't have custom branding)
      console.warn(`[Composio] No OAuth auth config found for ${toolkit}, falling back to default (no custom branding)`);

      const connectionRequest = await this.composio.toolkits.authorize(
        effectiveEntityId,
        toolkit
      );

      console.log(`[Composio] Connection request created:`, connectionRequest);

      return this._formatConnectionRequest(connectionRequest);
    } catch (error) {
      console.error(`[Composio] Connection initiation error for ${appIdOrToolkit}:`, error);

      // Check if it's a "no default auth config" error
      if (error.message?.includes('No Default auth config') || error.message?.includes('auth config')) {
        const appName = appIdOrToolkit.toUpperCase();
        throw new Error(
          `${appName} requires OAuth configuration in Composio dashboard. ` +
          `Please visit https://app.composio.dev/ and configure ${appName} integration with your OAuth credentials.`
        );
      }

      // Check if it's a "missing required fields" error (like subdomain)
      if (error.message?.includes('Missing required fields')) {
        throw error; // Re-throw with original message so frontend can show the fields modal
      }

      throw error;
    }
  }

  /**
   * Normalize Composio connect-link / authorize responses.
   * Different SDK versions expose the sign-in URL under different keys.
   */
  _formatConnectionRequest(connectionRequest) {
    const redirectUrl =
      connectionRequest?.redirectUrl ||
      connectionRequest?.redirect_url ||
      connectionRequest?.url ||
      connectionRequest?.link ||
      null;

    return {
      connectionId: connectionRequest?.id || connectionRequest?.connectionId || null,
      redirectUrl,
      status: connectionRequest?.status,
      _connectionRequest: connectionRequest,
    };
  }

  /**
   * Wait for a connection to become active
   * @param {string} connectionId - The connection ID to wait for
   * @param {number} timeout - Timeout in milliseconds (default 60000)
   */
  async waitForConnection(connectionId, timeout = 60000) {
    try {
      console.log(`[Composio] Waiting for connection ${connectionId} to become active...`);
      const connectedAccount = await this.composio.connectedAccounts.waitForConnection(connectionId, timeout);
      console.log(`[Composio] Connection ${connectionId} is now active:`, connectedAccount);
      return connectedAccount;
    } catch (error) {
      console.error(`[Composio] Error waiting for connection:`, error);
      throw error;
    }
  }

  /**
   * Get a specific connected account by ID
   * @param {string} connectionId - The connection ID to get
   */
  async getConnection(connectionId) {
    try {
      const account = await this.composio.connectedAccounts.get(connectionId);
      return account;
    } catch (error) {
      console.error(`[Composio] Error getting connection:`, error);
      throw error;
    }
  }

  /**
   * List all connected accounts (optionally filtered by toolkit)
   * Filters by entityId for per-user account isolation
   * @param {string[]} toolkitSlugs - Optional array of toolkit slugs to filter by
   * @param {string} entityId - Optional entity ID override
   */
  async listConnectedAccounts(toolkitSlugs = [], entityId = null) {
    try {
      const effectiveEntityId = entityId || this.entityId;
      const params = {
        statuses: ["ACTIVE"],
        userIds: [effectiveEntityId], // Filter by entityId for per-user isolation
      };
      if (toolkitSlugs.length > 0) {
        params.toolkitSlugs = toolkitSlugs.map(t => t.toLowerCase());
      }
      console.log(`[Composio] Listing connected accounts for entityId ${effectiveEntityId} with params:`, params);
      const accounts = await this.composio.connectedAccounts.list(params);
      console.log(`[Composio] Found ${accounts.items?.length || 0} connected accounts for entityId ${effectiveEntityId}`);
      return accounts;
    } catch (error) {
      console.error(`[Composio] Error listing connected accounts:`, error);
      throw error;
    }
  }

  /**
   * Disconnect every active account for one toolkit owned by this user entity.
   * Listing with both toolkit and user filters prevents one user from deleting
   * another user's Composio account even if a connection id is guessed.
   */
  async disconnectToolkit(appIdOrToolkit, entityId = null) {
    const effectiveEntityId = entityId || this.entityId;
    const toolkit = APP_TO_COMPOSIO_TOOLKIT[appIdOrToolkit]
      || String(appIdOrToolkit || '').toUpperCase();
    if (!toolkit) throw new Error('Toolkit is required to disconnect an account');

    const accounts = await this.listConnectedAccounts([toolkit], effectiveEntityId);
    const connectionIds = (accounts?.items || []).map(account => account.id).filter(Boolean);
    for (const connectionId of connectionIds) {
      await this.composio.connectedAccounts.delete(connectionId);
    }
    this.clearEntityCache(effectiveEntityId);
    return { disconnected: connectionIds.length, connectionIds, toolkit };
  }

  /**
   * Normalize parameters for Composio actions
   * Converts legacy/alias parameter names to canonical Composio names
   */
  _normalizeParams(actionName, params) {
    if (!params) return params;

    const normalized = { ...params };

    // Slack parameter normalization
    if (actionName.startsWith('SLACK_')) {
      // Convert message → text (SLACK_SEND_MESSAGE uses 'text', not 'message')
      if (normalized.message && !normalized.text && !normalized.markdown_text) {
        normalized.text = normalized.message;
        delete normalized.message;
        console.log('[Composio] Normalized: message → text');
      }

      // Convert channel_id → channel (SLACK_SEND_MESSAGE uses 'channel')
      if (normalized.channel_id && !normalized.channel) {
        normalized.channel = normalized.channel_id;
        delete normalized.channel_id;
        console.log('[Composio] Normalized: channel_id → channel');
      }

      // Remove # prefix from channel name if present
      if (normalized.channel && normalized.channel.startsWith('#')) {
        normalized.channel = normalized.channel.slice(1);
        console.log('[Composio] Normalized: removed # from channel name');
      }
    }

    // Jira parameter normalization
    if (actionName.startsWith('JIRA_')) {
      // Convert maxResults → max_results (Composio uses snake_case)
      if (normalized.maxResults !== undefined && normalized.max_results === undefined) {
        normalized.max_results = normalized.maxResults;
        delete normalized.maxResults;
        console.log('[Composio] Normalized: maxResults → max_results');
      }
    }

    // Gmail reply-to-thread expects message_body and recipient_email. Preserve
    // familiar aliases used by the planner while sending Composio's schema.
    if (actionName === 'GMAIL_REPLY_TO_THREAD') {
      if (normalized.body && !normalized.message_body) {
        normalized.message_body = normalized.body;
        delete normalized.body;
      }
      if (normalized.to && !normalized.recipient_email) {
        normalized.recipient_email = Array.isArray(normalized.to)
          ? normalized.to[0]
          : normalized.to;
        delete normalized.to;
      }
    }

    return normalized;
  }

  /**
   * Execute any action dynamically with params
   * @param {string} actionName - Full action name (e.g., 'JIRA_SEARCH_ISSUES')
   * @param {Object} params - Parameters to pass to the action
   * @param {string} entityId - Optional entity ID (defaults to this.entityId)
   * @returns {Promise<Object>} Execution result with success/failure info
   */
  async executeAction(actionName, params, entityId = null) {
    const effectiveEntityId = entityId || this.entityId || 'default';
    console.log(`[Composio] executeAction: ${actionName} entityId: ${effectiveEntityId}`);
    console.log(`[Composio] executeAction params (before normalization):`, JSON.stringify(params, null, 2));

    // Normalize parameters for this action
    const normalizedParams = this._normalizeParams(actionName, params);
    console.log(`[Composio] executeAction params (after normalization):`, JSON.stringify(normalizedParams, null, 2));

    // Never issue a side-effecting Gmail call with an incomplete message. This
    // avoids an opaque provider error and makes the missing user input clear.
    if (actionName === 'GMAIL_SEND_EMAIL') {
      const hasRecipient = Boolean(
        normalizedParams?.recipient_email ||
        normalizedParams?.to ||
        normalizedParams?.cc?.length ||
        normalizedParams?.bcc?.length
      );
      const hasContent = Boolean(normalizedParams?.subject || normalizedParams?.body);

      if (!hasRecipient || !hasContent) {
        const missing = [
          !hasRecipient && 'a recipient',
          !hasContent && 'a subject or message body',
        ].filter(Boolean).join(' and ');

        return {
          success: false,
          data: null,
          error: `Gmail send requires ${missing}.`,
          actionName,
          entityId: effectiveEntityId,
          needsInfo: true,
        };
      }
    }

    if (actionName === 'GMAIL_REPLY_TO_THREAD') {
      const threadId = normalizedParams?.thread_id || normalizedParams?.threadId;
      const looksLikePlaceholder = !threadId || /reply\s+to\s+thread|thread[_\s-]*id/i.test(String(threadId));
      const missing = [
        looksLikePlaceholder && 'a valid email thread',
        !normalizedParams?.recipient_email && 'the recipient email address',
        !normalizedParams?.message_body && 'the reply message',
      ].filter(Boolean);

      if (missing.length > 0) {
        return {
          success: false,
          data: null,
          error: `Gmail reply requires ${missing.join(', ')}. First select or fetch the email you want to reply to.`,
          actionName,
          entityId: effectiveEntityId,
          needsInfo: true,
        };
      }
    }

    try {
      // Validate action exists (optional, uses cache)
      const schema = await this.getActionSchema(actionName);
      if (!schema) {
        console.warn(`[Composio] Warning: Could not validate action schema for ${actionName}, proceeding anyway`);
      }

      // Build the execute options - matching SDK's ToolExecuteParamsSchema
      const executeOptions = {
        userId: effectiveEntityId,
        arguments: normalizedParams || {},
        dangerouslySkipVersionCheck: true,
      };

      const result = await this.composio.tools.execute(actionName, executeOptions);

      // Check if result indicates failure
      const isSuccess = this._isExecutionSuccessful(result);

      console.log(`[Composio] ${actionName} completed - success: ${isSuccess}`);

      return {
        success: isSuccess,
        data: result?.data || result,
        error: isSuccess ? null : this._extractErrorMessage(result),
        actionName,
        entityId: effectiveEntityId,
      };
    } catch (error) {
      console.error(`[Composio] executeAction error for ${actionName}:`, error.message);
      return {
        success: false,
        data: null,
        error: error.message,
        actionName,
        entityId: effectiveEntityId,
      };
    }
  }

  /**
   * Check if execution result indicates success
   * @param {Object} result - Composio execution result
   * @returns {boolean}
   */
  _isExecutionSuccessful(result) {
    // Check explicit success field
    if (result?.successful === false) return false;
    if (result?.success === false) return false;
    if (result?.data?.successful === false) return false;

    // Check for error field
    if (result?.error) return false;
    if (result?.data?.error) return false;

    // Check for common error indicators
    if (result?.data?.errorMessages?.length > 0) return false;
    if (result?.data?.errors?.length > 0) return false;

    return true;
  }

  /**
   * Extract error message from result
   * @param {Object} result - Composio execution result
   * @returns {string|null}
   */
  _extractErrorMessage(result) {
    if (result?.error) return result.error;
    if (result?.data?.error) return result.data.error;
    if (result?.data?.errorMessages?.length > 0) return result.data.errorMessages.join(', ');
    if (result?.data?.errors?.length > 0) {
      return result.data.errors.map(e => e.message || e).join(', ');
    }
    if (result?.successful === false || result?.data?.successful === false) {
      return 'Action completed but returned unsuccessful status';
    }
    return null;
  }

  /**
   * Get tools for a specific toolkit (used by IntelligentOrchestrator)
   * @param {string} toolkit - Toolkit name (e.g., 'JIRA', 'GMAIL')
   * @param {string} entityId - Optional entity ID (defaults to this.entityId)
   */
  async getToolsForToolkit(toolkit, entityId = this.entityId) {
    try {
      // API requires entityId as first param
      // Use limit: 100 to get all tools (default is only 20)
      const tools = await this.composio.tools.get(entityId, {
        toolkits: [toolkit],
        limit: 5000,
      });
      return tools || [];
    } catch (error) {
      console.error(`[Composio] getToolsForToolkit error for ${toolkit}:`, error.message);
      return [];
    }
  }

  /**
   * Get schema for a specific tool action (legacy format for backwards compatibility)
   * @deprecated Use getActionSchema() for full parameter details
   */
  async getToolSchema(actionName) {
    try {
      // Use the new cached getActionSchema method
      const schema = await this.getActionSchema(actionName);

      if (schema && schema.rawSchema) {
        // Return legacy format {required, properties}
        return {
          required: schema.rawSchema.required || [],
          properties: schema.rawSchema.properties || {},
        };
      }
      return null;
    } catch (error) {
      console.error(`[Composio] getToolSchema error for ${actionName}:`, error);
      return null;
    }
  }

  /**
   * Search for actions across all connected apps that match a query
   * @param {string} query - Search query (matches action name or description)
   * @param {string} entityId - Entity ID
   * @returns {Promise<Array>} Matching actions
   */
  async searchActions(query, entityId = this.entityId) {
    try {
      const allActions = await this.getAllAvailableActions(entityId);
      const queryLower = query.toLowerCase();

      return allActions.filter(action =>
        action.name.toLowerCase().includes(queryLower) ||
        action.description.toLowerCase().includes(queryLower)
      );
    } catch (error) {
      console.error(`[Composio] searchActions error:`, error.message);
      return [];
    }
  }

  /**
   * Get actions by operation type (read or write)
   * @param {string} operationType - 'read' or 'write'
   * @param {string} entityId - Entity ID
   * @returns {Promise<Array>} Actions of the specified type
   */
  async getActionsByType(operationType, entityId = this.entityId) {
    try {
      const allActions = await this.getAllAvailableActions(entityId);
      return allActions.filter(action => action.operationType === operationType);
    } catch (error) {
      console.error(`[Composio] getActionsByType error:`, error.message);
      return [];
    }
  }
}

module.exports = {
  ComposioService,
  APP_TO_COMPOSIO_TOOLKIT,
  COMPOSIO_TOOLKIT_TO_APP,
};
