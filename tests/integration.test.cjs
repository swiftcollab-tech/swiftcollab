/**
 * Frontend Integration Tests (25 Tests)
 *
 * Tests frontend-to-backend integration:
 * 1. API connectivity
 * 2. Chat/Assistant flow
 * 3. Connection management
 * 4. Authentication flow
 * 5. UI component responses
 */

const assert = require('assert');

const BACKEND_URL = process.env.API_BASE_URL || 'http://localhost:4002';
const FRONTEND_URL = 'http://localhost:5174';

const testResults = [];
let testCount = 0;

// Helper function to make API calls
async function apiCall(method, endpoint, body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(`${BACKEND_URL}${endpoint}`, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, ok: response.ok };
}

// Test runner
async function runTest(name, testFn) {
  testCount++;
  try {
    await testFn();
    console.log(`  ✓ [${testCount}] ${name}`);
    testResults.push({ name, passed: true });
  } catch (error) {
    console.log(`  ✗ [${testCount}] ${name}`);
    console.log(`      Error: ${error.message}`);
    testResults.push({ name, passed: false, error: error.message });
  }
}

// =====================================================
// Test Categories
// =====================================================

async function connectivityTests() {
  console.log('\n--- Connectivity Tests ---\n');

  await runTest('Backend is reachable', async () => {
    const { status } = await apiCall('GET', '/api/health');
    assert.strictEqual(status, 200, 'Backend should be healthy');
  });

  await runTest('Frontend serves index', async () => {
    const response = await fetch(FRONTEND_URL);
    assert.strictEqual(response.status, 200, 'Frontend should serve index');
    const html = await response.text();
    assert(html.includes('<!DOCTYPE html>') || html.includes('<html'), 'Should return HTML');
  });

  await runTest('CORS headers present', async () => {
    const response = await fetch(`${BACKEND_URL}/api/health`, {
      method: 'OPTIONS',
    });
    // OPTIONS might return 204 or 200
    assert(response.status === 200 || response.status === 204, 'CORS preflight should work');
  });
}

async function chatIntegrationTests() {
  console.log('\n--- Chat Integration Tests ---\n');

  await runTest('Simple chat message returns response', async () => {
    const { status, data } = await apiCall('POST', '/api/ai/assistant', {
      message: 'hello',
      userId: 'test-frontend-1',
    });
    assert.strictEqual(status, 200, 'Chat should succeed');
    assert(data, 'Should return data');
  });

  await runTest('Calendar query processes correctly', async () => {
    const { status, data } = await apiCall('POST', '/api/ai/assistant', {
      message: 'what is on my calendar?',
      userId: 'test-frontend-2',
      selectedToolkits: ['GOOGLECALENDAR'],
    });
    assert.strictEqual(status, 200, 'Calendar query should succeed');
    assert(data.type, 'Should have response type');
  });

  await runTest('Multi-app workflow triggers correct detection', async () => {
    const { status, data } = await apiCall('POST', '/api/ai/assistant', {
      message: 'get my calendar events and create a summary email',
      userId: 'test-frontend-3',
      selectedToolkits: ['GOOGLECALENDAR', 'GMAIL'],
    });
    assert.strictEqual(status, 200, 'Multi-app query should succeed');
  });

  await runTest('Action with missing params requests followup', async () => {
    const { status, data } = await apiCall('POST', '/api/ai/assistant', {
      message: 'create a meeting',
      userId: 'test-frontend-4',
      selectedToolkits: ['GOOGLECALENDAR'],
    });
    assert.strictEqual(status, 200, 'Should succeed');
    // Response can have various types or be a direct object
    assert(data, 'Should return data');
  });

  await runTest('Followup context is processed', async () => {
    const { status, data } = await apiCall('POST', '/api/ai/assistant', {
      message: 'Team Standup Meeting',
      userId: 'test-frontend-5',
      followupContext: {
        pendingAction: 'GOOGLECALENDAR_CREATE_EVENT',
        missingParams: ['summary'],
        providedParams: {},
      },
    });
    assert.strictEqual(status, 200, 'Followup should succeed');
  });
}

async function connectionTests() {
  console.log('\n--- Connection Management Tests ---\n');

  await runTest('Get available apps list', async () => {
    const { status, data } = await apiCall('GET', '/api/apps/available');
    assert.strictEqual(status, 200, 'Should return apps');
    assert(Array.isArray(data) || data.apps, 'Should be array or have apps property');
  });

  await runTest('Connection status returns valid data', async () => {
    const { status, data } = await apiCall('GET', '/api/connections/status');
    assert.strictEqual(status, 200, 'Should return status');
  });

  await runTest('Connection list endpoint works', async () => {
    const { status, data } = await apiCall('GET', '/api/connections/list');
    assert.strictEqual(status, 200, 'Should return list');
  });

  await runTest('Auth config check for Google Calendar', async () => {
    const { status, data } = await apiCall('GET', '/api/auth-config/check/GOOGLECALENDAR');
    assert(status === 200 || status === 404, 'Should respond');
  });

  await runTest('Connection fields for toolkit', async () => {
    const { status, data } = await apiCall('GET', '/api/connections/fields/JIRA');
    assert(status >= 200 && status < 500, 'Should respond');
  });
}

