const crypto = require('crypto');
const { google } = require('googleapis');
const { query } = require('../db');
const { encrypt, decrypt } = require('./credentialEncryptionService');

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
];
const SUPPORTED_ACTIONS = new Set([
  'GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_REPLY_TO_THREAD',
  'GOOGLECALENDAR_FIND_EVENT', 'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_UPDATE_EVENT',
  'GOOGLECALENDAR_DELETE_EVENT', 'GOOGLECALENDAR_FIND_FREE_SLOTS',
  'GOOGLEDRIVE_SEARCH_FILES', 'GOOGLEDRIVE_GET_FILE', 'GOOGLEDRIVE_CREATE_FOLDER', 'GOOGLEDRIVE_CREATE_FILE',
  'GOOGLEDOCS_CREATE_DOCUMENT', 'GOOGLEDOCS_GET_DOCUMENT', 'GOOGLEDOCS_APPEND_TEXT',
  'GOOGLESHEETS_CREATE_SPREADSHEET', 'GOOGLESHEETS_GET_VALUES', 'GOOGLESHEETS_APPEND_VALUES', 'GOOGLESHEETS_UPDATE_VALUES',
]);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const base64url = buffer => buffer.toString('base64url');

function oauthClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) throw new Error('Google OAuth is not configured');
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
}

async function startConnection({ organizationId, userId }) {
  const state = base64url(crypto.randomBytes(32));
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  await query(
    `INSERT INTO oauth_authorization_states (state_hash, organization_id, requested_by_user_id, provider, encrypted_code_verifier, expires_at)
     VALUES ($1, $2, $3, 'google_workspace', $4, NOW() + INTERVAL '10 minutes')`,
    [hash(state), organizationId, userId, encrypt(verifier)]
  );
  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: true,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { authorizationUrl: url };
}

async function completeConnection({ state, code }) {
  const lookup = await query(
    `SELECT * FROM oauth_authorization_states WHERE state_hash = $1 AND provider = 'google_workspace'
       AND consumed_at IS NULL AND expires_at > NOW()`,
    [hash(state || '')]
  );
  const record = lookup.rows[0];
  if (!record || !code) throw new Error('Google authorization has expired or is invalid');
  const client = oauthClient();
  const { tokens } = await client.getToken({ code, codeVerifier: decrypt(record.encrypted_code_verifier) });
  const integrationKey = `user:${record.requested_by_user_id}`;
  const existing = await query(
    `SELECT encrypted_credentials FROM organization_integrations
     WHERE organization_id = $1 AND provider = 'google_workspace' AND integration_key = $2`,
    [record.organization_id, integrationKey]
  );
  const oldTokens = existing.rows[0]?.encrypted_credentials ? decrypt(existing.rows[0].encrypted_credentials) : {};
  const mergedTokens = { ...oldTokens, ...tokens, refresh_token: tokens.refresh_token || oldTokens.refresh_token };
  if (!mergedTokens.refresh_token) throw new Error('Google did not return a refresh token. Remove SwiftCollab from your Google account permissions, then connect again.');
  client.setCredentials(mergedTokens);
  let profile = {};
  try {
    profile = (await google.oauth2({ version: 'v2', auth: client }).userinfo.get()).data || {};
  } catch (_error) {
    // Identity is helpful for the UI, but should not invalidate otherwise good OAuth tokens.
  }
  await query(
    `INSERT INTO organization_integrations
       (organization_id, provider, integration_key, connected_by_user_id, status, scopes, encrypted_credentials,
        external_account_id, external_resource_name, metadata, is_primary)
     VALUES ($1, 'google_workspace', $2, $3, 'connected', $4, $5, $6, $7, $8, FALSE)
     ON CONFLICT (organization_id, provider, integration_key) DO UPDATE SET connected_by_user_id = EXCLUDED.connected_by_user_id,
       status = 'connected', scopes = EXCLUDED.scopes, encrypted_credentials = EXCLUDED.encrypted_credentials,
       external_account_id = EXCLUDED.external_account_id, external_resource_name = EXCLUDED.external_resource_name,
       metadata = EXCLUDED.metadata, disconnected_at = NULL, updated_at = NOW()`,
    [record.organization_id, integrationKey, record.requested_by_user_id, JSON.stringify(SCOPES), encrypt(mergedTokens),
      profile.id || null, profile.email || profile.name || 'Google account', JSON.stringify({ email: profile.email || null, picture: profile.picture || null })]
  );
  await query('UPDATE oauth_authorization_states SET consumed_at = NOW() WHERE id = $1', [record.id]);
  return { connected: true, organizationId: record.organization_id, userId: record.requested_by_user_id, accountEmail: profile.email || null };
}

