/**
 * ParameterIsolator - Prevents parameter contamination between actions
 *
 * Fixes the bug where email params (to, subject) leak into Jira params
 * or vice versa.
 *
 * Each action only receives parameters it actually uses.
 */

// Define allowed parameters for each action
const ACTION_PARAMS = {
  // ==================== JIRA ====================
  'JIRA_SEARCH_ISSUES': [
    'jql', 'maxResults', 'max_results', 'startAt', 'start_at',
    'fields', 'expand', 'project_key',
  ],
  'JIRA_GET_ISSUE': [
    'issue_key', 'issueKey', 'issue_id_or_key', 'issueIdOrKey',
    'issue_id', 'issueId', 'key', 'fields', 'expand',
  ],
  'JIRA_GET_ISSUES': [
    'issue_keys', 'issueKeys', 'keys', 'fields', 'jql',
  ],
  'JIRA_CREATE_ISSUE': [
    'project_key', 'projectKey', 'summary', 'description',
    'issue_type', 'issueType', 'priority', 'assignee',
    'labels', 'components', 'customFields', 'parent_key',
  ],
  'JIRA_UPDATE_ISSUE': [
    'issue_key', 'issueKey', 'issue_id_or_key', 'issueIdOrKey',
    'issue_id', 'issueId', 'summary', 'description',
    'status', 'priority', 'assignee', 'labels', 'transition',
  ],
  'JIRA_ADD_COMMENT': [
    'issue_key', 'issueKey', 'comment', 'body',
  ],
  'JIRA_TRANSITION_ISSUE': [
    'issue_key', 'issueKey', 'transition', 'transitionId', 'status',
  ],

  // ==================== GMAIL ====================
  'GMAIL_SEND_EMAIL': [
    'to', 'cc', 'bcc', 'subject', 'body', 'html_body', 'htmlBody',
    'attachments', 'replyTo', 'reply_to', 'threadId', 'thread_id',
  ],
  'GMAIL_FETCH_EMAILS': [
    'query', 'q', 'maxResults', 'max_results', 'pageToken', 'labelIds',
  ],
  'GMAIL_FIND_EMAIL': [
    'query', 'q', 'subject', 'from', 'to', 'after', 'before',
  ],
  'GMAIL_READ_EMAIL': [
    'message_id', 'messageId', 'id', 'format',
  ],
  'GMAIL_REPLY_EMAIL': [
    'message_id', 'messageId', 'thread_id', 'threadId',
    'body', 'html_body', 'attachments',
  ],
  'GMAIL_REPLY_TO_THREAD': [
    'thread_id', 'threadId', 'recipient_email', 'to', 'message_body', 'body',
    'cc', 'bcc', 'extra_recipients', 'is_html', 'user_id',
  ],
  'GMAIL_CREATE_DRAFT': [
    'to', 'cc', 'bcc', 'subject', 'body', 'html_body',
  ],

  // ==================== GOOGLE CALENDAR ====================
  'GOOGLECALENDAR_CREATE_EVENT': [
    'summary', 'title', 'description', 'start', 'end',
    'start_datetime', 'end_datetime', 'start_date', 'end_date',
    'attendees', 'location', 'calendar_id', 'calendarId',
    'reminders', 'recurrence', 'timeZone', 'visibility',
    'conferenceData', 'colorId',
  ],
  'GOOGLECALENDAR_UPDATE_EVENT': [
    'event_id', 'eventId', 'calendar_id', 'calendarId',
    'summary', 'description', 'start', 'end', 'attendees', 'location',
  ],
  'GOOGLECALENDAR_DELETE_EVENT': [
    'event_id', 'eventId', 'calendar_id', 'calendarId',
  ],
  'GOOGLECALENDAR_FIND_EVENT': [
    'query', 'q', 'timeMin', 'timeMax', 'calendar_id', 'calendarId',
    'maxResults', 'singleEvents', 'orderBy',
  ],
  'GOOGLECALENDAR_GET_EVENTS': [
    'timeMin', 'timeMax', 'calendar_id', 'calendarId',
    'maxResults', 'singleEvents', 'orderBy', 'pageToken',
  ],

  // ==================== SLACK ====================
  'SLACK_SEND_MESSAGE': [
    'channel', 'channel_id', 'channelId', 'message', 'text',
    'thread_ts', 'threadTs', 'blocks', 'attachments', 'unfurl_links',
  ],
  'SLACK_SEND_CHANNEL_MESSAGE': [
    'channel', 'channel_id', 'channelId', 'message', 'text',
    'thread_ts', 'threadTs', 'blocks', 'attachments',
  ],
  'SLACK_LIST_CHANNELS': [
    'types', 'limit', 'cursor', 'exclude_archived',
  ],
  'SLACK_SEARCH_MESSAGES': [
    'query', 'q', 'count', 'page', 'sort', 'sort_dir',
  ],

  // ==================== TRELLO ====================
  'TRELLO_CREATE_CARD': [
    'list_id', 'listId', 'name', 'title', 'description', 'desc',
    'due', 'dueDate', 'labels', 'idMembers', 'members',
  ],
  'TRELLO_UPDATE_CARD': [
    'card_id', 'cardId', 'name', 'description', 'due', 'closed',
    'list_id', 'listId',
  ],
  'TRELLO_GET_BOARDS': [
    'filter', 'fields',
  ],
  'TRELLO_GET_LISTS': [
    'board_id', 'boardId', 'filter',
  ],
  'TRELLO_GET_CARDS': [
    'list_id', 'listId', 'board_id', 'boardId', 'filter',
  ],

  // ==================== FRAPPE ====================
  'FRAPPE_CREATE_DOCUMENT': [
    'doctype', 'doc_type', 'data', 'fields', 'site',
  ],
  'FRAPPE_UPDATE_DOCUMENT': [
    'doctype', 'doc_type', 'name', 'doc_name', 'data', 'fields', 'site',
  ],
  'FRAPPE_GET_DOCUMENT': [
    'doctype', 'doc_type', 'name', 'doc_name', 'fields', 'site',
  ],
  'FRAPPE_GET_DOCUMENTS': [
    'doctype', 'doc_type', 'filters', 'fields', 'limit', 'order_by', 'site',
  ],
  'FRAPPE_DELETE_DOCUMENT': [
    'doctype', 'doc_type', 'name', 'doc_name', 'site',
  ],

  // ==================== GITHUB ====================
  'GITHUB_CREATE_ISSUE': [
    'owner', 'repo', 'repository', 'title', 'body', 'labels', 'assignees',
  ],
  'GITHUB_UPDATE_ISSUE': [
    'owner', 'repo', 'issue_number', 'title', 'body', 'state', 'labels',
  ],
  'GITHUB_LIST_ISSUES': [
    'owner', 'repo', 'state', 'labels', 'sort', 'direction', 'per_page',
  ],
  'GITHUB_CREATE_PR': [
    'owner', 'repo', 'title', 'body', 'head', 'base',
  ],

  // ==================== NOTION ====================
  'NOTION_CREATE_PAGE': [
    'parent', 'parent_id', 'properties', 'children', 'icon', 'cover',
  ],
  'NOTION_UPDATE_PAGE': [
    'page_id', 'properties', 'archived',
  ],
  'NOTION_SEARCH': [
    'query', 'filter', 'sort', 'page_size',
  ],
};

