/**
 * Canonical catalogue for every application currently visible in SwiftCollab.
 *
 * A catalogue entry is not a claim that native OAuth is already configured.
 * `direct.status` deliberately distinguishes a working native connector from a
 * connector whose provider-specific OAuth/API adapter still has to be built.
 * Composio remains available as the migration fallback.
 */
const CONNECTOR_CATALOG = [
  entry('salesforce', 'Salesforce', 'SALESFORCE', 'crm'),
  entry('axonaut', 'Axonaut', 'AXONAUT', 'crm'),
  entry('hubspot', 'HubSpot', 'HUBSPOT', 'crm'),
  entry('zendesk', 'Zendesk', 'ZENDESK', 'crm'),
  entry('intercom', 'Intercom', 'INTERCOM', 'crm'),
  entry('servicenow', 'ServiceNow', 'SERVICENOW', 'business'),
  entry('workday', 'Workday', 'WORKDAY', 'business'),
  entry('frappe', 'Frappe/ERPNext', 'FRAPPE', 'business', {
    status: 'available',
    connector: 'frappe',
    authType: 'api_key',
  }),
  entry('discord', 'Discord', 'DISCORD', 'communication'),
  entry('twitter', 'Twitter/X', 'TWITTER', 'social'),
  entry('linkedin', 'LinkedIn', 'LINKEDIN', 'social'),
  entry('figma', 'Figma', 'FIGMA', 'design'),
  entry('miro', 'Miro', 'MIRO', 'design'),
  entry('gcalender', 'Google Calendar', 'GOOGLECALENDAR', 'productivity', {
    status: 'available',
    connector: 'google_workspace',
    authType: 'oauth2',
  }),
  entry('gmail', 'Gmail', 'GMAIL', 'productivity'),
  entry('slack', 'Slack', 'SLACK', 'productivity'),
  entry('zoom', 'Zoom', 'ZOOM', 'productivity'),
  entry('outlook', 'Outlook', 'OUTLOOK', 'productivity'),
  entry('jira', 'Jira', 'JIRA', 'project', {
    status: 'available',
    connector: 'jira',
    authType: 'oauth2',
  }),
  entry('asana', 'Asana', 'ASANA', 'project'),
  entry('clickup', 'ClickUp', 'CLICKUP', 'project'),
  entry('notion', 'Notion', 'NOTION', 'project'),
  entry('trello', 'Trello', 'TRELLO', 'project'),
  entry('monday', 'Monday.com', 'MONDAY', 'project'),
  entry('todoist', 'Todoist', 'TODOIST', 'project'),
  entry('github', 'GitHub', 'GITHUB', 'developer'),
  entry('gitlab', 'GitLab', 'GITLAB', 'developer'),
  entry('bitbucket', 'Bitbucket', 'BITBUCKET', 'developer'),
  entry('confluence', 'Confluence', 'CONFLUENCE', 'developer'),
  entry('drive', 'Google Drive', 'GOOGLEDRIVE', 'storage'),
  entry('docs', 'Google Docs', 'GOOGLEDOCS', 'storage'),
  entry('sheets', 'Google Sheets', 'GOOGLESHEETS', 'storage', {
    status: 'available',
    connector: 'google_workspace',
    authType: 'oauth2',
  }),
  entry('dropbox', 'Dropbox', 'DROPBOX', 'storage'),
];

function entry(id, name, toolkit, category, direct = {}) {
  return Object.freeze({
    id,
    name,
    toolkit,
    category,
    actionPrefix: `${toolkit}_`,
    providers: {
      direct: {
        status: direct.status || 'setup_required',
        connector: direct.connector || id,
        authType: direct.authType || 'oauth2',
      },
      composio: { status: 'available', connector: 'composio' },
    },
  });
}

const CONNECTORS_BY_ID = new Map(CONNECTOR_CATALOG.map(item => [item.id, item]));
const CONNECTORS_BY_TOOLKIT = new Map(CONNECTOR_CATALOG.map(item => [item.toolkit, item]));

function getConnector(appIdOrToolkit) {
  const raw = String(appIdOrToolkit || '').trim();
  return CONNECTORS_BY_ID.get(raw.toLowerCase()) || CONNECTORS_BY_TOOLKIT.get(raw.toUpperCase()) || null;
}

function connectorForAction(actionName) {
  const action = String(actionName || '').toUpperCase();
  return CONNECTOR_CATALOG.find(item => action.startsWith(item.actionPrefix)) || null;
}

function publicConnectorCatalog() {
  return CONNECTOR_CATALOG.map(item => ({
    id: item.id,
    name: item.name,
    toolkit: item.toolkit,
    category: item.category,
    providers: item.providers,
  }));
}

module.exports = {
  CONNECTOR_CATALOG,
  getConnector,
  connectorForAction,
  publicConnectorCatalog,
};
