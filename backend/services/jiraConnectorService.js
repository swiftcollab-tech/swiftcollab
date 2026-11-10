const crypto = require('crypto');
const { query, getClient } = require('../db');
const { encrypt, decrypt } = require('./credentialEncryptionService');

const AUTH_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';
const SCOPES = ['read:jira-work', 'read:jira-user', 'write:jira-work', 'offline_access'];
const ACTION_ALIASES = {
  JIRA_CREATE_JIRA_ISSUE: 'JIRA_CREATE_ISSUE',
  JIRA_GET_JIRA_ISSUE_DETAILS: 'JIRA_GET_ISSUE',
  JIRA_UPDATE_JIRA_ISSUE: 'JIRA_UPDATE_ISSUE',
  JIRA_LIST_ISSUES: 'JIRA_SEARCH_ISSUES',
  JIRA_FIND_ISSUES: 'JIRA_SEARCH_ISSUES',
};
const SUPPORTED_ACTIONS = new Set([
  'JIRA_CREATE_ISSUE',
  'JIRA_SEARCH_ISSUES',
  'JIRA_GET_ISSUES',
  'JIRA_GET_ISSUE',
  'JIRA_UPDATE_ISSUE',
  'JIRA_ADD_COMMENT',
  'JIRA_TRANSITION_ISSUE',
  'JIRA_GET_ALL_PROJECTS',
  'JIRA_LIST_PROJECTS',
  'JIRA_LIST_CONNECTED_SITES',
]);

const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const randomValue = () => crypto.randomBytes(32).toString('base64url');

function config() {
  const clientId = process.env.JIRA_CLIENT_ID;
  const clientSecret = process.env.JIRA_CLIENT_SECRET;
  const redirectUri = process.env.JIRA_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    const error = new Error('Native Jira OAuth is not configured. Set JIRA_CLIENT_ID, JIRA_CLIENT_SECRET, and JIRA_REDIRECT_URI.');
    error.code = 'JIRA_OAUTH_NOT_CONFIGURED';
    throw error;
  }
  return { clientId, clientSecret, redirectUri };
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_error) { return text; }
}

function providerError(prefix, response, body) {
  const detail = body?.error_description || body?.message || body?.errorMessages?.join?.(', ') || body?.error || (typeof body === 'string' ? body : '');
  const error = new Error(`${prefix}${detail ? `: ${detail}` : ''}`);
  error.statusCode = response.status;
  error.providerStatus = response.status;
  return error;
}

async function startConnection({ organizationId, userId }) {
  const { clientId, redirectUri } = config();
  const state = randomValue();
  const authorization = await query(
    `INSERT INTO oauth_authorization_states
       (state_hash, organization_id, requested_by_user_id, provider, encrypted_code_verifier, expires_at)
     VALUES ($1, $2, $3, 'jira', $4, NOW() + INTERVAL '10 minutes')
     RETURNING id`,
    [hash(state), organizationId, userId, encrypt(randomValue())]
  );

  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });
  return { authorizationUrl: `${AUTH_URL}?${params.toString()}`, connectionAttemptId: authorization.rows[0].id };
}

const publicSite = row => ({
  connectionId: row.id,
  siteId: row.external_resource_id,
  siteName: row.external_resource_name,
  siteUrl: row.metadata?.siteUrl || null,
  isPrimary: row.is_primary === true,
  connectedAt: row.connected_at,
});