function normalizeScopes(scopes) {
  if (Array.isArray(scopes)) return scopes;
  try { return JSON.parse(scopes || '[]'); } catch (_error) { return []; }
}

async function status(organizationId, userId) {
  if (!organizationId || !userId) return { connected: false, status: 'disconnected', scopes: [] };
  const result = await query(
    `SELECT status, scopes, connected_at, external_resource_name, metadata
     FROM organization_integrations
     WHERE organization_id = $1 AND provider = 'google_workspace' AND integration_key = $2`,
    [organizationId, `user:${userId}`]
  );
  const integration = result.rows[0] || { status: 'disconnected', scopes: [] };
  const scopes = normalizeScopes(integration.scopes);
  return {
    ...integration,
    scopes,
    connected: integration.status === 'connected',
    accountEmail: integration.metadata?.email || integration.external_resource_name || null,
    connectionFamily: 'google_workspace',
    connectedApps: ['gmail', 'gcalender', 'drive', 'docs', 'sheets'],
    needs_reconnect: integration.status === 'connected' && !SCOPES.every(scope => scopes.includes(scope)),
  };
}

async function authenticatedClient(organizationId, userId = null) {
  const result = userId
    ? await query(
      `SELECT id, encrypted_credentials FROM organization_integrations
       WHERE organization_id = $1 AND provider = 'google_workspace' AND integration_key = $2 AND status = 'connected'`,
      [organizationId, `user:${userId}`]
    )
    : await query(
      `SELECT id, encrypted_credentials FROM organization_integrations
       WHERE organization_id = $1 AND provider = 'google_workspace' AND status = 'connected'
       ORDER BY (integration_key = 'default') DESC, updated_at DESC LIMIT 1`,
      [organizationId]
    );
  if (!result.rows[0]) throw new Error('Google Workspace is not connected for this organization');
  const client = oauthClient();
  const integration = result.rows[0];
  const credentials = decrypt(integration.encrypted_credentials);
  client.setCredentials(credentials);
  client.on('tokens', async tokens => {
    try {
      const updated = { ...credentials, ...tokens, refresh_token: tokens.refresh_token || credentials.refresh_token };
      await query('UPDATE organization_integrations SET encrypted_credentials = $2, updated_at = NOW() WHERE id = $1', [integration.id, encrypt(updated)]);
    } catch (error) {
      console.error('[GoogleWorkspace] Could not persist refreshed OAuth token:', error.message);
    }
  });
  return client;
}

async function disconnect(organizationId, userId) {
  if (!userId) throw new Error('userId is required to disconnect a personal Google account');
  await query(
    `UPDATE organization_integrations SET status = 'disconnected', disconnected_at = NOW(), encrypted_credentials = ''
     WHERE organization_id = $1 AND provider = 'google_workspace' AND integration_key = $2`,
    [organizationId, `user:${userId}`]
  );
}