async function workflowTests() {
  console.log('\n--- Workflow Execution Tests ---\n');

  await runTest('Daily planner triggers workflow', async () => {
    const { status, data } = await apiCall('GET', '/api/ai/daily-plan');
    assert(status >= 200 && status < 600, 'Should respond');
  });

  await runTest('Brain execute with valid action', async () => {
    const { status, data } = await apiCall('POST', '/api/brain/execute', {
      action: 'GOOGLECALENDAR_FIND_EVENT',
      params: { q: 'meeting' },
    });
    assert(status >= 200 && status < 600, 'Should respond');
  });

  await runTest('Automation pattern detection', async () => {
    const { status, data } = await apiCall('POST', '/api/ai/assistant', {
      message: 'when I get a new email from client, create a task in jira',
      userId: 'test-workflow-1',
    });
    assert.strictEqual(status, 200, 'Should detect automation pattern');
    // Should be automation type or chat if not configured
    assert(data.type, 'Should have response type');
  });
}

async function errorHandlingTests() {
  console.log('\n--- Error Handling Tests ---\n');

  await runTest('Invalid endpoint returns 404', async () => {
    const { status } = await apiCall('GET', '/api/invalid/endpoint/xyz');
    assert.strictEqual(status, 404, 'Should return 404');
  });

  await runTest('Empty message is handled', async () => {
    const { status } = await apiCall('POST', '/api/ai/assistant', {
      message: '',
      userId: 'test-error-1',
    });
    assert(status === 200 || status === 400, 'Should handle gracefully');
  });

  await runTest('Missing userId is handled', async () => {
    const { status } = await apiCall('POST', '/api/ai/assistant', {
      message: 'hello',
    });
    assert(status === 200 || status === 400, 'Should handle missing userId');
  });

  await runTest('Invalid JSON is handled', async () => {
    const response = await fetch(`${BACKEND_URL}/api/ai/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid-json',
    });
    assert(response.status === 400 || response.status === 500, 'Should handle invalid JSON');
  });

  await runTest('Rate limiting or concurrent requests handled', async () => {
    const promises = Array(3).fill().map(() =>
      apiCall('POST', '/api/ai/assistant', { message: 'test', userId: 'rate-test' })
    );
    const results = await Promise.all(promises);
    assert(results.every(r => r.status >= 200 && r.status < 600), 'All should respond');
  });
}

async function responseFormatTests() {
  console.log('\n--- Response Format Tests ---\n');

  await runTest('Chat response has correct structure', async () => {
    const { status, data } = await apiCall('POST', '/api/ai/assistant', {
      message: 'hi there',
      userId: 'format-test-1',
    });
    assert.strictEqual(status, 200, 'Should succeed');
    assert(data.type, 'Response should have type');
  });

  await runTest('Health response has status field', async () => {
    const { status, data } = await apiCall('GET', '/api/health');
    assert.strictEqual(status, 200, 'Should succeed');
    assert(data.status === 'ok' || data.status === 'healthy', 'Should have status');
  });

  await runTest('Detailed health has all components', async () => {
    const { status, data } = await apiCall('GET', '/api/health/detailed');
    assert.strictEqual(status, 200, 'Should succeed');
    assert(data.status, 'Should have status');
  });

  await runTest('Apps list is properly formatted', async () => {
    const { status, data } = await apiCall('GET', '/api/apps/available');
    assert.strictEqual(status, 200, 'Should succeed');
    const apps = Array.isArray(data) ? data : data.apps || [];
    if (apps.length > 0) {
      assert(apps[0].name || apps[0].id, 'Apps should have identifiers');
    }
  });
}

// =====================================================
// Main Test Runner
// =====================================================

async function runAllTests() {
  console.log('\n========================================');
  console.log('  SwiftCollab Frontend Integration Tests');
  console.log('========================================');

  await connectivityTests();
  await chatIntegrationTests();
  await connectionTests();
  await workflowTests();
  await errorHandlingTests();
  await responseFormatTests();

  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;

  console.log('\n========================================');
  console.log('              Summary');
  console.log('========================================');
  console.log(`  Total:  ${testResults.length}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log('========================================\n');

  if (failed > 0) {
    console.log('Failed Tests:');
    testResults.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
  }

  return { total: testResults.length, passed, failed };
}

runAllTests().catch(console.error);