async function saveSiteConnection({ client, authorization, site, credentials }) {
  const existingPrimary = await client.query(
    `SELECT id FROM organization_integrations
     WHERE organization_id = $1 AND provider = 'jira' AND status = 'connected' AND is_primary = TRUE
     LIMIT 1`,
    [authorization.organization_id]
  );
  const makePrimary = existingPrimary.rowCount === 0;
  const metadata = {
    siteUrl: site.url || null,
    authorizationStateId: authorization.id,
  };
  const result = await client.query(
    `INSERT INTO organization_integrations
       (organization_id, provider, integration_key, connected_by_user_id, status, scopes,
        encrypted_credentials, external_resource_id, external_resource_name, metadata, is_primary)
     VALUES ($1, 'jira', $2, $3, 'connected', $4, $5, $6, $7, $8, $9)
     ON CONFLICT (organization_id, provider, integration_key) DO UPDATE SET
       connected_by_user_id = EXCLUDED.connected_by_user_id,
       status = 'connected',
       scopes = EXCLUDED.scopes,
       encrypted_credentials = EXCLUDED.encrypted_credentials,
       external_resource_id = EXCLUDED.external_resource_id,
       external_resource_name = EXCLUDED.external_resource_name,
       metadata = EXCLUDED.metadata,
       is_primary = organization_integrations.is_primary OR EXCLUDED.is_primary,
       disconnected_at = NULL,
       updated_at = NOW()
     RETURNING *`,
    [
      authorization.organization_id,
      `site:${site.id}`,
      authorization.requested_by_user_id,
      JSON.stringify(SCOPES),
      encrypt(credentials),
      site.id,
      site.name,
      JSON.stringify(metadata),
      makePrimary,
    ]
  );
  return result.rows[0];
}

