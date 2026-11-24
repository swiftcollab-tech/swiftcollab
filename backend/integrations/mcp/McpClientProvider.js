const dns = require('node:dns').promises;
const net = require('node:net');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');

const DEFAULT_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || 30000);

function isPrivateIp(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] === 0;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb');
  }
  return true;
}

function normalizeMcpEndpoint(input) {
  const raw = String(input || '').trim().replace(/&#x2F;|&#47;/gi, '/').replace(/&amp;/gi, '&');
  if (!raw) throw new Error('ERPNext URL is required');
  const url = new URL(raw);
  if (url.username || url.password) throw new Error('Credentials must not be included in the ERPNext URL');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/api/v2/mcp')) {
    url.pathname = `${url.pathname}/api/v2/mcp`.replace(/\/{2,}/g, '/');
  }
  return url.toString().replace(/\/$/, '');
}

async function validateRemoteMcpEndpoint(input) {
  const endpoint = normalizeMcpEndpoint(input);
  const url = new URL(endpoint);
  const allowPrivate = String(process.env.MCP_ALLOW_PRIVATE_NETWORKS || '').toLowerCase() === 'true';
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new Error('MCP endpoints must use HTTPS');
  }
  if (!allowPrivate) {
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) {
      throw new Error('Private or local MCP endpoints are not allowed');
    }
  }
  return endpoint;
}

function tokenAuthorization(apiKey, apiSecret) {
  if (!apiKey || !apiSecret) throw new Error('ERPNext API key and API secret are required');
  return `token ${String(apiKey).trim()}:${String(apiSecret).trim()}`;
}

class McpClientProvider {
  constructor({ clientName = 'swiftcollab', clientVersion = '1.0.0', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.timeoutMs = timeoutMs;
  }

  async _withClient({ serverUrl, apiKey, apiSecret }, operation) {
    const endpoint = await validateRemoteMcpEndpoint(serverUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const client = new Client({ name: this.clientName, version: this.clientVersion });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: {
        headers: {
          Authorization: tokenAuthorization(apiKey, apiSecret),
          Accept: 'application/json, text/event-stream',
        },
        redirect: 'error',
        signal: controller.signal,
      },
    });

    try {
      await client.connect(transport);
      return await operation(client, endpoint);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`MCP request timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
      await client.close().catch(() => {});
    }
  }

  async listTools(credentials) {
    return this._withClient(credentials, async (client, endpoint) => {
      const result = await client.listTools();
      return { endpoint, tools: result.tools || [] };
    });
  }

  async callTool(credentials, name, args = {}) {
    return this._withClient(credentials, async client => {
      const result = await client.callTool({ name, arguments: args || {} });
      const text = (result.content || [])
        .filter(item => item?.type === 'text' && typeof item.text === 'string')
        .map(item => item.text)
        .join('\n');
      let parsedText = text;
      try { parsedText = text ? JSON.parse(text) : null; } catch (_) {}
      return {
        success: !result.isError,
        data: result.structuredContent ?? parsedText ?? result.content,
        content: result.content || [],
        error: result.isError ? (text || `MCP tool ${name} failed`) : null,
      };
    });
  }
}

module.exports = {
  McpClientProvider,
  normalizeMcpEndpoint,
  validateRemoteMcpEndpoint,
  isPrivateIp,
};
