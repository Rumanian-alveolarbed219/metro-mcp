import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { CircularBuffer } from '../utils/buffer.js';
import { formatTimestamp, formatBytes } from '../utils/format.js';

interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  startTime: number;
  endTime?: number;
  error?: string;
  size?: number;
}

export const networkPlugin = definePlugin({
  name: 'network',
  version: '0.1.0',
  description: 'Network request tracking via CDP Network domain',

  async setup(ctx) {
    const buffer = new CircularBuffer<NetworkRequest>(200);
    const pendingRequests = new Map<string, NetworkRequest>();

    ctx.cdp.on('Network.requestWillBeSent', (params) => {
      const request: NetworkRequest = {
        id: params.requestId as string,
        url: (params.request as Record<string, unknown>)?.url as string,
        method: (params.request as Record<string, unknown>)?.method as string || 'GET',
        requestHeaders: (params.request as Record<string, unknown>)?.headers as Record<string, string>,
        startTime: Date.now(),
      };
      pendingRequests.set(request.id, request);
    });

    ctx.cdp.on('Network.responseReceived', (params) => {
      const req = pendingRequests.get(params.requestId as string);
      if (req) {
        const response = params.response as Record<string, unknown>;
        req.status = response.status as number;
        req.statusText = response.statusText as string;
        req.responseHeaders = response.headers as Record<string, string>;
      }
    });

    ctx.cdp.on('Network.loadingFinished', (params) => {
      const req = pendingRequests.get(params.requestId as string);
      if (req) {
        req.endTime = Date.now();
        req.size = params.encodedDataLength as number;
        pendingRequests.delete(req.id);
        buffer.push(req);
      }
    });

    ctx.cdp.on('Network.loadingFailed', (params) => {
      const req = pendingRequests.get(params.requestId as string);
      if (req) {
        req.endTime = Date.now();
        req.error = params.errorText as string;
        pendingRequests.delete(req.id);
        buffer.push(req);
      }
    });

    // When the CDP connection drops, flush any in-flight requests to the buffer so they
    // are visible rather than silently lost.
    ctx.cdp.on('disconnected', () => {
      const now = Date.now();
      for (const [, req] of pendingRequests) {
        req.endTime = now;
        req.error = 'Connection lost';
        buffer.push(req);
      }
      pendingRequests.clear();
    });

    ctx.registerTool('get_network_requests', {
      description: 'Get recent network requests from the React Native app.',
      parameters: z.object({
        limit: z.number().default(50).describe('Maximum number of requests to return'),
        summary: z.boolean().default(false).describe('Return summary with counts'),
        compact: z.boolean().default(false).describe('Return compact single-line format'),
      }),
      handler: async ({ limit, summary, compact: isCompact }) => {
        const requests = buffer.getAll();

        if (summary) {
          const total = requests.length;
          const errors = requests.filter((r) => r.error || (r.status && r.status >= 400)).length;
          const avgTime = requests
            .filter((r) => r.endTime)
            .reduce((sum, r) => sum + (r.endTime! - r.startTime), 0) / (requests.length || 1);
          return `${total} requests, ${errors} errors, avg response time: ${Math.round(avgTime)}ms`;
        }

        const result = requests.slice(-limit);
        if (isCompact) {
          return result
            .map((r) => {
              const duration = r.endTime ? `${r.endTime - r.startTime}ms` : 'pending';
              const status = r.error ? `ERR: ${r.error}` : `${r.status || '???'}`;
              return `${r.method} ${r.url} → ${status} (${duration})`;
            })
            .join('\n');
        }

        return result.map((r) => ({
          method: r.method,
          url: r.url,
          status: r.status,
          duration: r.endTime ? `${r.endTime - r.startTime}ms` : 'pending',
          size: r.size ? formatBytes(r.size) : undefined,
          error: r.error,
          time: formatTimestamp(r.startTime),
        }));
      },
    });

    ctx.registerTool('get_request_details', {
      description: 'Get full details of a specific network request including headers and body.',
      parameters: z.object({
        url: z.string().describe('URL or partial URL to find the request'),
        index: z.number().default(-1).describe('Index of the request if multiple match (-1 for last)'),
      }),
      handler: async ({ url, index }) => {
        const matches = buffer.filter((r) => r.url.includes(url));
        if (matches.length === 0) return `No requests found matching "${url}"`;
        const req = index === -1 ? matches[matches.length - 1] : matches[index];
        if (!req) return `Request index ${index} out of range (${matches.length} matches)`;
        return req;
      },
    });

    ctx.registerTool('search_network', {
      description: 'Search network requests by URL pattern, method, or status code.',
      parameters: z.object({
        urlPattern: z.string().optional().describe('URL substring or regex pattern'),
        method: z.string().optional().describe('HTTP method filter'),
        statusCode: z.number().optional().describe('HTTP status code filter'),
        errorsOnly: z.boolean().default(false).describe('Show only failed requests'),
      }),
      handler: async ({ urlPattern, method, statusCode, errorsOnly }) => {
        let results = buffer.getAll();
        if (urlPattern) {
          const regex = new RegExp(urlPattern, 'i');
          results = results.filter((r) => regex.test(r.url));
        }
        if (method) results = results.filter((r) => r.method.toUpperCase() === method.toUpperCase());
        if (statusCode) results = results.filter((r) => r.status === statusCode);
        if (errorsOnly) results = results.filter((r) => r.error || (r.status && r.status >= 400));
        return results.map((r) => ({
          method: r.method,
          url: r.url,
          status: r.status,
          error: r.error,
          duration: r.endTime ? `${r.endTime - r.startTime}ms` : 'pending',
        }));
      },
    });

    // ── Network mocking via CDP Fetch domain ─────────────────────────────────

    interface MockEntry {
      urlPattern: string;
      type: 'mock' | 'block';
      statusCode?: number;
      responseBody?: string;
      responseHeaders?: Record<string, string>;
    }

    const mocks: MockEntry[] = [];
    let fetchInterceptActive = false;

    function urlMatchesMock(url: string, pattern: string): boolean {
      // Exact substring or glob (* wildcard)
      if (pattern.includes('*')) {
        const regexStr = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(regexStr, 'i').test(url);
      }
      return url.includes(pattern);
    }

    async function ensureFetchInterceptEnabled(): Promise<void> {
      if (fetchInterceptActive) return;
      // Build Fetch domain patterns from current mocks
      await ctx.cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });
      fetchInterceptActive = true;
    }

    async function disableFetchIntercept(): Promise<void> {
      if (!fetchInterceptActive) return;
      await ctx.cdp.send('Fetch.disable').catch(() => {});
      fetchInterceptActive = false;
    }

    ctx.cdp.on('Fetch.requestPaused', async (params: Record<string, unknown>) => {
      const requestId = params.requestId as string;
      const url = (params.request as Record<string, unknown>)?.url as string ?? '';

      const match = mocks.find((m) => urlMatchesMock(url, m.urlPattern));
      if (!match) {
        // No mock — pass through
        ctx.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
        return;
      }

      if (match.type === 'block') {
        ctx.cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
        return;
      }

      // Fulfill with mock response
      const headers = Object.entries(match.responseHeaders ?? { 'Content-Type': 'application/json' })
        .map(([name, value]) => ({ name, value }));
      const body = match.responseBody ?? '';
      ctx.cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: match.statusCode ?? 200,
        responseHeaders: headers,
        body: Buffer.from(body).toString('base64'),
      }).catch(() => {});
    });

    ctx.registerTool('mock_network_request', {
      description:
        'Intercept network requests matching a URL pattern and return a mock response. ' +
        'Works for all requests (fetch, XHR) without any app-side changes — uses the CDP Fetch domain. ' +
        'Useful for testing specific API responses, error states, or slow network conditions.',
      parameters: z.object({
        urlPattern: z.string()
          .describe('URL substring or glob pattern to match (e.g. "/api/users", "*.example.com/auth*")'),
        statusCode: z.number().int().min(100).max(599).default(200)
          .describe('HTTP response status code (default 200)'),
        responseBody: z.string().default('')
          .describe('Response body string (e.g. JSON payload)'),
        responseHeaders: z.record(z.string()).optional()
          .describe('Response headers (default: {"Content-Type": "application/json"})'),
      }),
      handler: async ({ urlPattern, statusCode, responseBody, responseHeaders }) => {
        // Remove any existing mock for this pattern
        const idx = mocks.findIndex((m) => m.urlPattern === urlPattern);
        if (idx !== -1) mocks.splice(idx, 1);
        mocks.push({ urlPattern, type: 'mock', statusCode, responseBody, responseHeaders });
        await ensureFetchInterceptEnabled();
        return { mocked: urlPattern, statusCode, activeCount: mocks.length };
      },
    });

    ctx.registerTool('block_network_request', {
      description:
        'Block all network requests matching a URL pattern, making them fail with a network error. ' +
        'Useful for testing offline behavior, error handling, or timeout scenarios.',
      parameters: z.object({
        urlPattern: z.string()
          .describe('URL substring or glob pattern to block (e.g. "/api/upload", "analytics.*")'),
      }),
      handler: async ({ urlPattern }) => {
        const idx = mocks.findIndex((m) => m.urlPattern === urlPattern);
        if (idx !== -1) mocks.splice(idx, 1);
        mocks.push({ urlPattern, type: 'block' });
        await ensureFetchInterceptEnabled();
        return { blocked: urlPattern, activeCount: mocks.length };
      },
    });

    ctx.registerTool('clear_network_mocks', {
      description:
        'Remove all active network mocks and blocks, restoring normal network behaviour. ' +
        'Disables the CDP Fetch interceptor so requests pass through without interception.',
      parameters: z.object({}),
      handler: async () => {
        const count = mocks.length;
        mocks.length = 0;
        await disableFetchIntercept();
        return { cleared: count };
      },
    });

    ctx.registerTool('get_active_mocks', {
      description: 'List all currently registered network mocks and blocks.',
      parameters: z.object({}),
      handler: async () => {
        if (mocks.length === 0) return 'No active mocks or blocks.';
        return mocks.map((m) => ({
          urlPattern: m.urlPattern,
          type: m.type,
          ...(m.type === 'mock' ? { statusCode: m.statusCode, hasBody: !!(m.responseBody) } : {}),
        }));
      },
    });

    ctx.registerResource('metro://network', {
      name: 'Network Requests',
      description: 'Recent network requests from the React Native app',
      handler: async () => {
        const requests = buffer.getLast(20);
        return JSON.stringify(
          requests.map((r) => ({
            method: r.method,
            url: r.url,
            status: r.status,
            duration: r.endTime ? `${r.endTime - r.startTime}ms` : 'pending',
          })),
          null,
          2
        );
      },
    });
  },
});