async function completeConnection({ state, code, fetchImpl = fetch }) {
  const lookup = await query(
    `SELECT * FROM oauth_authorization_states
     WHERE state_hash = $1 AND provider = 'jira' AND consumed_at IS NULL AND expires_at > NOW()`,
    [hash(state)]
  );
  const authorization = lookup.rows[0];
  if (!authorization || !code) throw new Error('Jira authorization has expired or is invalid');

  const { clientId, clientSecret, redirectUri } = config();
  const tokenResponse = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const tokens = await responseBody(tokenResponse);
  if (!tokenResponse.ok) throw providerError('Unable to exchange the Jira authorization code', tokenResponse, tokens);

  const resourcesResponse = await fetchImpl(RESOURCES_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
  });
  const resources = await responseBody(resourcesResponse);
  if (!resourcesResponse.ok) throw providerError('Unable to load Jira sites', resourcesResponse, resources);
  const jiraSites = (Array.isArray(resources) ? resources : []).filter(item =>
    Array.isArray(item.scopes) && item.scopes.some(scope => String(scope).includes('jira'))
  );
  if (!jiraSites.length) throw new Error('No Jira Cloud site was granted to SwiftCollab');

  const selected = jiraSites.length === 1 ? jiraSites[0] : null;
  const credentials = {
    ...tokens,
    expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
  };
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let connection = null;
    if (selected) {
      connection = await saveSiteConnection({ client, authorization, site: selected, credentials });
    } else {
      const metadata = {
        authorizationStateId: authorization.id,
        resources: jiraSites.map(site => ({ id: site.id, name: site.name, url: site.url, scopes: site.scopes })),
      };
      const pending = await client.query(
        `INSERT INTO organization_integrations
           (organization_id, provider, integration_key, connected_by_user_id, status, scopes,
            encrypted_credentials, metadata, is_primary)
         VALUES ($1, 'jira', $2, $3, 'pending_selection', $4, $5, $6, FALSE)
         ON CONFLICT (organization_id, provider, integration_key) DO UPDATE SET
           connected_by_user_id = EXCLUDED.connected_by_user_id,
           status = 'pending_selection', scopes = EXCLUDED.scopes,
           encrypted_credentials = EXCLUDED.encrypted_credentials, metadata = EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING id`,
        [
          authorization.organization_id,
          `pending:${authorization.id}`,
          authorization.requested_by_user_id,
          JSON.stringify(SCOPES),
          encrypt(credentials),
          JSON.stringify(metadata),
        ]
      );
      connection = pending.rows[0];
    }
    await client.query('UPDATE oauth_authorization_states SET consumed_at = NOW() WHERE id = $1', [authorization.id]);
    await client.query('COMMIT');
    return {
      organizationId: authorization.organization_id,
      connected: !!selected,
      connectionId: connection.id,
      siteId: selected?.id || null,
      siteName: selected?.name || null,
      requiresResourceSelection: !selected,
      connectionAttemptId: authorization.id,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function status(organizationId, connectionAttemptId = null) {
  const result = await query(
    `SELECT id, status, scopes, connected_at, external_resource_id, external_resource_name, metadata, is_primary
     FROM organization_integrations
     WHERE organization_id = $1 AND provider = 'jira'
       AND status IN ('connected', 'pending_selection')
     ORDER BY is_primary DESC, connected_at ASC`,
    [organizationId]
  );
  const connectedRows = result.rows.filter(row => row.status === 'connected');
  const pendingRows = result.rows.filter(row => row.status === 'pending_selection');
  const attemptMatch = connectionAttemptId
    ? result.rows.find(row => String(row.metadata?.authorizationStateId) === String(connectionAttemptId))
    : null;
  const pending = attemptMatch?.status === 'pending_selection'
    ? attemptMatch
    : (!connectionAttemptId ? pendingRows[0] : null);
  const primary = connectedRows.find(row => row.is_primary) || connectedRows[0] || null;
  return {
    connected: connectedRows.length > 0,
    status: connectedRows.length ? 'connected' : (pending ? 'pending_selection' : 'disconnected'),
    siteId: primary?.external_resource_id || null,
    siteName: primary?.external_resource_name || null,
    activeConnectionId: primary?.id || null,
    connections: connectedRows.map(publicSite),
    connectionCount: connectedRows.length,
    pendingConnectionId: pending?.id || null,
    resources: pending?.metadata?.resources || [],
    requiresResourceSelection: Boolean(pending),
    attemptComplete: Boolean(attemptMatch),
  };
}

async function selectResource({ organizationId, resourceId, connectionId }) {
  const result = await query(
    `SELECT * FROM organization_integrations
     WHERE organization_id = $1 AND provider = 'jira' AND status = 'pending_selection'
       AND ($2::uuid IS NULL OR id = $2::uuid)
     ORDER BY updated_at DESC LIMIT 1`,
    [organizationId, connectionId || null]
  );
  const pending = result.rows[0];
  const resources = pending?.metadata?.resources || [];
  const selected = resources.find(resource => resource.id === resourceId);
  if (!pending || !selected) {
    const error = new Error('Select one of the Jira sites granted during authorization');
    error.statusCode = 400;
    throw error;
  }
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const authorization = {
      id: pending.metadata?.authorizationStateId,
      organization_id: organizationId,
      requested_by_user_id: pending.connected_by_user_id,
    };
    const connection = await saveSiteConnection({
      client,
      authorization,
      site: selected,
      credentials: decrypt(pending.encrypted_credentials),
    });
    await client.query('DELETE FROM organization_integrations WHERE id = $1', [pending.id]);
    await client.query('COMMIT');
    return { connected: true, status: 'connected', ...publicSite(connection) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function setPrimaryConnection({ organizationId, connectionId }) {
  const client = await getClient();
  let updated = false;
  try {
    await client.query('BEGIN');
    const target = await client.query(
      `SELECT id FROM organization_integrations
       WHERE id = $1 AND organization_id = $2 AND provider = 'jira' AND status = 'connected'
       FOR UPDATE`,
      [connectionId, organizationId]
    );
    if (!target.rowCount) {
      const error = new Error('Jira connection not found');
      error.statusCode = 404;
      throw error;
    }
    await client.query(
      `UPDATE organization_integrations SET is_primary = FALSE
       WHERE organization_id = $1 AND provider = 'jira' AND is_primary = TRUE`,
      [organizationId]
    );
    await client.query('UPDATE organization_integrations SET is_primary = TRUE WHERE id = $1', [connectionId]);
    await client.query('COMMIT');
    updated = true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (updated) return status(organizationId);
}

async function disconnect(organizationId, connectionId = null) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const targets = await client.query(
      `SELECT id, is_primary FROM organization_integrations
       WHERE organization_id = $1 AND provider = 'jira' AND status IN ('connected', 'pending_selection')
         AND ($2::uuid IS NULL OR id = $2::uuid)
       FOR UPDATE`,
      [organizationId, connectionId || null]
    );
    if (connectionId && !targets.rowCount) {
      const error = new Error('Jira connection not found');
      error.statusCode = 404;
      throw error;
    }
    await client.query(
      `UPDATE organization_integrations SET status = 'disconnected', is_primary = FALSE,
         disconnected_at = NOW(), encrypted_credentials = '', updated_at = NOW()
       WHERE organization_id = $1 AND provider = 'jira' AND status IN ('connected', 'pending_selection')
         AND ($2::uuid IS NULL OR id = $2::uuid)`,
      [organizationId, connectionId || null]
    );
    if (targets.rows.some(row => row.is_primary)) {
      await client.query(
        `UPDATE organization_integrations SET is_primary = TRUE
         WHERE id = (
           SELECT id FROM organization_integrations
           WHERE organization_id = $1 AND provider = 'jira' AND status = 'connected'
           ORDER BY connected_at ASC LIMIT 1
         )`,
        [organizationId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function loadIntegration(organizationId, selector = null) {
  const selectorText = String(selector || '').trim();
  const result = await query(
    `SELECT * FROM organization_integrations
     WHERE organization_id = $1 AND provider = 'jira' AND status = 'connected'
     ORDER BY CASE WHEN is_primary THEN 0 ELSE 1 END, connected_at ASC
    `,
    [organizationId]
  );
  let integration = result.rows[0];
  if (selectorText) {
    const normalized = selectorText.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    const values = row => [
      row.id,
      row.external_resource_id,
      row.external_resource_name,
      row.metadata?.siteUrl,
      String(row.metadata?.siteUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    ].filter(Boolean).map(item => String(item).toLowerCase());
    const exact = result.rows.filter(row => values(row).includes(normalized));
    const fuzzy = exact.length ? exact : result.rows.filter(row => values(row).some(item => item.includes(normalized)));
    if (fuzzy.length > 1) {
      const error = new Error(`More than one connected Jira site matches '${selectorText}'. Use the full site name or URL.`);
      error.code = 'JIRA_SITE_AMBIGUOUS';
      error.statusCode = 409;
      throw error;
    }
    integration = fuzzy[0];
  }
  if (!integration?.encrypted_credentials || !integration.external_resource_id) {
    const error = new Error(selectorText
      ? `No connected Jira site matches '${selectorText}'`
      : 'Jira is not directly connected for this organization');
    error.code = 'JIRA_NOT_CONNECTED';
    throw error;
  }
  return integration;
}

async function accessContext(organizationId, selector = null, fetchImpl = fetch) {
  const integration = await loadIntegration(organizationId, selector);
  let credentials = decrypt(integration.encrypted_credentials);
  if (Number(credentials.expires_at || 0) <= Date.now() + 60_000) {
    const { clientId, clientSecret } = config();
    if (!credentials.refresh_token) throw new Error('Jira access expired and no refresh token is available. Reconnect Jira.');
    const refreshResponse = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: credentials.refresh_token,
      }),
    });
    const refreshed = await responseBody(refreshResponse);
    if (!refreshResponse.ok) throw providerError('Unable to refresh Jira access', refreshResponse, refreshed);
    credentials = {
      ...credentials,
      ...refreshed,
      refresh_token: refreshed.refresh_token || credentials.refresh_token,
      expires_at: Date.now() + (Number(refreshed.expires_in) || 3600) * 1000,
    };
    await query(
      `UPDATE organization_integrations SET encrypted_credentials = $2, updated_at = NOW() WHERE id = $1`,
      [integration.id, encrypt(credentials)]
    );
  }
  return {
    accessToken: credentials.access_token,
    cloudId: integration.external_resource_id,
    connectionId: integration.id,
    siteName: integration.external_resource_name,
  };
}

function adf(text) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text || '') }] }] };
}