// Internal parameters that should always be stripped
const INTERNAL_PARAMS = [
  '_prefetchedData',
  '_resolvedBy',
  '_tier',
  '_confidence',
  '_timestamp',
  '_workflowId',
  '_taskId',
  '_entityId',
  '_userId',
];

class ParameterIsolator {
  constructor() {
    this.actionParams = ACTION_PARAMS;
    this.internalParams = INTERNAL_PARAMS;
  }

  /**
   * Isolate parameters for a specific action
   * Only returns params that the action can use
   *
   * @param {string} action - The action name (e.g., 'JIRA_SEARCH_ISSUES')
   * @param {object} rawParams - All params (may include params for other actions)
   * @returns {object} - Clean params for this action only
   */
  isolate(action, rawParams) {
    if (!rawParams || typeof rawParams !== 'object') {
      return {};
    }

    const allowedParams = this.actionParams[action];

    if (!allowedParams) {
      // Unknown action - strip internal params but keep others
      console.warn(`[ParameterIsolator] Unknown action: ${action}, allowing all non-internal params`);
      return this._stripInternalParams(rawParams);
    }

    const isolated = {};

    for (const [key, value] of Object.entries(rawParams)) {
      // Skip internal params
      if (this.internalParams.includes(key) || key.startsWith('_')) {
        continue;
      }

      // Only include if allowed for this action
      if (allowedParams.includes(key)) {
        isolated[key] = value;
      }
    }

    // Log what was filtered out (for debugging)
    const filtered = Object.keys(rawParams).filter(k =>
      !allowedParams.includes(k) && !k.startsWith('_')
    );
    if (filtered.length > 0) {
      console.log(`[ParameterIsolator] Filtered out from ${action}:`, filtered);
    }

    return isolated;
  }

