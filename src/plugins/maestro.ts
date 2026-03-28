import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { collectElements, type TestableElement } from '../utils/fiber.js';

export const maestroPlugin = definePlugin({
  name: 'maestro',
  version: '0.1.0',
  description: 'Maestro test flow generation from component tree data',

  async setup(ctx) {
    ctx.registerTool('generate_maestro_flow', {
      description:
        "Generate a Maestro test flow (YAML) from a description of user actions. Uses the current screen's component tree to find correct selectors.",
      parameters: z.object({
        description: z.string().describe(
          'Description of the test flow (e.g., "Tap the login button, enter email, tap submit")'
        ),
        appId: z.string().optional().describe('App bundle ID (e.g., com.example.app)'),
        includeAssertions: z.boolean().default(true).describe('Include assertVisible assertions'),
      }),
      handler: async ({ description, appId, includeAssertions }) => {
        const elements = await collectElements(ctx.evalInApp.bind(ctx));

        function toSelector(el: TestableElement): string | null {
          if (el.testID) return `id: "${el.testID}"`;
          if (el.accessibilityLabel) return `id: "${el.accessibilityLabel}"`;
          if (el.text) return `text: "${el.text}"`;
          return null;
        }

        function findElement(step: string): TestableElement | undefined {
          const lower = step.toLowerCase();
          return elements.find((el) => {
            const candidates = [el.testID, el.accessibilityLabel, el.text, el.name]
              .filter(Boolean)
              .map((s) => s!.toLowerCase());
            return candidates.some((c) => lower.includes(c));
          });
        }

        const lines: string[] = [];
        if (appId) lines.push(`appId: ${appId}`);
        lines.push('---');
        lines.push(`# Generated from: ${description}`);
        lines.push('# Available selectors on current screen:');
        for (const el of elements.slice(0, 20)) {
          const sel = toSelector(el);
          if (sel) lines.push(`#   ${el.name}: ${sel}`);
        }
        lines.push('');

        const steps = description.split(/[,;.]/).map((s) => s.trim()).filter(Boolean);

        for (const step of steps) {
          const lowerStep = step.toLowerCase();
          const matchingEl = findElement(step);
          const selector = matchingEl ? toSelector(matchingEl) : null;

          if (lowerStep.includes('tap') || lowerStep.includes('click') || lowerStep.includes('press')) {
            if (selector) {
              lines.push(`- tapOn:`);
              lines.push(`    ${selector}`);
            } else {
              lines.push(`# TODO: Find selector for: ${step}`);
              lines.push(`- tapOn:`);
              lines.push(`    text: "TODO"`);
            }
          } else if (lowerStep.includes('type') || lowerStep.includes('enter') || lowerStep.includes('input')) {
            const textMatch = step.match(/["']([^"']+)["']/);
            const text = textMatch ? textMatch[1] : 'TODO';
            if (selector) {
              lines.push(`- tapOn:`);
              lines.push(`    ${selector}`);
            }
            lines.push(`- inputText: "${text}"`);
          } else if (lowerStep.includes('swipe')) {
            const dir = lowerStep.includes('up') ? 'UP' : lowerStep.includes('down') ? 'DOWN'
              : lowerStep.includes('left') ? 'LEFT' : 'RIGHT';
            lines.push(`- swipe${dir.charAt(0) + dir.slice(1).toLowerCase()}`);
          } else if (lowerStep.includes('wait')) {
            const timeMatch = step.match(/(\d+)/);
            lines.push(`- wait: ${timeMatch ? parseInt(timeMatch[1]) * 1000 : 2000}`);
          } else if (lowerStep.includes('assert') || lowerStep.includes('verify') || lowerStep.includes('check')) {
            if (selector) {
              lines.push(`- assertVisible:`);
              lines.push(`    ${selector}`);
            } else {
              lines.push(`# TODO: Assert: ${step}`);
            }
          } else {
            lines.push(`# ${step}`);
            if (selector) {
              lines.push(`- tapOn:`);
              lines.push(`    ${selector}`);
            }
          }
          lines.push('');
        }

        if (includeAssertions && elements.length > 0) {
          lines.push('# Assertions');
          const firstVisible = elements.find((el) => el.testID || el.text);
          if (firstVisible) {
            const sel = firstVisible.testID
              ? `id: "${firstVisible.testID}"`
              : `text: "${firstVisible.text}"`;
            lines.push(`- assertVisible:`);
            lines.push(`    ${sel}`);
          }
        }

        return lines.join('\n');
      },
    });

    ctx.registerTool('record_interaction', {
      description:
        'Start or stop recording user interactions and output as Maestro YAML steps. Note: This captures console events, not native touch events.',
      parameters: z.object({
        action: z.enum(['start', 'stop']).describe('Start or stop recording'),
      }),
      handler: async ({ action }) => {
        if (action === 'start') {
          await ctx.evalInApp(`
            (function() {
              globalThis.__METRO_MCP_RECORDING__ = [];
              var origNav = console.info;
              console.info = function() {
                var msg = Array.from(arguments).join(' ');
                if (msg.includes('navigate') || msg.includes('press') || msg.includes('tap')) {
                  globalThis.__METRO_MCP_RECORDING__.push({
                    time: Date.now(),
                    type: 'interaction',
                    description: msg,
                  });
                }
                origNav.apply(console, arguments);
              };
            })()
          `, { timeout: 5000 });
          return 'Recording started. Interact with the app, then call record_interaction with action="stop".';
        } else {
          const events = await ctx.evalInApp(`
            (function() {
              var events = globalThis.__METRO_MCP_RECORDING__ || [];
              delete globalThis.__METRO_MCP_RECORDING__;
              return events;
            })()
          `, { timeout: 5000 });

          if (!Array.isArray(events) || events.length === 0) {
            return 'No interactions recorded. Use generate_maestro_flow instead for description-based generation.';
          }

          const lines = ['---', '# Recorded interaction flow', ''];
          for (const event of events) {
            lines.push(`# ${(event as Record<string, unknown>).description}`);
          }
          return lines.join('\n');
        }
      },
    });
  },
});