function spreadsheetId(value) {
  const normalized = String(value || '').trim().replace(/&#x0*2f;|&#0*47;|&sol;/gi, '/');
  const match = normalized.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : normalized;
}

const COLUMN_ALIASES = {
  candidate_name: ['candidate name', 'student name', 'applicant name', 'name'],
  candidate_email: ['candidate email', 'student email', 'applicant email', 'email'],
  interviewer_name: ['interviewer name', 'mentor name', 'host name'],
  interviewer_email: ['interviewer email', 'mentor email', 'host email'],
  duration_minutes: ['duration minutes', 'duration', 'interview duration'],
  status: ['status', 'scheduling status'],
  purpose: ['purpose', 'topic', 'interview type', 'reason'],
  preferred_start: ['preferred start', 'start time', 'scheduled start', 'interview start'],
};

function parseSheetValues(values = []) {
  const [rawHeaders = [], ...rows] = values;
  const headers = rawHeaders.map(header => String(header || '').trim());
  const headerMap = new Map(headers.map((header, index) => [header.toLowerCase(), index]));
  const field = (row, fieldName) => {
    const index = COLUMN_ALIASES[fieldName].map(alias => headerMap.get(alias)).find(Number.isInteger);
    return index === undefined ? '' : String(row[index] || '').trim();
  };
  const assignments = rows.filter(row => row.some(value => String(value || '').trim())).map((row, index) => ({
    id: `google:${index + 2}`,
    candidate_name: field(row, 'candidate_name'),
    candidate_email: field(row, 'candidate_email'),
    interviewer_name: field(row, 'interviewer_name') || field(row, 'interviewer_email'),
    interviewer_email: field(row, 'interviewer_email'),
    duration_minutes: Number(field(row, 'duration_minutes')) || 60,
    status: field(row, 'status'),
    purpose: field(row, 'purpose'),
    preferred_start: field(row, 'preferred_start'),
  }));
  const required = ['candidate_name', 'candidate_email', 'interviewer_email', 'status'];
  const missingFields = required.filter(fieldName => !COLUMN_ALIASES[fieldName].some(alias => headerMap.has(alias)));
  const warnings = [];
  if (!headers.length) warnings.push('The selected Sheet range has no header row.');
  if (!rows.length) warnings.push('No data rows were found below the header row.');
  if (missingFields.length) warnings.push(`Scheduling needs columns for: ${missingFields.map(fieldName => fieldName.replace('_', ' ')).join(', ')}.`);
  const previewRows = rows.slice(0, 5).map(row => Object.fromEntries(headers.slice(0, 8).map((header, index) => [header, String(row[index] || '')])));
  return { headers: headers.slice(0, 20), previewRows, rowCount: assignments.length, assignments, warnings };
}

function toSheetReadError(error) {
  const message = String(error?.response?.data?.error?.message || error?.message || '');
  let publicMessage = 'SwiftCollab could not read this Google Sheet. Please try again.';
  if (/has not been used|is disabled|enable it/i.test(message)) publicMessage = 'Google Sheets API is not enabled for this Google Cloud project. Enable it, wait a few minutes, then retry.';
  else if (/permission|forbidden|not authorized/i.test(message)) publicMessage = 'SwiftCollab cannot access this Sheet. Share the Sheet with the Google account you connected, then retry.';
  else if (/not found|unable to parse range|range/i.test(message)) publicMessage = 'The Sheet or worksheet range was not found. Check the Sheet link and tab name (currently Sheet1).';
  const wrapped = new Error(publicMessage);
  wrapped.statusCode = error?.response?.status || 502;
  return wrapped;
}

async function readSheet({ organizationId, spreadsheet, range }) {
  const sheets = google.sheets({ version: 'v4', auth: await authenticatedClient(organizationId) });
  try {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(spreadsheet), range });
    return parseSheetValues(response.data.values || []);
  } catch (error) { throw toSheetReadError(error); }
}

async function readAssignments(options) {
  return (await readSheet(options)).assignments;
}