async function jiraRequest({ organizationId, siteSelector = null, path, method = 'GET', body, queryParams, fetchImpl = fetch }) {
  const { accessToken, cloudId } = await accessContext(organizationId, siteSelector, fetchImpl);
  const url = new URL(`https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(queryParams || {})) {
    if (value == null) continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await responseBody(response);
  if (!response.ok) throw providerError('Jira API request failed', response, data);
  return data;
}

const value = (params, ...keys) => keys.map(key => params?.[key]).find(item => item !== undefined && item !== null && item !== '');

function normalizeIssueKey(issueKey) {
  const raw = String(issueKey || '').trim();
  const match = raw.match(/^([A-Z][A-Z0-9_]*)\s*-\s*(\d+)$/i);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : raw;
}

const issueKeyFrom = params => normalizeIssueKey(value(
  params,
  'issue_key',
  'issueKey',
  'issue_id_or_key',
  'issueIdOrKey',
  'issue_id',
  'issueId',
  'key'
));

function isCurrentUserAssignee(assignee, requestingUserId = null) {
  const normalized = String(assignee || '').trim().toLowerCase().replace(/\s+/g, '');
  return ['me', 'myself', 'currentuser', 'currentuser()', 'current_user'].includes(normalized) ||
    Boolean(requestingUserId && normalized === String(requestingUserId).trim().toLowerCase());
}

async function resolveAssignee(organizationId, siteSelector, assignee, requestingUserId, fetchImpl) {
  if (assignee && typeof assignee === 'object' && assignee.accountId) return assignee.accountId;
  if (!isCurrentUserAssignee(assignee, requestingUserId)) return assignee;
  const currentUser = await jiraRequest({ organizationId, siteSelector, path: 'myself', fetchImpl });
  if (!currentUser?.accountId) throw new Error('Jira did not return an account ID for the connected user');
  return currentUser.accountId;
}

function selectTransition(transitions, transition) {
  const wanted = String(transition || '').toLowerCase();
  let match = transitions.find(item => item.id === String(transition) || item.name?.toLowerCase() === wanted);
  const terminalIntent = /^(?:closed|done|complete|completed|resolved)$/i.test(wanted);
  if (!match && terminalIntent) {
    match = transitions.find(item => item.to?.statusCategory?.key === 'done') ||
      transitions.find(item => /\b(?:close|closed|done|complete|completed|resolve|resolved)\b/i.test(String(item.name || '')));
  }
  return match || null;
}

async function transitionIssue(organizationId, siteSelector, issueKey, transition, fetchImpl) {
  const available = await jiraRequest({ organizationId, siteSelector, path: `issue/${encodeURIComponent(issueKey)}/transitions`, fetchImpl });
  const transitions = available?.transitions || [];
  const match = selectTransition(transitions, transition);
  if (!match) {
    const names = transitions.map(item => item.name).filter(Boolean);
    throw new Error(`Jira transition '${transition}' is not available for ${issueKey}${names.length ? `. Available transitions: ${names.join(', ')}` : ''}`);
  }
  return jiraRequest({
    organizationId,
    siteSelector,
    path: `issue/${encodeURIComponent(issueKey)}/transitions`,
    method: 'POST',
    body: { transition: { id: match.id } },
    fetchImpl,
  });
}

async function executeAction({ organizationId, actionName, params = {}, userId = null, fetchImpl = fetch }) {
  if (!organizationId) throw new Error('organizationId is required for the native Jira connector');
  const requestedAction = String(actionName || '').toUpperCase();
  const action = ACTION_ALIASES[requestedAction] || requestedAction;
  const siteSelector = value(params, 'jira_site', 'jiraSite', 'site_id', 'siteId', 'connection_id', 'connectionId');

  if (action === 'JIRA_LIST_CONNECTED_SITES') {
    const connectionStatus = await status(organizationId);
    return {
      activeConnectionId: connectionStatus.activeConnectionId,
      sites: connectionStatus.connections,
    };
  }

  if (action === 'JIRA_CREATE_ISSUE') {
    const projectKey = value(params, 'project_key', 'projectKey');
    const summary = value(params, 'summary');
    if (!projectKey || !summary) throw new Error('Jira create issue requires project_key and summary');
    const fields = {
      project: { key: projectKey },
      summary,
      issuetype: { name: value(params, 'issue_type', 'issueType') || 'Task' },
    };
    if (params.description) fields.description = adf(params.description);
    if (params.priority) fields.priority = { name: params.priority };
    if (params.labels) fields.labels = params.labels;
    if (params.parent_key) fields.parent = { key: params.parent_key };
    if (params.assignee) {
      fields.assignee = { accountId: await resolveAssignee(organizationId, siteSelector, params.assignee, userId, fetchImpl) };
    }
    return jiraRequest({ organizationId, siteSelector, path: 'issue', method: 'POST', body: { fields }, fetchImpl });
  }

  if (action === 'JIRA_SEARCH_ISSUES' || action === 'JIRA_GET_ISSUES') {
    const projectKey = value(params, 'project_key', 'projectKey');
    const jql = params.jql || (projectKey ? `project = "${String(projectKey).replaceAll('"', '\\"')}" ORDER BY updated DESC` : 'ORDER BY updated DESC');
    return jiraRequest({
      organizationId,
      siteSelector,
      path: 'search/jql',
      method: 'POST',
      body: {
        jql,
        maxResults: Math.min(Number(value(params, 'maxResults', 'max_results')) || 25, 100),
        fields: params.fields || ['summary', 'status', 'priority', 'assignee', 'updated'],
      },
      fetchImpl,
    });
  }

  if (action === 'JIRA_GET_ISSUE') {
    const issueKey = issueKeyFrom(params);
    if (!issueKey) throw new Error('Jira get issue requires issue_key');
    return jiraRequest({ organizationId, siteSelector, path: `issue/${encodeURIComponent(issueKey)}`, queryParams: { fields: params.fields }, fetchImpl });
  }

  if (action === 'JIRA_UPDATE_ISSUE') {
    const issueKey = issueKeyFrom(params);
    if (!issueKey) throw new Error('Jira update issue requires issue_key');
    const fields = {};
    if (params.summary !== undefined) fields.summary = params.summary;
    if (params.description !== undefined) fields.description = adf(params.description);
    if (params.priority !== undefined) fields.priority = { name: params.priority };
    if (params.labels !== undefined) fields.labels = params.labels;
    if (params.assignee !== undefined) {
      const accountId = await resolveAssignee(organizationId, siteSelector, params.assignee, userId, fetchImpl);
      await jiraRequest({
        organizationId,
        siteSelector,
        path: `issue/${encodeURIComponent(issueKey)}/assignee`,
        method: 'PUT',
        body: { accountId },
        fetchImpl,
      });
    }
    if (Object.keys(fields).length) {
      await jiraRequest({ organizationId, siteSelector, path: `issue/${encodeURIComponent(issueKey)}`, method: 'PUT', body: { fields }, fetchImpl });
    }
    const transition = value(params, 'transition', 'status');
    if (transition) await transitionIssue(organizationId, siteSelector, issueKey, transition, fetchImpl);
    return { key: issueKey, updated: true };
  }

  if (action === 'JIRA_ADD_COMMENT') {
    const issueKey = issueKeyFrom(params);
    const comment = value(params, 'comment', 'body');
    if (!issueKey || !comment) throw new Error('Jira add comment requires issue_key and comment');
    return jiraRequest({ organizationId, siteSelector, path: `issue/${encodeURIComponent(issueKey)}/comment`, method: 'POST', body: { body: adf(comment) }, fetchImpl });
  }

  if (action === 'JIRA_TRANSITION_ISSUE') {
    const issueKey = issueKeyFrom(params);
    const transition = value(params, 'transition', 'transitionId', 'status');
    if (!issueKey || !transition) throw new Error('Jira transition requires issue_key and transition');
    await transitionIssue(organizationId, siteSelector, issueKey, transition, fetchImpl);
    return { key: issueKey, transitioned: true };
  }

  if (action === 'JIRA_GET_ALL_PROJECTS' || action === 'JIRA_LIST_PROJECTS') {
    return jiraRequest({ organizationId, siteSelector, path: 'project/search', queryParams: { maxResults: 100 }, fetchImpl });
  }

  throw new Error(`Native Jira connector does not support action ${actionName}`);
}

function supportsAction(actionName) {
  const requested = String(actionName || '').toUpperCase();
  return SUPPORTED_ACTIONS.has(ACTION_ALIASES[requested] || requested);
}

function getTools() {
  const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const text = description => ({ type: 'string', description });
  const jiraSite = () => text('Optional connected Jira site name, cloud ID, URL, or connection ID. Uses the primary site when omitted.');
  return [
    {
      name: 'JIRA_LIST_CONNECTED_SITES',
      description: 'List the Jira Cloud sites connected to this SwiftCollab organization and identify the primary site',
      parameters: object({ jira_site: jiraSite() }),
    },
    {
      name: 'JIRA_CREATE_ISSUE',
      description: 'Create a Jira Cloud issue in a project',
      parameters: object({
        jira_site: jiraSite(),
        project_key: text('Jira project key, for example SWIFT'),
        summary: text('Short issue summary'),
        description: text('Issue description'),
        issue_type: text('Issue type such as Task, Bug, or Story'),
        priority: text('Priority name'),
        assignee: text('Atlassian account ID of the assignee'),
        labels: { type: 'array', items: { type: 'string' } },
        parent_key: text('Optional parent issue key'),
      }, ['project_key', 'summary']),
    },
    {
      name: 'JIRA_SEARCH_ISSUES',
      description: 'Search Jira issues using JQL or a project key',
      parameters: object({
        jira_site: jiraSite(),
        jql: text('Jira Query Language expression'),
        project_key: text('Optional project key'),
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
        fields: { type: 'array', items: { type: 'string' } },
      }),
    },
    {
      name: 'JIRA_GET_ISSUE',
      description: 'Get a Jira issue by issue key',
      parameters: object({
        jira_site: jiraSite(),
        issue_key: text('Issue key, for example SWIFT-123'),
        fields: { type: 'array', items: { type: 'string' } },
      }, ['issue_key']),
    },
    {
      name: 'JIRA_UPDATE_ISSUE',
      description: 'Update fields or transition an existing Jira issue',
      parameters: object({
        jira_site: jiraSite(),
        issue_key: text('Issue key, for example SWIFT-123'),
        summary: text('New summary'),
        description: text('New description'),
        priority: text('New priority name'),
        assignee: text('Atlassian account ID of the assignee'),
        labels: { type: 'array', items: { type: 'string' } },
        status: text('Target workflow status or transition name'),
        transition: text('Target transition ID or name'),
      }, ['issue_key']),
    },
    {
      name: 'JIRA_ADD_COMMENT',
      description: 'Add a comment to a Jira issue',
      parameters: object({
        jira_site: jiraSite(),
        issue_key: text('Issue key, for example SWIFT-123'),
        comment: text('Comment text'),
      }, ['issue_key', 'comment']),
    },
    {
      name: 'JIRA_TRANSITION_ISSUE',
      description: 'Move a Jira issue through its workflow',
      parameters: object({
        jira_site: jiraSite(),
        issue_key: text('Issue key, for example SWIFT-123'),
        transition: text('Transition ID or name'),
      }, ['issue_key', 'transition']),
    },
    {
      name: 'JIRA_GET_ALL_PROJECTS',
      description: 'List Jira projects available to the connected account',
      parameters: object({ jira_site: jiraSite() }),
    },
  ];
}

module.exports = {
  SCOPES,
  startConnection,
  completeConnection,
  status,
  selectResource,
  setPrimaryConnection,
  disconnect,
  executeAction,
  supportsAction,
  getTools,
  adf,
  normalizeIssueKey,
  issueKeyFrom,
  isCurrentUserAssignee,
  selectTransition,
};
