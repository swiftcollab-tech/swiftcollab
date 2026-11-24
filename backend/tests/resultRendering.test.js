const test = require('node:test');
const assert = require('node:assert/strict');
const AssistantComposer = require('../orchestration/AssistantComposer');

async function render(action, providerData) {
  const composer = new AssistantComposer();
  return composer.composeExecutionDeterministic({
    executionResult: {
      results: [{
        action,
        success: true,
        data: { successful: true, data: providerData, error: null },
      }],
    },
    timezone: 'Asia/Calcutta',
  });
}

test('ERPNext MCP read results are displayed instead of only a completion status', async () => {
  const output = await render('FRAPPE_SEARCH_DOCTYPES', {
    doctypes: [
      { name: 'Customer', module: 'Selling' },
      { name: 'Customer Group', module: 'Selling' },
    ],
  });
  assert.match(output, /returned 2 results/);
  assert.match(output, /Customer/);
  assert.match(output, /Customer Group/);
});

test('Google Sheets values are rendered as bounded rows', async () => {
  const output = await render('GOOGLESHEETS_GET_VALUES', {
    values: [
      ['Email', 'Status'],
      ['person@example.com', 'Scheduled'],
    ],
  });
  assert.match(output, /returned 2 results/);
  assert.match(output, /person@example\.com/);
  assert.match(output, /Scheduled/);
});

test('Gmail alternative result envelopes still display messages', async () => {
  const output = await render('GMAIL_FETCH_EMAILS', {
    messages: [],
    data: {
      results: [{ subject: 'Welcome', from: 'admin@swiftcollab.tech' }],
    },
  });
  assert.match(output, /Welcome/);
  assert.match(output, /admin@swiftcollab\.tech/);
});

test('generic read rendering redacts secret-bearing fields', async () => {
  const output = await render('FRAPPE_GET_DOCUMENT', {
    name: 'CUST-0001',
    api_secret: 'must-not-render',
    status: 'Active',
  });
  assert.match(output, /CUST-0001/);
  assert.match(output, /Active/);
  assert.doesNotMatch(output, /must-not-render/);
});
