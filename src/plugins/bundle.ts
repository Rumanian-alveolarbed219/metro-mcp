import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { CircularBuffer } from '../utils/buffer.js';
import { formatTimestamp } from '../utils/format.js';
import { checkMetroStatus } from '../metro/discovery.js';

interface BundleError {
  timestamp: number;
  type: string;
  message: string;
  file?: string;
  lineNumber?: number;
  column?: number;
  codeFrame?: string;
}

export const bundlePlugin = definePlugin({
  name: 'bundle',
  version: '0.1.0',
  description: 'Metro bundle diagnostics and error detection',

  async setup(ctx) {
    const errors = new CircularBuffer<BundleError>(100);

    // Listen for compilation errors via console
    ctx.cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const args = (params.args as Array<Record<string, unknown>>) || [];
        const message = args.map((a) => a.value || a.description || '').join(' ');

        // Detect common bundle error patterns
        const patterns = [
          /Unable to resolve module/,
          /SyntaxError/,
          /TransformError/,
          /Error: Module not found/,
          /Unexpected token/,
        ];

        for (const pattern of patterns) {
          if (pattern.test(message)) {
            const fileMatch = message.match(/(?:in |from )([^\s:]+(?:\.tsx?|\.jsx?|\.json))/);
            const lineMatch = message.match(/(?:line |:)(\d+)/);
            const colMatch = message.match(/:(\d+):(\d+)/);

            errors.push({
              timestamp: Date.now(),
              type: pattern.source.replace(/[\\^$]/g, ''),
              message,
              file: fileMatch?.[1],
              lineNumber: lineMatch ? parseInt(lineMatch[1]) : undefined,
              column: colMatch ? parseInt(colMatch[2]) : undefined,
            });
            break;
          }
        }
      }
    });

    ctx.registerTool('get_bundle_status', {
      description: 'Check Metro bundler status and health.',
      parameters: z.object({}),
      handler: async () => {
        const status = await checkMetroStatus(ctx.metro.host, ctx.metro.port);
        return {
          status: status || 'unreachable',
          url: `http://${ctx.metro.host}:${ctx.metro.port}`,
          cdpConnected: ctx.cdp.isConnected(),
          recentErrors: errors.size,
        };
      },
    });

    ctx.registerTool('get_bundle_errors', {
      description: 'Get recent Metro compilation/transform errors.',
      parameters: z.object({
        limit: z.number().default(20).describe('Maximum errors to return'),
      }),
      handler: async ({ limit }) => {
        const errs = errors.getAll().slice(-limit);
        if (errs.length === 0) return 'No bundle errors detected.';
        return errs.map((e) => ({
          time: formatTimestamp(e.timestamp),
          type: e.type,
          message: ctx.format.truncate(e.message, 500),
          file: e.file,
          line: e.lineNumber,
          column: e.column,
        }));
      },
    });

    ctx.registerTool('reload_app', {
      description:
        'Trigger a fast refresh (hot reload) of the running React Native app. ' +
        'Equivalent to pressing Cmd+R in the simulator or shaking the device and tapping "Reload". ' +
        'Use this after making code changes or to reset app state without reinstalling.',
      parameters: z.object({}),
      handler: async () => {
        // Primary: call DevSettings.reload() via JS — works on all architectures
        try {
          await ctx.evalInApp(
            `(function() {
               var DS = require('react-native').DevSettings;
               if (DS && typeof DS.reload === 'function') { DS.reload(); return 'devSettings'; }
               return null;
             })()`,
          );
          return 'App reload triggered via DevSettings.reload().';
        } catch {
          // fallback below
        }

        // Fallback: send RN_RELOAD keypress via adb (Android) or simctl (iOS)
        try {
          await ctx.exec('adb shell input keyevent 82 2>/dev/null || true');
          return 'App reload triggered via adb keyevent (Android).';
        } catch {
          // ignore
        }

        return 'Could not trigger reload: no CDP connection and no adb/simctl available. Connect to a device first.';
      },
    });

    ctx.registerTool('send_dev_menu_command', {
      description:
        'Send a Metro developer menu command to the running app. ' +
        'Supported commands depend on the React Native version. ' +
        'Common commands: "reload", "toggleElementInspector", "toggleNetworkInspector", "togglePerformanceMonitor".',
      parameters: z.object({
        command: z.string().describe('Dev menu command string (e.g. "reload", "toggleElementInspector")'),
      }),
      handler: async ({ command }) => {
        const result = await ctx.evalInApp(
          `(function() {
             var RN = require('react-native');
             var NM = RN.NativeModules;
             // React Native 0.71+ DevMenu module
             if (NM && NM.DevMenu && typeof NM.DevMenu.sendCommand === 'function') {
               NM.DevMenu.sendCommand(${JSON.stringify(command)});
               return 'DevMenu.sendCommand';
             }
             // Older path via DevSettings
             var DS = RN.DevSettings;
             if (DS && typeof DS[${JSON.stringify(command)}] === 'function') {
               DS[${JSON.stringify(command)}]();
               return 'DevSettings';
             }
             return null;
           })()`,
        );
        if (!result) {
          return `Command "${command}" not available on this React Native version or dev menu module not found.`;
        }
        return `Dev menu command "${command}" sent via ${result}.`;
      },
    });

    ctx.registerResource('metro://bundle/status', {
      name: 'Bundle Status',
      description: 'Metro bundler status and recent errors',
      handler: async () => {
        const status = await checkMetroStatus(ctx.metro.host, ctx.metro.port);
        return JSON.stringify(
          {
            status: status || 'unreachable',
            errorCount: errors.size,
          },
          null,
          2
        );
      },
    });
  },
});