async function getBusyIntervals({ organizationId, rangeStart, rangeEnd, interviewerEmail, timezone }) {
  const calendar = google.calendar({ version: 'v3', auth: await authenticatedClient(organizationId) });
  const response = await calendar.freebusy.query({ requestBody: { timeMin: rangeStart, timeMax: rangeEnd, timeZone: timezone, items: [{ id: interviewerEmail }] } });
  return response.data.calendars?.[interviewerEmail]?.busy || [];
}

async function createInterviewEvent({ organizationId, executionId, assignment, start, end, timezone }) {
  const calendar = google.calendar({ version: 'v3', auth: await authenticatedClient(organizationId) });
  const response = await calendar.events.insert({
    calendarId: 'primary',
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: `Mock interview: ${assignment.candidate_name}`,
      description: assignment.purpose || 'Interview scheduled by SwiftCollab',
      start: { dateTime: start, timeZone: timezone },
      end: { dateTime: end, timeZone: timezone },
      attendees: [assignment.candidate_email, assignment.interviewer_email].filter(Boolean).map(email => ({ email })),
      conferenceData: { createRequest: { requestId: `swiftcollab-${executionId}` } },
      extendedProperties: { private: { swiftcollab_execution_id: executionId } },
    },
  });
  return { eventId: response.data.id, meetingUrl: response.data.hangoutLink || response.data.conferenceData?.entryPoints?.find(entry => entry.entryPointType === 'video')?.uri || null };
}

async function updateInterviewEvent({ organizationId, eventId, assignment, start, end, timezone }) {
  const calendar = google.calendar({ version: 'v3', auth: await authenticatedClient(organizationId) });
  const response = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    sendUpdates: 'all',
    requestBody: {
      summary: `Mock interview: ${assignment.candidate_name}`,
      description: assignment.purpose || 'Interview scheduled by SwiftCollab',
      start: { dateTime: start, timeZone: timezone },
      end: { dateTime: end, timeZone: timezone },
      attendees: [assignment.candidate_email, assignment.interviewer_email].filter(Boolean).map(email => ({ email })),
    },
  });
  return { meetingUrl: response.data.hangoutLink || response.data.conferenceData?.entryPoints?.find(entry => entry.entryPointType === 'video')?.uri || null };
}

function first(params, ...names) {
  for (const name of names) {
    const candidate = params?.[name];
    if (candidate !== undefined && candidate !== null && candidate !== '') return candidate;
  }
  return undefined;
}

