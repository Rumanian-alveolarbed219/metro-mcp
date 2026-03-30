import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('devtools');

/**
 * Well-known Chrome/Chromium binary paths by platform.
 * Same locations that chrome-launcher and Metro's DefaultToolLauncher check.
 */
const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    'google-chrome',
    'google-chrome-stable',
    'chromium-browser',
    'chromium',
    'microsoft-edge',
  ],
};

export const devtoolsPlugin = definePlugin({
  name: 'devtools',

  description: 'Open React Native DevTools via the CDP proxy',

  async setup(ctx) {
    ctx.registerTool('open_devtools', {
      description:
        'Open the React Native DevTools debugger panel in Chrome. ' +
        'Uses Metro\'s bundled DevTools frontend but connects through our CDP proxy ' +
        'so both DevTools and the MCP can share the single Hermes connection.',
      parameters: z.object({
        open: z.boolean().default(true).describe('Attempt to open Chrome automatically'),
      }),
      handler: async ({ open }) => {
        const config = ctx.config as Record<string, unknown>;
        const proxyConfig = config.proxy as { port?: number } | undefined;
        const proxyPort = proxyConfig?.port;

        if (!proxyPort) {
          return 'CDP proxy is not running. Set proxy.enabled to true in your metro-mcp config.';
        }

        // Build a URL using Metro's own DevTools frontend, but pointing the
        // WebSocket connection at our proxy instead of Metro's inspector.
        // This is the same frontend Metro uses when you press "j", served
        // from the @react-native/debugger-frontend package.
        const frontendUrl = `http://${ctx.metro.host}:${ctx.metro.port}/debugger-frontend/rn_fusebox.html`
          + `?ws=127.0.0.1:${proxyPort}`
          + `&sources.hide_add_folder=true`;

        if (open) {
          try {
            // Spawn Chrome directly with --app flag, like Metro's DefaultToolLauncher.
            // Using `open -a` doesn't work because it ignores --args when Chrome
            // is already running. We need to spawn the binary directly.
            const platform = await ctx.exec('uname -s').then(s => s.trim().toLowerCase());
            const candidates = platform === 'darwin' ? CHROME_PATHS.darwin : CHROME_PATHS.linux;

            if (candidates) {
              for (const chromePath of candidates!) {
                try {
                  // Spawn detached so it doesn't block or die with the MCP process.
                  // On macOS we need the full path; on Linux, commands in PATH work.
                  await ctx.exec(
                    `"${chromePath}" --app="${frontendUrl}" --window-size=1200,600 &`
                  );
                  return { opened: true, url: frontendUrl };
                } catch {
                  // This candidate not found, try next
                  continue;
                }
              }
            }
          } catch (err) {
            logger.debug('Failed to launch Chrome:', err);
          }
        }

        return {
          opened: false,
          url: frontendUrl,
          instructions: 'Open this URL in Chrome: ' + frontendUrl,
        };
      },
    });
  },
});
