import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
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
    // Mocks persist in memory until removed/cleared. Interception can be paused
    // and resumed without losing definitions. Mocks can be saved to / loaded from
    // a JSON file in the project so they survive MCP server restarts.

    interface MockEntry {
      urlPattern: string;
      type: 'mock' | 'block';
      statusCode?: number;
      responseBody?: string;
      responseHeaders?: Record<string, string>;
    }

    interface MockFile {
      version: 1;
      mocks: MockEntry[];
    }

    const mocks: MockEntry[] = [];
    let fetchInterceptActive = false;
    let mockingPaused = false;  // true = mocks defined but intercept disabled

    function urlMatchesMock(url: string, pattern: string): boolean {
      if (pattern.includes('*')) {
        const regexStr = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(regexStr, 'i').test(url);
      }
      return url.includes(pattern);
    }

    async function enableFetchIntercept(): Promise<void> {
      if (fetchInterceptActive) return;
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
        ctx.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
        return;
      }

      if (match.type === 'block') {
        ctx.cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
        return;
      }

      const headers = Object.entries(match.responseHeaders ?? { 'Content-Type': 'application/json' })
        .map(([name, value]) => ({ name, value }));
      ctx.cdp.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: match.statusCode ?? 200,
        responseHeaders: headers,
        body: Buffer.from(match.responseBody ?? '').toString('base64'),
      }).catch(() => {});
    });

    ctx.registerTool('mock_network_request', {
      description:
        'Intercept ALL requests matching a URL pattern and return a mock response — every call, not just once. ' +
        'Uses the CDP Fetch domain: no app changes required, works for fetch and XHR. ' +
        'Mock stays active until removed with remove_network_mock or cleared with clear_network_mocks. ' +
        'Use save_network_mocks to persist to a file so mocks survive server restarts.',
      parameters: z.object({
        urlPattern: z.string()
          .describe('URL substring or glob pattern (e.g. "/api/users", "*.example.com/auth*")'),
        statusCode: z.number().int().min(100).max(599).default(200)
          .describe('HTTP status code (default 200)'),
        responseBody: z.string().default('')
          .describe('Response body string (e.g. a JSON payload)'),
        responseHeaders: z.record(z.string()).optional()
          .describe('Response headers (default: {"Content-Type": "application/json"})'),
      }),
      handler: async ({ urlPattern, statusCode, responseBody, responseHeaders }) => {
        const idx = mocks.findIndex((m) => m.urlPattern === urlPattern);
        if (idx !== -1) mocks.splice(idx, 1);
        mocks.push({ urlPattern, type: 'mock', statusCode, responseBody, responseHeaders });
        if (!mockingPaused) await enableFetchIntercept();
        return { mocked: urlPattern, statusCode, activeCount: mocks.length, interceptActive: fetchInterceptActive };
      },
    });

    ctx.registerTool('block_network_request', {
      description:
        'Block ALL requests matching a URL pattern, making them fail with a network error — every call. ' +
        'Useful for testing offline behaviour, error handling, or simulating unavailable services.',
      parameters: z.object({
        urlPattern: z.string()
          .describe('URL substring or glob pattern to block (e.g. "/api/upload", "analytics.*")'),
      }),
      handler: async ({ urlPattern }) => {
        const idx = mocks.findIndex((m) => m.urlPattern === urlPattern);
        if (idx !== -1) mocks.splice(idx, 1);
        mocks.push({ urlPattern, type: 'block' });
        if (!mockingPaused) await enableFetchIntercept();
        return { blocked: urlPattern, activeCount: mocks.length, interceptActive: fetchInterceptActive };
      },
    });

    ctx.registerTool('remove_network_mock', {
      description: 'Remove a single network mock or block by URL pattern, leaving all other mocks intact.',
      parameters: z.object({
        urlPattern: z.string().describe('Exact URL pattern to remove'),
      }),
      handler: async ({ urlPattern }) => {
        const idx = mocks.findIndex((m) => m.urlPattern === urlPattern);
        if (idx === -1) return `No mock found for pattern "${urlPattern}".`;
        mocks.splice(idx, 1);
        // If no mocks remain, disable interception
        if (mocks.length === 0 && !mockingPaused) await disableFetchIntercept();
        return { removed: urlPattern, remaining: mocks.length };
      },
    });

    ctx.registerTool('pause_network_mocking', {
      description:
        'Disable network request interception without removing mock definitions. ' +
        'All mocked URLs will pass through to the real server. ' +
        'Call resume_network_mocking to re-enable. Useful for quickly toggling between real and mocked responses.',
      parameters: z.object({}),
      handler: async () => {
        if (mockingPaused) return 'Network mocking is already paused.';
        mockingPaused = true;
        await disableFetchIntercept();
        return { paused: true, mocksPreserved: mocks.length };
      },
    });

    ctx.registerTool('resume_network_mocking', {
      description:
        'Re-enable network request interception after pause_network_mocking. ' +
        'All previously defined mocks and blocks become active again immediately.',
      parameters: z.object({}),
      handler: async () => {
        if (!mockingPaused && fetchInterceptActive) return 'Network mocking is already active.';
        mockingPaused = false;
        if (mocks.length === 0) return 'Network mocking resumed but no mocks are defined. Use mock_network_request to add some.';
        await enableFetchIntercept();
        return { resumed: true, activeMocks: mocks.length };
      },
    });

    ctx.registerTool('clear_network_mocks', {
      description:
        'Remove ALL network mocks and blocks and disable interception. ' +
        'Use remove_network_mock to remove a single mock, or pause_network_mocking to temporarily disable without clearing.',
      parameters: z.object({}),
      handler: async () => {
        const count = mocks.length;
        mocks.length = 0;
        mockingPaused = false;
        await disableFetchIntercept();
        return { cleared: count };
      },
    });

    ctx.registerTool('save_network_mocks', {
      description:
        'Save the current mock definitions to a JSON file in your project. ' +
        'The file can be committed to your codebase and loaded later with load_network_mocks. ' +
        'Like Chrome DevTools Local Overrides — persist your mock setup across sessions.',
      parameters: z.object({
        filepath: z.string().default('./network-mocks.json')
          .describe('Path to save the mocks file (default: ./network-mocks.json)'),
      }),
      handler: async ({ filepath }) => {
        if (mocks.length === 0) return 'No mocks to save. Add some with mock_network_request first.';
        const absPath = resolve(filepath);
        await mkdir(dirname(absPath), { recursive: true });
        const file: MockFile = { version: 1, mocks: [...mocks] };
        await writeFile(absPath, JSON.stringify(file, null, 2), 'utf8');
        return { saved: absPath, count: mocks.length };
      },
    });

    ctx.registerTool('load_network_mocks', {
      description:
        'Load mock definitions from a previously saved JSON file and activate them immediately. ' +
        'Use this at the start of a debug session to restore your saved mock configuration. ' +
        'Existing in-memory mocks are merged (not replaced) unless replace=true.',
      parameters: z.object({
        filepath: z.string().default('./network-mocks.json')
          .describe('Path to the mocks file (default: ./network-mocks.json)'),
        replace: z.boolean().default(false)
          .describe('Replace existing in-memory mocks instead of merging (default false)'),
        activate: z.boolean().default(true)
          .describe('Start intercepting immediately after loading (default true)'),
      }),
      handler: async ({ filepath, replace, activate }) => {
        const absPath = resolve(filepath);
        let raw: string;
        try {
          raw = await readFile(absPath, 'utf8');
        } catch {
          return `File not found: ${absPath}. Use save_network_mocks to create one.`;
        }

        const file = JSON.parse(raw) as MockFile;
        if (!Array.isArray(file.mocks)) {
          return `Invalid mocks file format: expected { version, mocks[] }`;
        }

        if (replace) mocks.length = 0;

        let added = 0;
        for (const entry of file.mocks) {
          const idx = mocks.findIndex((m) => m.urlPattern === entry.urlPattern);
          if (idx !== -1) mocks.splice(idx, 1);
          mocks.push(entry);
          added++;
        }

        mockingPaused = !activate;
        if (activate && mocks.length > 0) await enableFetchIntercept();

        return { loaded: absPath, added, total: mocks.length, interceptActive: fetchInterceptActive };
      },
    });

    ctx.registerTool('get_active_mocks', {
      description: 'List all currently defined network mocks and blocks, and whether interception is active.',
      parameters: z.object({}),
      handler: async () => {
        if (mocks.length === 0) return { interceptActive: false, paused: mockingPaused, mocks: [] };
        return {
          interceptActive: fetchInterceptActive,
          paused: mockingPaused,
          mocks: mocks.map((m) => ({
            urlPattern: m.urlPattern,
            type: m.type,
            ...(m.type === 'mock' ? {
              statusCode: m.statusCode,
              responseBodyPreview: m.responseBody ? m.responseBody.slice(0, 100) + (m.responseBody.length > 100 ? '…' : '') : '',
              responseHeaders: m.responseHeaders,
            } : {}),
          })),
        };
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
