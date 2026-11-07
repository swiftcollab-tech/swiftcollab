const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

function cleanBaseUrl(value) {
  return String(value || DEFAULT_OLLAMA_URL).trim().replace(/\/+$/, '');
}

function normalizeApiKey(value) {
  return String(value || '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/\s+/g, '');
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal?.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

function createLLMService(config = {}) {
  const provider = String(config.provider || process.env.LLM_PROVIDER || 'openai').trim().toLowerCase();
  const openAIKey = normalizeApiKey(config.openAIKey ?? process.env.OPENAI_API_KEY);
  const openAIModel = config.openAIModel || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const ollamaBaseUrl = cleanBaseUrl(config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL);
  const ollamaModel = config.ollamaModel || process.env.OLLAMA_MODEL || 'qwen2.5-coder:1.5b';
  const compatibleBaseUrl = String(
    config.compatibleBaseUrl || process.env.LLM_API_BASE_URL || ''
  ).trim().replace(/\/+$/, '');
  const compatibleApiKey = normalizeApiKey(config.compatibleApiKey ?? process.env.LLM_API_KEY);
  const compatibleModel = config.compatibleModel || process.env.LLM_MODEL || '';
  const timeoutMs = Number(config.timeoutMs || process.env.LLM_TIMEOUT_MS || 120000);

  if (!['openai', 'ollama', 'openai-compatible'].includes(provider)) {
    throw new Error(`Unsupported LLM_PROVIDER "${provider}". Use "openai", "ollama", or "openai-compatible".`);
  }

  async function callOpenAI(systemPrompt, userPrompt, temperature) {
    if (!openAIKey) throw new Error('OPENAI_API_KEY not configured');

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAIKey}`,
      },
      body: JSON.stringify({
        model: openAIModel,
        instructions: String(systemPrompt || ''),
        input: String(userPrompt || ''),
        temperature,
      }),
      signal: createTimeoutSignal(timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`OpenAI API error: ${response.status} - ${detail}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    return data.output_text || '';
  }

  async function callOllama(systemPrompt, userPrompt, temperature) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(userPrompt || systemPrompt || '') });

    // Avoid sending the same content twice when older orchestration components
    // pass their complete prompt as the first argument and leave userPrompt empty.
    if (!userPrompt && systemPrompt) messages.splice(0, 1);

    let response;
    try {
      response = await fetch(`${ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          messages,
          stream: false,
          options: { temperature },
          keep_alive: process.env.OLLAMA_KEEP_ALIVE || '10m',
        }),
        signal: createTimeoutSignal(timeoutMs),
      });
    } catch (error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        throw new Error(`Ollama timed out after ${timeoutMs}ms. The model may still be loading.`);
      }
      throw new Error(`Cannot reach Ollama at ${ollamaBaseUrl}. Start Ollama and try again. (${error.message})`);
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${detail}`);
    }

    const data = await response.json();
    return data.message?.content || '';
  }

  async function callOpenAICompatible(systemPrompt, userPrompt, temperature) {
    if (!compatibleBaseUrl || !compatibleApiKey || !compatibleModel) {
      throw new Error('LLM_API_BASE_URL, LLM_API_KEY, and LLM_MODEL must be configured');
    }

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
    messages.push({ role: 'user', content: String(userPrompt || systemPrompt || '') });
    if (!userPrompt && systemPrompt) messages.splice(0, 1);

    const requestBody = {
      model: compatibleModel,
      messages,
      temperature,
      stream: false,
    };

    // Routing, slot filling and action planning use temperature 0 and expect a
    // JSON object. Declaring that requirement lets providers such as
    // OpenRouter select a compatible model and prevents model-specific tool
    // call tokens from leaking into the response text.
    if (temperature === 0) {
      requestBody.response_format = { type: 'json_object' };
      if (/openrouter\.ai/i.test(compatibleBaseUrl)) {
        requestBody.provider = { require_parameters: true };
      }
    }

    const maxAttempts = temperature === 0 ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptBody = { ...requestBody };
      if (attempt > 1) {
        attemptBody.messages = messages.map((message, index) => {
          if (index !== 0 || message.role !== 'system') return message;
          return {
            ...message,
            content: `${message.content}\n\nRETRY REQUIREMENT: Return exactly one syntactically valid JSON object. Do not use markdown, tool-call tags, comments, or any text outside the JSON object.`,
          };
        });
      }

      const response = await fetch(`${compatibleBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${compatibleApiKey}`,
        },
        body: JSON.stringify(attemptBody),
        signal: createTimeoutSignal(timeoutMs),
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
      }

      const detail = await response.text();
      const isJsonValidationFailure =
        response.status === 400 &&
        /json_validate_failed|failed to validate json|failed_generation/i.test(detail);
      if (isJsonValidationFailure && attempt < maxAttempts) {
        console.warn(`[LLM] Hosted provider JSON validation failed; retrying (${attempt}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
        continue;
      }

      const error = new Error(`Hosted LLM API error: ${response.status} - ${detail}`);
      error.status = response.status;
      throw error;
    }

    throw new Error('Hosted LLM API failed after JSON validation retries');
  }

  async function complete(systemPrompt = '', userPrompt = '', temperature = 0.1) {
    const normalizedTemperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.1;
    if (provider === 'ollama') {
      return callOllama(systemPrompt, userPrompt, normalizedTemperature);
    }
    if (provider === 'openai-compatible') {
      return callOpenAICompatible(systemPrompt, userPrompt, normalizedTemperature);
    }
    return callOpenAI(systemPrompt, userPrompt, normalizedTemperature);
  }

  async function checkConnection() {
    if (provider === 'openai') {
      return { provider, model: openAIModel, configured: Boolean(openAIKey) };
    }
    if (provider === 'openai-compatible') {
      return {
        provider,
        model: compatibleModel,
        configured: Boolean(compatibleBaseUrl && compatibleApiKey && compatibleModel),
      };
    }

    try {
      const response = await fetch(`${ollamaBaseUrl}/api/tags`, {
        signal: createTimeoutSignal(Math.min(timeoutMs, 5000)),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const models = (data.models || []).map(item => item.name);
      return {
        provider,
        model: ollamaModel,
        configured: true,
        reachable: true,
        modelInstalled: models.includes(ollamaModel),
      };
    } catch (error) {
      return {
        provider,
        model: ollamaModel,
        configured: true,
        reachable: false,
        modelInstalled: false,
        error: error.message,
      };
    }
  }

  return {
    provider,
    model: provider === 'ollama'
      ? ollamaModel
      : provider === 'openai-compatible'
        ? compatibleModel
        : openAIModel,
    baseUrl: provider === 'ollama'
      ? ollamaBaseUrl
      : provider === 'openai-compatible'
        ? compatibleBaseUrl
        : null,
    configured: provider === 'ollama' ||
      (provider === 'openai-compatible'
        ? Boolean(compatibleBaseUrl && compatibleApiKey && compatibleModel)
        : Boolean(openAIKey)),
    complete,
    checkConnection,
  };
}

module.exports = { createLLMService, normalizeApiKey };
