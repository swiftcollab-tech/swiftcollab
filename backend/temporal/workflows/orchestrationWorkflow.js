/**
 * Temporal Orchestration Workflow (Simplified - Option A)
 *
 * This workflow ONLY handles durable execution of PRE-VALIDATED plans.
 * All parsing, routing, slot filling, and validation is done EXTERNALLY by:
 * - AssistantOrchestrator (entry point)
 * - ToolRouter (action selection)
 * - SlotFiller (parameter collection)
 * - PreflightChecker (validation & enrichment)
 *
 * This workflow is responsible for:
 * 1. Executing tasks in dependency order (parallel + sequential)
 * 2. Handling retries (Temporal's built-in)
 * 3. Data injection between tasks ({{t1.result}} → actual data)
 * 4. Signals for user interaction during execution
 * 5. Queries for workflow state inspection
 */

const {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  sleep,
} = require('@temporalio/workflow');

// Only import execution activities - NO parsing/validation activities
const {
  executeComposioAction,
  executeFrappeAction,
  formatResults,
  formatActionResult,
  storeActionParams,
  generateEmailBodyFromData,
  summarizeDataWithAI,
} = proxyActivities({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumAttempts: 3,
    maximumInterval: '30 seconds',
    nonRetryableErrorTypes: ['COMPOSIO_ERROR', 'VALIDATION_ERROR', 'FRAPPE_ERROR'],
  },
});


// Signals for workflow communication
const provideFollowupSignal = defineSignal('provideFollowup');
const cancelWorkflowSignal = defineSignal('cancelWorkflow');

// Queries for workflow state
const getStateQuery = defineQuery('getState');
const getResultsQuery = defineQuery('getResults');

/**
 * Main Orchestration Workflow
 *
 * Expects a PRE-VALIDATED execution plan from AssistantOrchestrator.
 * Does NOT do parsing, routing, slot filling, or validation.
 */
async function orchestrationWorkflow(input) {
  const {
    message,
    userId,
    entityId,
    selectedToolkits,
    executionPlan,   // PRE-VALIDATED plan from AssistantOrchestrator
    skipValidation,  // Should always be true for Option A
  } = input;

  // Workflow state
  let state = 'INITIAL';
  let executionResults = [];
  let isCancelled = false;
  let finalResult = null;
  let followupResponse = null;

  // Set up signal handlers
  setHandler(provideFollowupSignal, (response) => {
    console.log('[Workflow] Received followup response');
    followupResponse = response;
  });

  setHandler(cancelWorkflowSignal, () => {
    console.log('[Workflow] Cancellation requested');
    isCancelled = true;
  });

  // Set up query handlers
  setHandler(getStateQuery, () => ({
    state,
    hasResults: executionResults.length > 0,
    isCancelled,
  }));

  setHandler(getResultsQuery, () => ({
    state,
    results: executionResults,
    finalResult,
  }));

  // ==========================================================================
  // VALIDATE INPUT: Must have pre-validated execution plan
  // ==========================================================================
  if (!executionPlan || !executionPlan.tasks || executionPlan.tasks.length === 0) {
    console.error('[Workflow] No valid execution plan provided');
    return {
      type: 'error',
      message: 'No execution plan provided. Request must be validated by AssistantOrchestrator first.',
    };
  }

  // Check if plan is ready (all params filled)
  if (!executionPlan.ready && !skipValidation) {
    console.error('[Workflow] Execution plan is not ready (missing params)');
    return {
      type: 'error',
      message: 'Execution plan has missing parameters. Complete slot filling before execution.',
      missingFields: executionPlan.missingFields || [],
    };
  }

  console.log(`[Workflow] Executing pre-validated plan with ${executionPlan.tasks.length} tasks`);
  state = 'EXECUTING';

  // ==========================================================================
  // EXECUTE TASKS IN ORDER
  // ==========================================================================
  try {
    const result = await executeTasksInOrder({
      tasks: executionPlan.tasks,
      entityId: executionPlan.entityId || entityId,
      userId: executionPlan.userId || userId,
      originalMessage: executionPlan.originalMessage || message,
    });

    executionResults = result.results;
    state = result.success ? 'COMPLETED' : 'PARTIAL_SUCCESS';

    finalResult = {
      type: result.success ? 'success' : 'partial_success',
      message: result.summary,
      results: result.results,
      data: result.data,
    };

    return finalResult;

  } catch (error) {
    console.error('[Workflow] Execution failed:', error.message);
    state = 'FAILED';

    finalResult = {
      type: 'error',
      message: `Execution failed: ${error.message}`,
      error: error.message,
    };

    return finalResult;
  }
}

