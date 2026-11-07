const assert = require('node:assert/strict');
const test = require('node:test');
const { createLLMService, normalizeApiKey } = require('../services/llmService');

test('normalizes an accidentally pasted Bearer prefix and whitespace', () => {
  assert.equal(normalizeApiKey('  Bearer sk-test\r\n'), 'sk-test');
});

test('sends chat messages to Ollama and returns assistant content', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'test-model');
    assert.equal(request.stream, false);
    assert.deepEqual(request.messages, [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ]);
    return {
      ok: true,
      json: async () => ({ message: { content: 'Hi from Ollama' } }),
    };
  };

  const service = createLLMService({
    provider: 'ollama',
    ollamaModel: 'test-model',
  });
  assert.equal(await service.complete('You are helpful.', 'Hello', 0.2), 'Hi from Ollama');
});

test('uses one user message for legacy prompt-only calls', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.messages, [{ role: 'user', content: 'Return JSON only.' }]);
    return { ok: true, json: async () => ({ message: { content: '{}' } }) };
  };

  const service = createLLMService({ provider: 'ollama' });
  assert.equal(await service.complete('Return JSON only.', '', 0), '{}');
});

test('keeps OpenAI available as a configurable provider', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer sk-test');
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'test-openai-model');
    return { ok: true, json: async () => ({ output_text: 'OpenAI response' }) };
  };

  const service = createLLMService({
    provider: 'openai',
    openAIKey: 'Bearer sk-test',
    openAIModel: 'test-openai-model',
  });
  assert.equal(await service.complete('System', 'User', 0.1), 'OpenAI response');
});

test('supports future OpenAI-compatible hosted model APIs', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (url, options) => {
    assert.equal(url, 'https://model.example/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer hosted-key');
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'swiftcollab-model');
    assert.deepEqual(request.messages, [
      { role: 'system', content: 'Route the request.' },
      { role: 'user', content: 'Create a task.' },
    ]);
    assert.deepEqual(request.response_format, { type: 'json_object' });
    assert.equal(request.provider, undefined);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Hosted response' } }] }),
    };
  };

  const service = createLLMService({
    provider: 'openai-compatible',
    compatibleBaseUrl: 'https://model.example/v1/',
    compatibleApiKey: 'hosted-key',
    compatibleModel: 'swiftcollab-model',
  });
  assert.equal(
    await service.complete('Route the request.', 'Create a task.', 0),
    'Hosted response'
  );
});

test('requires JSON-capable OpenRouter endpoints for deterministic orchestration calls', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.response_format, { type: 'json_object' });
    assert.deepEqual(request.provider, { require_parameters: true });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"selectedTools":[]}' } }] }),
    };
  };

  const service = createLLMService({
    provider: 'openai-compatible',
    compatibleBaseUrl: 'https://openrouter.ai/api/v1',
    compatibleApiKey: 'openrouter-key',
    compatibleModel: 'openrouter/free',
  });

  assert.equal(
    await service.complete('Return JSON.', 'Create a Jira story.', 0),
    '{"selectedTools":[]}'
  );
});

test('retries transient hosted-provider JSON validation failures', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;

  global.fetch = async (_url, options) => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          error: { code: 'json_validate_failed', message: 'Failed to validate JSON' },
        }),
      };
    }

    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /RETRY REQUIREMENT/);
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"tools":[]}' } }] }),
    };
  };

  const service = createLLMService({
    provider: 'openai-compatible',
    compatibleBaseUrl: 'https://api.groq.com/openai/v1',
    compatibleApiKey: 'groq-key',
    compatibleModel: 'openai/gpt-oss-20b',
  });

  assert.equal(await service.complete('Return JSON only', 'plan this request', 0), '{"tools":[]}');
  assert.equal(calls, 2);
});

test('waits and retries short Groq token-per-minute limits', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          error: {
            message: 'Rate limit reached for model on tokens per minute (TPM). Please try again in 0.001s.',
            type: 'tokens',
            code: 'rate_limit_exceeded',
          },
        }),
      };
    }

    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"tools":[]}' } }] }),
    };
  };

  const service = createLLMService({
    provider: 'openai-compatible',
    compatibleBaseUrl: 'https://api.groq.com/openai/v1',
    compatibleApiKey: 'groq-key',
    compatibleModel: 'openai/gpt-oss-20b',
  });

  assert.equal(await service.complete('Return JSON only', 'plan this request', 0), '{"tools":[]}');
  assert.equal(calls, 2);
});

test('does not retry non-transient hosted-provider quota limits', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 429,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        error: { message: 'Daily quota exhausted', type: 'quota' },
      }),
    };
  };

  const service = createLLMService({
    provider: 'openai-compatible',
    compatibleBaseUrl: 'https://api.groq.com/openai/v1',
    compatibleApiKey: 'groq-key',
    compatibleModel: 'openai/gpt-oss-20b',
  });

  await assert.rejects(
    service.complete('Return JSON only', 'plan this request', 0),
    /Hosted LLM API error: 429/
  );
  assert.equal(calls, 1);
});
