const assert = require('assert');

process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64');

const { encrypt, decrypt } = require('../services/credentialEncryptionService');
const { SCOPES, spreadsheetId, normalizeSheetRange, parseSheetValues, emailRaw, asRows } = require('../services/googleWorkspaceService');

const value = { refresh_token: 'test-refresh-token', access_token: 'test-access-token' };
const encrypted = encrypt(value);
assert.notStrictEqual(encrypted, JSON.stringify(value));
assert.deepStrictEqual(decrypt(encrypted), value);
assert.strictEqual(spreadsheetId('https://docs.google.com/spreadsheets/d/abc-123_DEF/edit#gid=0'), 'abc-123_DEF');
assert.strictEqual(spreadsheetId('https:&#x2F;&#x2F;docs.google.com&#x2F;spreadsheets&#x2F;d&#x2F;abc-123_DEF&#x2F;edit'), 'abc-123_DEF');
assert.strictEqual(spreadsheetId('abc-123_DEF'), 'abc-123_DEF');
assert.strictEqual(normalizeSheetRange('first column'), 'Sheet1!A:A');
assert.strictEqual(normalizeSheetRange('column c'), 'Sheet1!C:C');
const parsed = parseSheetValues([
  ['Student Name', 'Student Email', 'Mentor Email', 'Topic', 'Status'],
  ['Asha', 'asha@example.test', 'mentor@example.test', 'Practice interview', 'Ready to schedule'],
]);
assert.strictEqual(parsed.rowCount, 1);
assert.strictEqual(parsed.assignments[0].candidate_name, 'Asha');
assert.strictEqual(parsed.assignments[0].interviewer_email, 'mentor@example.test');
assert.strictEqual(parsed.assignments[0].preferred_start, '');
assert.deepStrictEqual(parsed.warnings, []);
assert.ok(SCOPES.includes('https://www.googleapis.com/auth/gmail.send'));
assert.ok(SCOPES.includes('https://www.googleapis.com/auth/calendar.events'));
assert.ok(SCOPES.includes('https://www.googleapis.com/auth/drive.file'));
assert.ok(SCOPES.includes('https://www.googleapis.com/auth/documents'));
assert.ok(SCOPES.includes('https://www.googleapis.com/auth/spreadsheets'));
assert.deepStrictEqual(asRows(['A', 'B']), [['A', 'B']]);
assert.deepStrictEqual(asRows('[["A","B"]]'), [['A', 'B']]);
const rawEmail = Buffer.from(emailRaw({ to: 'person@example.test', subject: 'Hello', body: 'World' }), 'base64url').toString('utf8');
assert.match(rawEmail, /To: person@example\.test/);
assert.match(rawEmail, /Subject: Hello/);

console.log('Google Workspace encryption and Sheet ID tests passed');