function emailRaw({ to, subject, body, cc, bcc, inReplyTo }) {
  const lines = [
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    ...(cc ? [`Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}`] : []),
    ...(bcc ? [`Bcc: ${Array.isArray(bcc) ? bcc.join(', ') : bcc}`] : []),
    `Subject: ${subject || '(no subject)'}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    String(body || ''),
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

function headersByName(headers = []) {
  return Object.fromEntries(headers.map(item => [String(item.name || '').toLowerCase(), item.value]));
}

function asRows(values) {
  if (Array.isArray(values)) return Array.isArray(values[0]) ? values : [values];
  if (typeof values === 'string') {
    try { return asRows(JSON.parse(values)); } catch (_error) { return [[values]]; }
  }
  throw new Error('values must be an array of rows');
}

async function executeAction({ organizationId, userId, actionName, params = {} }) {
  if (!organizationId || !userId) throw new Error('A SwiftCollab organization and user are required for Google actions');
  const action = String(actionName || '').toUpperCase();
  if (!SUPPORTED_ACTIONS.has(action)) throw new Error(`Native Google connector does not support action ${actionName}`);
  const auth = await authenticatedClient(organizationId, userId);

  if (action.startsWith('GMAIL_')) {
    const gmail = google.gmail({ version: 'v1', auth });
    if (action === 'GMAIL_FETCH_EMAILS') {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: first(params, 'query', 'q') || undefined,
        labelIds: first(params, 'label_ids', 'labelIds'),
        maxResults: Math.min(Number(first(params, 'max_results', 'maxResults')) || 10, 50),
      });
      const messages = await Promise.all((list.data.messages || []).map(async item => {
        const response = await gmail.users.messages.get({ userId: 'me', id: item.id, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID'] });
        const header = headersByName(response.data.payload?.headers);
        return { id: item.id, threadId: response.data.threadId, snippet: response.data.snippet, from: header.from, to: header.to, subject: header.subject, date: header.date, messageId: header['message-id'] };
      }));
      return { messages, nextPageToken: list.data.nextPageToken || null };
    }
    const to = first(params, 'to', 'recipient', 'recipients');
    const subject = first(params, 'subject');
    const body = first(params, 'body', 'message', 'content');
    if (!to || body === undefined) throw new Error('Gmail action requires to and body');
    const requestBody = { raw: emailRaw({ to, subject, body, cc: params.cc, bcc: params.bcc, inReplyTo: first(params, 'in_reply_to', 'inReplyTo') }) };
    if (action === 'GMAIL_CREATE_EMAIL_DRAFT') {
      const response = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: requestBody } });
      return { draftId: response.data.id, messageId: response.data.message?.id };
    }
    if (action === 'GMAIL_REPLY_TO_THREAD') {
      const threadId = first(params, 'thread_id', 'threadId');
      if (!threadId) throw new Error('Replying to Gmail requires thread_id');
      requestBody.threadId = threadId;
    }
    const response = await gmail.users.messages.send({ userId: 'me', requestBody });
    return { messageId: response.data.id, threadId: response.data.threadId, sent: true };
  }

  if (action.startsWith('GOOGLECALENDAR_')) {
    const calendar = google.calendar({ version: 'v3', auth });
    const calendarId = first(params, 'calendar_id', 'calendarId') || 'primary';
    if (action === 'GOOGLECALENDAR_FIND_EVENT') {
      const response = await calendar.events.list({
        calendarId,
        q: first(params, 'query', 'q'),
        timeMin: first(params, 'time_min', 'timeMin') || new Date().toISOString(),
        timeMax: first(params, 'time_max', 'timeMax'),
        maxResults: Math.min(Number(first(params, 'max_results', 'maxResults')) || 20, 100),
        singleEvents: true,
        orderBy: 'startTime',
      });
      return { events: response.data.items || [], nextPageToken: response.data.nextPageToken || null };
    }
    if (action === 'GOOGLECALENDAR_FIND_FREE_SLOTS') {
      const timeMin = first(params, 'time_min', 'timeMin', 'start');
      const timeMax = first(params, 'time_max', 'timeMax', 'end');
      if (!timeMin || !timeMax) throw new Error('Finding free time requires time_min and time_max');
      const ids = first(params, 'calendar_ids', 'calendarIds') || [calendarId];
      const response = await calendar.freebusy.query({ requestBody: { timeMin, timeMax, timeZone: first(params, 'timezone', 'timeZone'), items: ids.map(id => ({ id })) } });
      return response.data;
    }
    const eventId = first(params, 'event_id', 'eventId');
    if (action === 'GOOGLECALENDAR_DELETE_EVENT') {
      if (!eventId) throw new Error('Deleting an event requires event_id');
      await calendar.events.delete({ calendarId, eventId, sendUpdates: first(params, 'send_updates', 'sendUpdates') || 'all' });
      return { eventId, deleted: true };
    }
    const start = first(params, 'start', 'start_time', 'startTime');
    const end = first(params, 'end', 'end_time', 'endTime');
    const timezone = first(params, 'timezone', 'timeZone');
    const requestBody = {
      summary: first(params, 'summary', 'title'),
      description: params.description,
      location: params.location,
      start: start ? { dateTime: start, ...(timezone ? { timeZone: timezone } : {}) } : undefined,
      end: end ? { dateTime: end, ...(timezone ? { timeZone: timezone } : {}) } : undefined,
      attendees: (params.attendees || []).map(item => ({ email: typeof item === 'string' ? item : item.email })),
    };
    if (action === 'GOOGLECALENDAR_CREATE_EVENT') {
      if (!requestBody.summary || !start || !end) throw new Error('Creating an event requires summary, start, and end');
      const response = await calendar.events.insert({ calendarId, sendUpdates: first(params, 'send_updates', 'sendUpdates') || 'all', conferenceDataVersion: params.create_meet ? 1 : 0, requestBody: { ...requestBody, ...(params.create_meet ? { conferenceData: { createRequest: { requestId: crypto.randomUUID() } } } : {}) } });
      return response.data;
    }
    if (!eventId) throw new Error('Updating an event requires event_id');
    Object.keys(requestBody).forEach(key => requestBody[key] === undefined && delete requestBody[key]);
    const response = await calendar.events.patch({ calendarId, eventId, sendUpdates: first(params, 'send_updates', 'sendUpdates') || 'all', requestBody });
    return response.data;
  }

  if (action.startsWith('GOOGLEDRIVE_')) {
    const drive = google.drive({ version: 'v3', auth });
    if (action === 'GOOGLEDRIVE_SEARCH_FILES') {
      const response = await drive.files.list({ q: first(params, 'query', 'q') || "trashed = false", pageSize: Math.min(Number(first(params, 'max_results', 'pageSize')) || 20, 100), fields: 'nextPageToken, files(id,name,mimeType,webViewLink,modifiedTime,owners(displayName,emailAddress))' });
      return response.data;
    }
    if (action === 'GOOGLEDRIVE_GET_FILE') {
      const fileId = first(params, 'file_id', 'fileId');
      if (!fileId) throw new Error('Getting a Drive file requires file_id');
      return (await drive.files.get({ fileId, fields: 'id,name,mimeType,webViewLink,createdTime,modifiedTime,size,description,parents,owners(displayName,emailAddress)' })).data;
    }
    const name = first(params, 'name', 'file_name', 'fileName');
    if (!name) throw new Error('Creating a Drive item requires name');
    const parents = first(params, 'parent_ids', 'parentIds', 'parents');
    const requestBody = { name, ...(parents ? { parents } : {}) };
    const response = action === 'GOOGLEDRIVE_CREATE_FOLDER'
      ? await drive.files.create({ requestBody: { ...requestBody, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id,name,mimeType,webViewLink' })
      : await drive.files.create({ requestBody, media: { mimeType: first(params, 'mime_type', 'mimeType') || 'text/plain', body: String(first(params, 'content', 'body') || '') }, fields: 'id,name,mimeType,webViewLink' });
    return response.data;
  }

  if (action.startsWith('GOOGLEDOCS_')) {
    const docs = google.docs({ version: 'v1', auth });
    if (action === 'GOOGLEDOCS_CREATE_DOCUMENT') {
      const title = first(params, 'title', 'name');
      if (!title) throw new Error('Creating a Google Doc requires title');
      const document = (await docs.documents.create({ requestBody: { title } })).data;
      const content = first(params, 'content', 'text');
      if (content) await docs.documents.batchUpdate({ documentId: document.documentId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: String(content) } }] } });
      return document;
    }
    const documentId = first(params, 'document_id', 'documentId');
    if (!documentId) throw new Error('Google Docs action requires document_id');
    if (action === 'GOOGLEDOCS_GET_DOCUMENT') return (await docs.documents.get({ documentId })).data;
    const text = first(params, 'text', 'content');
    if (text === undefined) throw new Error('Appending to a Google Doc requires text');
    const document = (await docs.documents.get({ documentId })).data;
    const endIndex = Math.max(1, Number(document.body?.content?.at(-1)?.endIndex || 2) - 1);
    await docs.documents.batchUpdate({ documentId, requestBody: { requests: [{ insertText: { location: { index: endIndex }, text: String(text) } }] } });
    return { documentId, updated: true };
  }

  const sheets = google.sheets({ version: 'v4', auth });
  if (action === 'GOOGLESHEETS_CREATE_SPREADSHEET') {
    const title = first(params, 'title', 'name');
    if (!title) throw new Error('Creating a spreadsheet requires title');
    return (await sheets.spreadsheets.create({ requestBody: { properties: { title } } })).data;
  }
  const id = spreadsheetId(first(params, 'spreadsheet_id', 'spreadsheetId', 'spreadsheet'));
  const range = first(params, 'range') || 'Sheet1';
  if (!id) throw new Error('Google Sheets action requires spreadsheet_id');
  if (action === 'GOOGLESHEETS_GET_VALUES') return (await sheets.spreadsheets.values.get({ spreadsheetId: id, range })).data;
  const values = asRows(params.values);
  if (action === 'GOOGLESHEETS_APPEND_VALUES') return (await sheets.spreadsheets.values.append({ spreadsheetId: id, range, valueInputOption: first(params, 'value_input_option', 'valueInputOption') || 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values } })).data;
  return (await sheets.spreadsheets.values.update({ spreadsheetId: id, range, valueInputOption: first(params, 'value_input_option', 'valueInputOption') || 'USER_ENTERED', requestBody: { values } })).data;
}

function supportsAction(actionName) {
  return SUPPORTED_ACTIONS.has(String(actionName || '').toUpperCase());
}

function getTools() {
  const text = description => ({ type: 'string', description });
  const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const rows = { type: 'array', items: { type: 'array', items: {} }, description: 'Rows of cell values' };
  return [
    { name: 'GMAIL_FETCH_EMAILS', description: 'Search the connected user Gmail mailbox', parameters: object({ query: text('Gmail search query'), max_results: { type: 'integer', minimum: 1, maximum: 50 } }) },
    { name: 'GMAIL_SEND_EMAIL', description: 'Send an email from the connected user Gmail account', parameters: object({ to: text('Recipient email address'), subject: text('Email subject'), body: text('Plain-text email body'), cc: text('Optional CC recipients'), bcc: text('Optional BCC recipients') }, ['to', 'subject', 'body']) },
    { name: 'GMAIL_CREATE_EMAIL_DRAFT', description: 'Create a draft in the connected user Gmail account', parameters: object({ to: text('Recipient email address'), subject: text('Email subject'), body: text('Plain-text email body') }, ['to', 'subject', 'body']) },
    { name: 'GMAIL_REPLY_TO_THREAD', description: 'Reply in an existing Gmail thread', parameters: object({ thread_id: text('Gmail thread ID'), to: text('Recipient email address'), subject: text('Reply subject'), body: text('Reply body'), in_reply_to: text('Original Message-ID header when known') }, ['thread_id', 'to', 'body']) },
    { name: 'GOOGLECALENDAR_FIND_EVENT', description: 'Search events in the connected user Google Calendar', parameters: object({ query: text('Text to search'), time_min: text('ISO date-time lower bound'), time_max: text('ISO date-time upper bound'), max_results: { type: 'integer' }, calendar_id: text('Calendar ID; defaults to primary') }) },
    { name: 'GOOGLECALENDAR_CREATE_EVENT', description: 'Create an event in the connected user Google Calendar', parameters: object({ summary: text('Event title'), start: text('ISO start date-time'), end: text('ISO end date-time'), timezone: text('IANA timezone'), description: text('Event description'), location: text('Event location'), attendees: { type: 'array', items: { type: 'string' } }, create_meet: { type: 'boolean' }, calendar_id: text('Calendar ID; defaults to primary') }, ['summary', 'start', 'end']) },
    { name: 'GOOGLECALENDAR_UPDATE_EVENT', description: 'Update an existing Google Calendar event', parameters: object({ event_id: text('Google Calendar event ID'), summary: text('New title'), start: text('ISO start date-time'), end: text('ISO end date-time'), timezone: text('IANA timezone'), description: text('New description'), location: text('New location'), attendees: { type: 'array', items: { type: 'string' } }, calendar_id: text('Calendar ID; defaults to primary') }, ['event_id']) },
    { name: 'GOOGLECALENDAR_DELETE_EVENT', description: 'Delete a Google Calendar event', parameters: object({ event_id: text('Google Calendar event ID'), calendar_id: text('Calendar ID; defaults to primary') }, ['event_id']) },
    { name: 'GOOGLECALENDAR_FIND_FREE_SLOTS', description: 'Get busy intervals for one or more Google calendars', parameters: object({ time_min: text('ISO start date-time'), time_max: text('ISO end date-time'), timezone: text('IANA timezone'), calendar_ids: { type: 'array', items: { type: 'string' } } }, ['time_min', 'time_max']) },
    { name: 'GOOGLEDRIVE_SEARCH_FILES', description: 'Search files available to SwiftCollab in Google Drive', parameters: object({ query: text('Google Drive query syntax'), max_results: { type: 'integer' } }) },
    { name: 'GOOGLEDRIVE_GET_FILE', description: 'Get Google Drive file metadata', parameters: object({ file_id: text('Google Drive file ID') }, ['file_id']) },
    { name: 'GOOGLEDRIVE_CREATE_FOLDER', description: 'Create a folder in Google Drive', parameters: object({ name: text('Folder name'), parent_ids: { type: 'array', items: { type: 'string' } } }, ['name']) },
    { name: 'GOOGLEDRIVE_CREATE_FILE', description: 'Create a text file in Google Drive', parameters: object({ name: text('File name'), content: text('File content'), mime_type: text('MIME type'), parent_ids: { type: 'array', items: { type: 'string' } } }, ['name']) },
    { name: 'GOOGLEDOCS_CREATE_DOCUMENT', description: 'Create a Google Doc', parameters: object({ title: text('Document title'), content: text('Initial document text') }, ['title']) },
    { name: 'GOOGLEDOCS_GET_DOCUMENT', description: 'Read a Google Doc', parameters: object({ document_id: text('Google Doc document ID') }, ['document_id']) },
    { name: 'GOOGLEDOCS_APPEND_TEXT', description: 'Append text to a Google Doc', parameters: object({ document_id: text('Google Doc document ID'), text: text('Text to append') }, ['document_id', 'text']) },
    { name: 'GOOGLESHEETS_CREATE_SPREADSHEET', description: 'Create a Google spreadsheet', parameters: object({ title: text('Spreadsheet title') }, ['title']) },
    { name: 'GOOGLESHEETS_GET_VALUES', description: 'Read values from a Google Sheet range', parameters: object({ spreadsheet_id: text('Spreadsheet ID or URL'), range: text('A1 notation range') }, ['spreadsheet_id', 'range']) },
    { name: 'GOOGLESHEETS_APPEND_VALUES', description: 'Append rows to a Google Sheet', parameters: object({ spreadsheet_id: text('Spreadsheet ID or URL'), range: text('A1 notation range'), values: rows }, ['spreadsheet_id', 'range', 'values']) },
    { name: 'GOOGLESHEETS_UPDATE_VALUES', description: 'Update cells in a Google Sheet range', parameters: object({ spreadsheet_id: text('Spreadsheet ID or URL'), range: text('A1 notation range'), values: rows }, ['spreadsheet_id', 'range', 'values']) },
  ];
}

module.exports = {
  SCOPES, SUPPORTED_ACTIONS, startConnection, completeConnection, status, authenticatedClient, disconnect,
  executeAction, supportsAction, getTools, readSheet, readAssignments, getBusyIntervals, createInterviewEvent,
  updateInterviewEvent, spreadsheetId, parseSheetValues, emailRaw, asRows,
};