  /**
   * Strip internal params only
   */
  _stripInternalParams(params) {
    const cleaned = {};

    for (const [key, value] of Object.entries(params)) {
      if (!this.internalParams.includes(key) && !key.startsWith('_')) {
        cleaned[key] = value;
      }
    }

    return cleaned;
  }

  /**
   * Split params for multiple actions from a merged param object
   * Useful when a single request has params for multiple tasks
   *
   * @param {object} mergedParams - All params
   * @param {string[]} actions - List of actions
   * @returns {object} - { action1: {...}, action2: {...} }
   */
  splitForActions(mergedParams, actions) {
    const result = {};

    for (const action of actions) {
      result[action] = this.isolate(action, mergedParams);
    }

    return result;
  }

  /**
   * Check if a param belongs to an action
   */
  paramBelongsTo(param, action) {
    const allowedParams = this.actionParams[action] || [];
    return allowedParams.includes(param);
  }

  /**
   * Get all params for an action
   */
  getAllowedParams(action) {
    return this.actionParams[action] || [];
  }

  /**
   * Find which action a param most likely belongs to
   */
  findActionForParam(param) {
    const matches = [];

    for (const [action, params] of Object.entries(this.actionParams)) {
      if (params.includes(param)) {
        matches.push(action);
      }
    }

    return matches;
  }

  /**
   * Validate params for an action
   * Returns warnings for extra/missing params
   */
  validate(action, params) {
    const result = {
      valid: true,
      extraParams: [],
      warnings: [],
    };

    const allowedParams = this.actionParams[action];
    if (!allowedParams) {
      result.warnings.push(`Unknown action: ${action}`);
      return result;
    }

    for (const key of Object.keys(params)) {
      if (!allowedParams.includes(key) && !key.startsWith('_')) {
        result.extraParams.push(key);
        result.warnings.push(`Param '${key}' is not recognized for ${action}`);
      }
    }

    result.valid = result.extraParams.length === 0;

    return result;
  }

  /**
   * Add custom action params (for extensions)
   */
  registerAction(action, params) {
    this.actionParams[action] = params;
  }
}

// Singleton
const parameterIsolator = new ParameterIsolator();

// Helper functions
function isolateParams(action, rawParams) {
  return parameterIsolator.isolate(action, rawParams);
}

function splitParams(mergedParams, actions) {
  return parameterIsolator.splitForActions(mergedParams, actions);
}

function validateParams(action, params) {
  return parameterIsolator.validate(action, params);
}

module.exports = {
  ParameterIsolator,
  isolateParams,
  splitParams,
  validateParams,
  ACTION_PARAMS,
};