// =============================================================================
// CORE EXECUTION LOGIC
// =============================================================================

/**
 * Check if an action is a Frappe/ERPNext action
 */
function isFrappeAction(action) {
  if (!action) return false;
  const actionStr = String(action).toUpperCase();
  return actionStr.startsWith('FRAPPE_') || actionStr.startsWith('ERPNEXT_');
}

/**
 * Execute a single task, routing to the appropriate activity (Composio or Frappe)
 */
async function executeTaskAction({ task, params, entityId, userId }) {
  const action = task.action;

  if (isFrappeAction(action)) {
    console.log(`[Workflow] Routing ${action} to Frappe activity`);
    return await executeFrappeAction({
      action,
      params,
      userId,
      entityId,
    });
  } else {
    return await executeComposioAction({
      action,
      params,
      entityId,
      toolkit: task.toolkit,
    });
  }
}

/**
 * Execute tasks in dependency order with parallel group support
 */
async function executeTasksInOrder({ tasks, entityId, userId, originalMessage }) {
  console.log(`[Workflow] Executing ${tasks.length} tasks`);

  const results = [];

  const taskResults = new Map();

  // Group tasks by parallelGroup and dependencies
  const parallelGroups = new Map();
  const sequentialTasks = [];

  for (const task of tasks) {
    if (task.parallelGroup) {
      if (!parallelGroups.has(task.parallelGroup)) {
        parallelGroups.set(task.parallelGroup, []);
      }
      parallelGroups.get(task.parallelGroup).push(task);
    } else {
      sequentialTasks.push(task);
    }
  }

  // ==========================================================================
  // PHASE 1: Execute parallel groups (typically READ operations)
  // ==========================================================================
  for (const [groupName, groupTasks] of parallelGroups) {
    console.log(`[Workflow] Executing parallel group "${groupName}" with ${groupTasks.length} tasks`);

    const parallelResults = await Promise.allSettled(
      groupTasks.map(async (task) => {
        // Defensive: ensure action is defined
        if (!task.action) {
          console.error(`[Workflow] Task ${task.id} has no action defined! Task:`, JSON.stringify(task));
          return { task, error: `Task ${task.id} has no action defined`, success: false };
        }

        console.log(`[Workflow] Executing parallel task ${task.id}: ${task.action}`);
        const resolvedParams = resolveTemplateVariables(task.params, taskResults);

        try {
          const result = await executeTaskAction({
            task,
            params: resolvedParams,
            entityId,
            userId,
          });
          return { task, result, success: true };
        } catch (error) {
          return { task, error: error.message, success: false };
        }
      })
    );

    // Process parallel results
    for (const outcome of parallelResults) {
      if (outcome.status === 'fulfilled') {
        const { task, result, success, error } = outcome.value;
        if (success) {
          results.push({
            taskId: task.id,
            action: task.action,
            success: true,
            data: result.data,
          });
          taskResults.set(task.id, { action: task.action, data: result.data });

          // Store for "same/previous" reference in future requests
          try {
            await storeActionParams({
              entityId,
              action: task.action,
              params: task.params,
              result: result.data,
            });
          } catch (storeError) {
            console.warn(`[Workflow] Failed to store params for ${task.action}`);
          }
        } else {
          results.push({
            taskId: task.id,
            action: task.action,
            success: false,
            error,
          });
        }
      } else {
        results.push({
          taskId: 'unknown',
          action: 'unknown',
          success: false,
          error: outcome.reason?.message || 'Unknown error',
        });
      }
    }
  }

  // ==========================================================================
  // PHASE 2: Execute sequential tasks in dependency order
  // ==========================================================================
  const sortedTasks = topologicalSort(sequentialTasks);

  for (const task of sortedTasks) {
    // Check if dependencies failed
    const dependencyFailed = (task.dependsOn || []).some(depId => {
      const depResult = results.find(r => r.taskId === depId);
      return depResult && !depResult.success;
    });

    if (dependencyFailed && !task.optional) {
      console.log(`[Workflow] Skipping ${task.id} due to failed dependency`);
      results.push({
        taskId: task.id,
        action: task.action,
        success: false,
        error: 'Skipped due to failed dependency',
        skipped: true,
      });
      continue;
    }

    console.log(`[Workflow] Executing task ${task.id}: ${task.action}`);

    // Defensive: ensure action is defined
    if (!task.action) {
      console.error(`[Workflow] Task ${task.id} has no action defined! Task:`, JSON.stringify(task));
      results.push({
        taskId: task.id,
        action: task.action,
        success: false,
        error: `Task ${task.id} has no action defined`,
      });
      continue;
    }

    // Resolve template variables from previous task results
    let resolvedParams = resolveTemplateVariables(task.params, taskResults);

    // Inject data from previous tasks if needed
    resolvedParams = await injectPreviousTaskData(task, taskResults, resolvedParams);

    try {
      const result = await executeTaskAction({
        task,
        params: resolvedParams,
        entityId,
        userId,
      });

      results.push({
        taskId: task.id,
        action: task.action,
        success: true,
        data: result.data,
      });
      taskResults.set(task.id, { action: task.action, data: result.data });

      // Store for future reference
      try {
        await storeActionParams({
          entityId,
          action: task.action,
          params: resolvedParams,
          result: result.data,
        });
      } catch (storeError) {
        console.warn(`[Workflow] Failed to store params for ${task.action}`);
      }

    } catch (error) {
      console.error(`[Workflow] Task ${task.id} failed:`, error.message);
      results.push({
        taskId: task.id,
        action: task.action,
        success: false,
        error: error.message,
      });

      // Stop execution on critical failure (unless task is optional)
      if (!task.optional) {
        break;
      }
    }
  }

  // ==========================================================================
  // GENERATE SUMMARY
  // ==========================================================================
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success && !r.skipped).length;

  let summary;
  try {
    summary = await formatResults({
      results,
      originalMessage,
    });
  } catch (formatError) {
    summary = `Completed ${successCount}/${results.length} tasks`;
    if (failCount > 0) {
      summary += `. ${failCount} task(s) failed.`;
    }
  }

  return {
    success: failCount === 0,
    results,
    summary,
    data: taskResults.size > 0 ? Object.fromEntries(taskResults) : null,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * UNIVERSAL DATA INJECTION
 * 
 * Pattern-based injection that works with ANY app combination (10-20+).
 * No hardcoded action names - uses field patterns to detect what needs injection.
 */
async function injectPreviousTaskData(task, taskResults, params) {
  const resolvedParams = { ...params };
  const action = task.action || '';
  const hasDependencies = task.dependsOn && task.dependsOn.length > 0;

  console.log(`[Workflow] Universal data injection for ${action}`);
  console.log(`[Workflow]   - taskResults size: ${taskResults.size}`);

  if (taskResults.size === 0) {
    return resolvedParams;
  }

  // =========================================================================
  // PATTERN DEFINITIONS - Universal field detection
  // =========================================================================

  // Fields that typically need content from previous results
  const CONTENT_FIELD_PATTERNS = [
    /^body$/i, /^text$/i, /^content$/i, /^message$/i, /^description$/i,
    /^notes$/i, /^details$/i, /^html_body$/i, /^plain_text$/i
  ];

  // Fields that need reference IDs from CREATE actions
  const REFERENCE_FIELD_PATTERNS = [
    /^customer$/i, /customer_name$/i, /customer_id$/i,
    /^item$/i, /item_code$/i, /item_name$/i,
    /^project$/i, /project_id$/i, /project_key$/i,
    /^supplier$/i, /supplier_name$/i,
    /^employee$/i, /employee_id$/i,
    /^order$/i, /order_id$/i, /sales_order$/i,
    /^invoice$/i, /invoice_id$/i,
    /^task$/i, /task_id$/i, /task_name$/i,
    /^issue$/i, /issue_key$/i, /ticket$/i,
    /^event$/i, /event_id$/i,
    /^channel$/i, /channel_id$/i,
    /^document$/i, /doc_name$/i, /docname$/i,
  ];

  // Injection token values
  const INJECTION_TOKENS = ['_inject_from_previous', '__INJECT__', '{{previous}}', '{{all_results}}'];

  const isInjectionToken = (val) => {
    if (typeof val !== 'string') return false;
    return INJECTION_TOKENS.some(t => val.includes(t));
  };

  const matchesPattern = (field, patterns) => patterns.some(p => p.test(field));

  // =========================================================================
  // STEP 1: Handle explicit _injectResultTo directive
  // =========================================================================
  if (task._injectResultTo && task._sourceTaskId) {
    const sourceResult = taskResults.get(task._sourceTaskId);
    if (sourceResult?.data) {
      const requestedPath = String(task._sourceResultPath || '')
        .split('.')
        .map(part => part.trim())
        .filter(Boolean);
      let injectedValue = requestedPath.reduce(
        (value, part) => value !== null && value !== undefined ? value[part] : undefined,
        sourceResult.data
      );
      if (injectedValue === undefined) {
        injectedValue = findResourceField(sourceResult.data, task._injectResultTo, requestedPath.at(-1));
      }
      resolvedParams[task._injectResultTo] =
        injectedValue !== undefined && (injectedValue === null || typeof injectedValue !== 'object')
          ? injectedValue
          : formatDataForInjection(injectedValue ?? sourceResult.data, sourceResult.action);
      console.log(`[Workflow] Explicit injection: ${task._sourceTaskId} → ${task._injectResultTo}`);
    }
  }

  // =========================================================================
  // STEP 2: Resolve injection tokens in any field
  // =========================================================================
  for (const [field, value] of Object.entries(resolvedParams)) {
    if (isInjectionToken(value)) {
      const aggregatedData = aggregateAllResults(taskResults);
      resolvedParams[field] = formatAggregatedData(aggregatedData, field);
      console.log(`[Workflow] Resolved injection token in ${field}`);
    }
  }

  // =========================================================================
  // STEP 3: Auto-resolve CONTENT fields (body, description, text, etc.)
  // =========================================================================
  for (const [field, value] of Object.entries(resolvedParams)) {
    // Skip if already has meaningful content
    if (value && typeof value === 'string' && value.length > 10 && !isInjectionToken(value)) continue;

    // Check if this is a content field
    if (!matchesPattern(field, CONTENT_FIELD_PATTERNS)) continue;

    // Aggregate all relevant previous results
    const aggregatedData = aggregateAllResults(taskResults);
    if (aggregatedData.length > 0) {
      resolvedParams[field] = formatAggregatedData(aggregatedData, field);
      console.log(`[Workflow] Auto-injected content into ${field} from ${aggregatedData.length} sources`);
    }
  }

  // =========================================================================
  // STEP 4: Auto-resolve REFERENCE fields (customer, item_code, etc.)
  // =========================================================================
  for (const [field, value] of Object.entries(resolvedParams)) {
    // Skip if already has a value
    if (value && value !== '' && !isInjectionToken(value)) continue;

    // Check if this is a reference field
    if (!matchesPattern(field, REFERENCE_FIELD_PATTERNS)) continue;

    // Find matching CREATE result
    const matchingResult = findMatchingCreateResult(field, taskResults);
    if (matchingResult) {
      const extractedValue = extractReferenceValue(field, matchingResult);
      if (extractedValue) {
        resolvedParams[field] = extractedValue;
        console.log(`[Workflow] Resolved reference: ${field} = ${extractedValue}`);
      }
    }
  }

  // =========================================================================
  // STEP 5: Resolve array fields (items, line_items, etc.)
  // =========================================================================
  const itemFieldPatterns = [/^items$/i, /^line_items$/i, /^products$/i, /^entries$/i];
  for (const [field, value] of Object.entries(resolvedParams)) {
    if (!matchesPattern(field, itemFieldPatterns)) continue;
    if (Array.isArray(value) && value.length > 0) continue; // Already has items

    // Build items from previous CREATE_ITEM results
    const itemResults = [];
    for (const [taskId, result] of taskResults) {
      if (result.action?.includes('CREATE_ITEM') || result.action?.includes('CREATE_PRODUCT')) {
        const data = result.data || {};
        itemResults.push({
          item_code: data.item_code || data.name,
          qty: 1,
          rate: data.standard_rate || data.rate || 0,
        });
      }
    }
    if (itemResults.length > 0) {
      resolvedParams[field] = itemResults;
      console.log(`[Workflow] Built ${itemResults.length} items for ${field}`);
    }
  }

  return resolvedParams;
}

/**
 * Locate an identifier in a connector result without assuming one provider's
 * response envelope. Kept deterministic because this runs inside a workflow.
 */
function findResourceField(payload, targetParam, requestedField) {
  if (payload === null || payload === undefined) return undefined;
  const camel = value => String(value || '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const target = camel(targetParam);
  const resource = target.replace(/(?:Id|Key|Url)$/i, '');
  const candidates = new Set([
    requestedField,
    targetParam,
    target,
    `${resource}Id`,
    `${resource}Key`,
    `${resource}Url`,
  ].filter(Boolean).map(value => String(value).toLowerCase()));
  const queue = [{ value: payload, depth: 0 }];

  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || depth > 4) continue;
    for (const [key, child] of Object.entries(value)) {
      if (candidates.has(key.toLowerCase()) && child !== null && child !== undefined) return child;
      if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
  }
  return undefined;
}

/**
 * Find CREATE result that matches a reference field
 */
function findMatchingCreateResult(field, taskResults) {
  const fieldLower = field.toLowerCase();

  // Map field names to likely source action patterns
  const fieldToActionPatterns = {
    customer: [/CREATE_CUSTOMER/i, /CREATE_CONTACT/i, /CREATE_ACCOUNT/i],
    item: [/CREATE_ITEM/i, /CREATE_PRODUCT/i],
    project: [/CREATE_PROJECT/i],
    supplier: [/CREATE_SUPPLIER/i, /CREATE_VENDOR/i],
    task: [/CREATE_TASK/i, /CREATE_CARD/i],
    issue: [/CREATE_ISSUE/i],
    ticket: [/CREATE_ISSUE/i, /CREATE_TICKET/i],
    employee: [/CREATE_EMPLOYEE/i],
    order: [/CREATE.*ORDER/i],
    invoice: [/CREATE.*INVOICE/i],
    event: [/CREATE.*EVENT/i],
    document: [/CREATE_DOCUMENT/i],
  };

  // Extract the base field name (remove _id, _name, _code suffixes)
  const fieldRoot = fieldLower.replace(/_?(id|name|code|key)$/i, '');

  // Try to find matching patterns
  for (const [mapField, patterns] of Object.entries(fieldToActionPatterns)) {
    if (fieldLower === mapField || fieldLower.includes(mapField) || fieldRoot === mapField) {
      for (const [taskId, result] of taskResults) {
        if (patterns.some(p => p.test(result.action))) {
          return result;
        }
      }
    }
  }

  // Fallback: find any CREATE action that might match
  for (const [taskId, result] of taskResults) {
    if (result.action?.includes('CREATE') && result.action?.toLowerCase().includes(fieldRoot)) {
      return result;
    }
  }

  return null;
}

/**
 * Extract the right value from a CREATE result for a reference field
 */
function extractReferenceValue(field, result) {
  const data = result.data || {};
  const fieldLower = field.toLowerCase();

  // Common ID/name extraction patterns
  if (fieldLower.includes('id') || fieldLower.includes('key')) {
    return data.name || data.id || data.key || data.document_id || data.issue_key;
  }

  if (fieldLower.includes('name')) {
    return data.name || data.customer_name || data.item_name || data.supplier_name ||
      data.title || data.full_name || data.project_name;
  }

  if (fieldLower.includes('code')) {
    return data.item_code || data.code || data.name;
  }

  // Generic fallback
  return data.name || data.id || data.key;
}

/**
 * Aggregate all results from previous tasks
 */
function aggregateAllResults(taskResults) {
  const aggregated = [];

  for (const [taskId, result] of taskResults) {
    if (result.data) {
      aggregated.push({
        taskId,
        action: result.action,
        data: result.data,
      });
    }
  }

  return aggregated;
}

/**
 * Format aggregated data for injection into a field
 */
function formatAggregatedData(aggregatedData, targetField) {
  if (aggregatedData.length === 0) return '';

  const sections = [];

  for (const item of aggregatedData) {
    const formatted = formatDataForInjection(item.data, item.action);
    if (formatted && formatted.length > 0) {
      const header = getDataHeader(item.action);
      sections.push(`${header}\n${formatted}`);
    }
  }

  if (sections.length === 0) return '';

  // Truncate if too long
  let result = sections.join('\n\n');
  if (result.length > 10000) {
    result = result.substring(0, 10000) + '\n... (truncated)';
  }

  return result;
}

/**
 * Get a human-readable header for an action's data
 */
function getDataHeader(action) {
  const actionStr = String(action || '').toUpperCase();

  // Extract app and operation from action name
  const match = actionStr.match(/^([A-Z]+)_(.+)$/);
  if (match) {
    const [, app, operation] = match;
    const appDisplayName = {
      FRAPPE: '📋 ERPNext',
      GMAIL: '📧 Email',
      GOOGLECALENDAR: '📅 Calendar',
      SLACK: '💬 Slack',
      JIRA: '🎫 Jira',
      ASANA: '✅ Asana',
      TRELLO: '📝 Trello',
      HUBSPOT: '🏢 HubSpot',
      GITHUB: '🐙 GitHub',
      NOTION: '📓 Notion',
      ZOOM: '📹 Zoom',
      SALESFORCE: '☁️ Salesforce',
      ZENDESK: '🎧 Zendesk',
      AIRTABLE: '📊 Airtable',
      DROPBOX: '📦 Dropbox',
      TEAMS: '👥 Teams',
      OUTLOOK: '📨 Outlook',
    }[app] || `📌 ${app}`;

    const opHuman = operation.replace(/_/g, ' ').toLowerCase();
    return `${appDisplayName} - ${opHuman}\n${'─'.repeat(25)}`;
  }

  return `📌 ${action}\n${'─'.repeat(25)}`;
}

/**
 * Check if an action is a search/fetch result (produces data)
 */
function isSearchResult(action) {
  if (!action) return false;
  return action.includes('SEARCH') ||
    action.includes('GET') ||
    action.includes('FETCH') ||
    action.includes('FIND') ||
    action.includes('LIST');
}

/**
 * Generate email body from MULTIPLE data sources
 * Combines calendar events + email summary + jira tickets etc.
 */
async function tryGenerateEmailBodyFromMultipleSources(resolvedParams, dataSources) {
  if (!dataSources || dataSources.length === 0) return false;

  const bodyParts = [];

  for (const source of dataSources) {
    const { taskId, action, data } = source;

    // Try to format this source's data
    let formatted = null;

    // Determine data type
    let dataType = 'generic';
    if (action?.includes('JIRA')) dataType = 'jira_issues';
    else if (action?.includes('GMAIL') && !action?.includes('SEND')) dataType = 'emails';
    else if (action?.includes('CALENDAR') && !action?.includes('CREATE')) dataType = 'calendar_events';

    // Try AI summarization first for known types
    if (dataType !== 'generic') {
      try {
        const aiResult = await summarizeDataWithAI({
          data,
          dataType,
          maxItems: 15, // Smaller limit when combining multiple sources
        });

        if (aiResult.success && aiResult.summary && aiResult.summary.length > 20) {
          formatted = aiResult.summary;
          console.log(`[Workflow] AI summarized ${dataType} from ${taskId} (${aiResult.itemCount} items)`);
        }
      } catch (aiError) {
        console.warn(`[Workflow] AI summarization failed for ${taskId}:`, aiError.message);
      }
    }

    // Fallback to formatDataForInjection
    if (!formatted) {
      formatted = formatDataForInjection(data, action);
    }

    if (formatted && formatted.length > 0) {
      // Add section header based on data type
      let sectionHeader = '';
      if (dataType === 'calendar_events') sectionHeader = '📅 CALENDAR EVENTS';
      else if (dataType === 'emails') sectionHeader = '📧 EMAIL SUMMARY';
      else if (dataType === 'jira_issues') sectionHeader = '🎫 JIRA TICKETS';
      else sectionHeader = `📋 ${action || 'DATA'}`;

      bodyParts.push(`${sectionHeader}\n${'─'.repeat(30)}\n${formatted}`);
    }
  }

  if (bodyParts.length > 0) {
    resolvedParams.body = bodyParts.join('\n\n');
    console.log(`[Workflow] Combined ${bodyParts.length} data sources into email body (${resolvedParams.body.length} chars)`);
    return true;
  }

  return false;
}

/**
 * Helper to generate email body from task result (single source)
 * Uses AI summarization for large datasets to reduce payload size
 */
async function tryGenerateEmailBody(resolvedParams, taskData) {
  // Determine content type based on action
  let contentType = 'generic';
  let dataType = 'generic';
  if (taskData.action?.includes('JIRA')) {
    contentType = 'jira_issues';
    dataType = 'jira_issues';
  } else if (taskData.action?.includes('GMAIL')) {
    contentType = 'email_summary';
    dataType = 'emails';
  } else if (taskData.action?.includes('CALENDAR')) {
    contentType = 'calendar_events';
    dataType = 'calendar_events';
  }

  // First, try AI summarization for large datasets (especially emails)
  // This reduces payload size and produces better summaries
  if (dataType === 'emails' || dataType === 'jira_issues' || dataType === 'calendar_events') {
    try {
      console.log(`[Workflow] Attempting AI summarization for ${dataType}...`);
      const aiResult = await summarizeDataWithAI({
        data: taskData.data,
        dataType,
        maxItems: 20,
      });

      if (aiResult.success && aiResult.summary && aiResult.summary.length > 20) {
        resolvedParams.body = aiResult.summary;
        console.log(`[Workflow] AI summarization successful (${aiResult.itemCount} items → ${aiResult.summary.length} chars)`);
        return true;
      }
    } catch (aiError) {
      console.warn('[Workflow] AI summarization failed, falling back:', aiError.message);
    }
  }

  // Fallback to generateEmailBodyFromData activity
  try {
    const generated = await generateEmailBodyFromData({
      contentType,
      data: taskData.data,
      options: { format: 'summary', includeLinks: true },
    });
    if (generated.success && generated.body && generated.body.length > 10) {
      resolvedParams.body = generated.body;
      console.log('[Workflow] Generated email body from activity');
      return true;
    }
  } catch (genError) {
    console.warn('[Workflow] generateEmailBodyFromData failed:', genError.message);
  }

  // Final fallback to local formatDataForInjection
  console.log('[Workflow] Using formatDataForInjection fallback');
  const formatted = formatDataForInjection(taskData.data, taskData.action);
  if (formatted && formatted.length > 0) {
    resolvedParams.body = formatted;
    return true;
  }

  return false;
}

/**
 * Format data for injection into another task's params
 */
function formatDataForInjection(data, action) {
  if (!data) return '';

  // Unwrap Composio API response format: { success: true, data: {...} }
  let unwrapped = data;
  if (data.success === true && data.data && typeof data.data === 'object') {
    unwrapped = data.data;
  }

  // Jira issues - handle both direct and nested
  const issues = unwrapped.issues || data.issues;
  if (issues && Array.isArray(issues)) {
    if (issues.length === 0) {
      return 'No Jira tickets found matching your criteria.';
    }
    return `Jira Tickets Summary (${issues.length} issue${issues.length !== 1 ? 's' : ''}):\n\n` +
      issues.map(issue => {
        const key = issue.key || issue.id;
        const summary = issue.fields?.summary || issue.summary || 'No summary';
        const status = issue.fields?.status?.name || issue.status?.name || '';
        return `• ${key}: ${summary}${status ? ` [${status}]` : ''}`;
      }).join('\n');
  }

  // Calendar events - handle both direct and nested
  const events = unwrapped.events || data.events;
  if (events && Array.isArray(events)) {
    if (events.length === 0) {
      return 'No calendar events found.';
    }
    return `Calendar Events (${events.length} event${events.length !== 1 ? 's' : ''}):\n\n` +
      events.map(event => {
        const summary = event.summary || 'Untitled event';
        const start = event.start?.dateTime || event.start?.date || '';
        return `• ${summary}${start ? ` - ${new Date(start).toLocaleString()}` : ''}`;
      }).join('\n');
  }

  // Gmail messages - handle both direct and nested
  const messages = unwrapped.messages || data.messages;
  if (messages && Array.isArray(messages)) {
    if (messages.length === 0) {
      return 'No emails found.';
    }
    const formatted = messages.slice(0, 20).map(msg => {
      // Extract subject from multiple possible locations
      const subject = msg.subject ||
        msg.payload?.headers?.find(h => h.name?.toLowerCase() === 'subject')?.value ||
        'No subject';

      // Extract from
      const from = msg.from ||
        msg.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value ||
        'Unknown sender';

      // Extract date
      const timestamp = msg.messageTimestamp || msg.internalDate;
      const dateStr = timestamp ? new Date(timestamp).toLocaleString() : '';

      // Extract snippet or preview
      const preview = msg.snippet ||
        (msg.messageText?.substring(0, 100) + (msg.messageText?.length > 100 ? '...' : '')) ||
        '';

      return `• **${subject}**\n  From: ${from}${dateStr ? `\n  Date: ${dateStr}` : ''}${preview ? `\n  Preview: ${preview}` : ''}`;
    }).join('\n\n');

    const total = messages.length;
    const header = `Email Summary (${total} message${total !== 1 ? 's' : ''}):\n\n`;
    return header + formatted;
  }

  // Generic array
  if (Array.isArray(unwrapped)) {
    return unwrapped.slice(0, 10).map((item, i) => {
      if (typeof item === 'object') {
        return `• ${item.name || item.title || item.summary || JSON.stringify(item).substring(0, 100)}`;
      }
      return `• ${item}`;
    }).join('\n');
  }

  // Single object - try to format nicely
  if (typeof unwrapped === 'object') {
    // Try common patterns
    if (unwrapped.summary) return unwrapped.summary;
    if (unwrapped.title) return unwrapped.title;
    if (unwrapped.message) return unwrapped.message;
    if (unwrapped.body) return unwrapped.body;
    if (unwrapped.text) return unwrapped.text;

    // Fallback to JSON but limit size
    const jsonStr = JSON.stringify(unwrapped, null, 2);
    if (jsonStr.length > 2000) {
      return jsonStr.substring(0, 2000) + '\n... (truncated)';
    }
    return jsonStr;
  }

  return String(unwrapped);
}

/**
 * Topological sort for task dependencies
 */
function topologicalSort(tasks) {
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set();
  const result = [];

  function visit(taskId) {
    if (visited.has(taskId)) return;
    visited.add(taskId);

    const task = taskMap.get(taskId);
    if (!task) return;

    for (const depId of (task.dependsOn || [])) {
      visit(depId);
    }

    result.push(task);
  }

  for (const task of tasks) {
    visit(task.id);
  }

  return result;
}

/**
 * Resolve template variables like {{t1.key}} from previous results
 */
function resolveTemplateVariables(params, taskResults) {
  if (!params) return params;

  const resolved = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      // Replace {{taskId.field}} patterns
      resolved[key] = value.replace(/\{\{(\w+)\.(\w+)\}\}/g, (match, taskId, field) => {
        const taskResult = taskResults.get(taskId);
        if (taskResult?.data?.[field]) {
          return taskResult.data[field];
        }
        return match; // Keep original if not found
      });

      // Replace {{taskId}} with formatted result
      resolved[key] = resolved[key].replace(/\{\{(\w+)\}\}/g, (match, taskId) => {
        const taskResult = taskResults.get(taskId);
        if (taskResult?.data) {
          return formatDataForInjection(taskResult.data, taskResult.action);
        }
        return match;
      });
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * Handle followup workflow (for mid-execution user input)
 * This is called when a signal provides additional data during execution
 */
async function handleFollowupWorkflow({ followupData, pendingTask, entityId }) {
  console.log('[Workflow] Handling followup with additional data');

  // Merge followup data into pending task params
  const mergedParams = {
    ...pendingTask.params,
    ...followupData,
  };

  // Execute the pending task with merged params
  try {
    const result = await executeComposioAction({
      action: pendingTask.action,
      params: mergedParams,
      entityId,
      toolkit: pendingTask.toolkit,
    });

    return {
      type: 'success',
      taskId: pendingTask.id,
      action: pendingTask.action,
      data: result.data,
    };
  } catch (error) {
    return {
      type: 'error',
      taskId: pendingTask.id,
      action: pendingTask.action,
      error: error.message,
    };
  }
}

module.exports = {
  orchestrationWorkflow,
  handleFollowupWorkflow,
  provideFollowupSignal,
  cancelWorkflowSignal,
  getStateQuery,
  getResultsQuery,
};
