const TOOL_ACTIONS = /\b(send|email|post|create|add|set|remind|update|edit|delete|remove|schedule|cancel|reschedule|find|search|list|show|fetch|read|check|summari[sz]e|monitor|sync|move|upload|download|share|invite|assign|close|reopen|comment|reply|draft|notify|connect|disconnect|run|execute)\b/i;
const WORK_DATA = /\b(email|mail|calendar|meeting|event|reminder|message|channel|issue|ticket|bug|pull request|pr|repository|repo|commit|task|project|document|file|sheet|spread\s*sheet|worksheet|workbook|invoice|customer|order|contact)\b/i;
const POSSESSIVE_WORK_QUERY = /\b(my|our|assigned to me|for me)\b[\s\S]{0,50}\b(emails?|meetings?|events?|issues?|tickets?|pull requests?|prs?|repositories|repos|tasks?|projects?|files?|documents?)\b/i;

const TOOLKIT_ALIASES = {
  GITHUB: ['github', 'repo', 'repository', 'pull request', 'commit'],
  GMAIL: ['gmail', 'email', 'mail'],
  GOOGLECALENDAR: ['google calendar', 'calendar', 'meeting', 'event', 'reminder'],
  GOOGLESHEETS: ['google sheets', 'google sheet', 'spreadsheet', 'spread sheet', 'spreed sheet', 'worksheet', 'workbook'],
  GOOGLEDOCS: ['google docs', 'google doc', 'document'],
  GOOGLEDRIVE: ['google drive', 'drive', 'file', 'folder'],
  SLACK: ['slack', 'channel', 'slack message'],
  JIRA: ['jira', 'issue', 'ticket', 'bug', 'story'],
  TRELLO: ['trello', 'board', 'card'],
  ASANA: ['asana', 'task', 'project'],
  NOTION: ['notion', 'page', 'database'],
  ZOOM: ['zoom', 'meeting'],
  FRAPPE: ['frappe', 'erpnext', 'invoice', 'customer', 'sales order'],
  DROPBOX: ['dropbox', 'file'],
};

function normalizeToolkits(toolkits = []) {
  return [...new Set(toolkits.map(item => String(item || '').trim().toUpperCase()).filter(Boolean))];
}

function toolkitTerms(toolkits) {
  return normalizeToolkits(toolkits).flatMap(toolkit => [
    toolkit.toLowerCase().replaceAll('_', ' '),
    ...(TOOLKIT_ALIASES[toolkit] || []),
  ]);
}

function isGreetingOrCourtesy(message) {
  const text = String(message || '').trim().toLowerCase();
  return /^(hi|hello|hey|good\s+(morning|afternoon|evening)|thanks?|thank\s+you|okay|ok|cool|great|bye|goodbye)[!.?\s]*$/i.test(text);
}

function classifyToolIntent(message, enabledToolkits = [], conversationHistory = []) {
  const text = String(message || '').trim();
  if (!text) return { requiresTools: false, reason: 'empty' };

  if (isGreetingOrCourtesy(text)) {
    return {
      requiresTools: false,
      reason: 'greeting',
      immediateReply: /thank/i.test(text)
        ? "You're welcome. What would you like help with?"
        : 'Hi! How can I help you today?',
    };
  }

  const lower = text.toLowerCase();
  const terms = toolkitTerms(enabledToolkits);
  const mentionsEnabledApp = terms.some(term => term && lower.includes(term));
  const hasAction = TOOL_ACTIONS.test(text);
  const hasWorkData = WORK_DATA.test(text);
  const requestsPersonalWorkData = POSSESSIVE_WORK_QUERY.test(text);
  const connectionRequest = /\b(connect|disconnect|connected|connection|integration|oauth)\b/i.test(text);
  const recentContext = (conversationHistory || [])
    .slice(-4)
    .map(item => String(item?.text || item?.content || ''))
    .join(' ')
    .toLowerCase();
  const contextualToolFollowup = /\b(send|share|email|post|show|list|open|close|closed|done|complete|completed|resolved|delete|update|more|all|that|them|it|proceed|continue|retry|again)\b/i.test(text) &&
    (WORK_DATA.test(recentContext) || terms.some(term => term && recentContext.includes(term)));

  const requiresTools = connectionRequest ||
    (hasAction && (mentionsEnabledApp || hasWorkData)) ||
    (mentionsEnabledApp && requestsPersonalWorkData) ||
    contextualToolFollowup;

  return {
    requiresTools,
    reason: requiresTools ? 'work_action' : 'general_chat',
    mentionsEnabledApp,
  };
}

module.exports = { classifyToolIntent, normalizeToolkits };
