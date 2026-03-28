import { z } from 'zod';
import { definePlugin } from '../plugin.js';
import { collectElements, type TestableElement } from '../utils/fiber.js';

// Swipe coords [startX, startY, endX, endY] — assumes ~1080×1920 viewport.
const SWIPE_COORDS: Record<string, [number, number, number, number]> = {
  up:    [500, 1500, 500,  500],
  down:  [500,  500, 500, 1500],
  left:  [800, 1000, 200, 1000],
  right: [200, 1000, 800, 1000],
};

const MAX_RECORDING_EVENTS = 500;

// Build the best WebdriverIO selector for an element: testID > accessibilityLabel.
function toSelector(el: TestableElement): string {
  if (el.testID) return `~${el.testID}`;
  if (el.accessibilityLabel) return `~${el.accessibilityLabel}`;
  return '';
}

// Match a step description against the element list.
function findElement(step: string, elements: TestableElement[]): TestableElement | undefined {
  const lower = step.toLowerCase();
  return elements.find((el) => {
    const candidates = [el.testID, el.accessibilityLabel, el.text, el.name]
      .filter(Boolean)
      .map((s) => s!.toLowerCase());
    return candidates.some((c) => lower.includes(c));
  });
}

// Emit capability lines for a platform into the provided lines array.
function pushCaps(
  lines: string[],
  platform: 'ios' | 'android',
  bundleId: string | undefined,
  indent: string,
): void {
  if (platform === 'ios') {
    lines.push(`${indent}platformName: 'iOS',`);
    lines.push(`${indent}'appium:automationName': 'XCUITest',`);
    lines.push(bundleId
      ? `${indent}'appium:bundleId': '${bundleId}',`
      : `${indent}'appium:bundleId': 'com.example.app', // TODO: set bundle ID`);
  } else {
    lines.push(`${indent}platformName: 'Android',`);
    lines.push(`${indent}'appium:automationName': 'UiAutomator2',`);
    lines.push(bundleId
      ? `${indent}'appium:appPackage': '${bundleId}',`
      : `${indent}'appium:appPackage': 'com.example.app', // TODO: set app package`);
    lines.push(`${indent}'appium:appActivity': '.MainActivity',`);
  }
}

export const appiumPlugin = definePlugin({
  name: 'appium',
  version: '0.1.0',
  description: 'Appium/WebdriverIO test generation from component tree data',

  async setup(ctx) {
    ctx.registerTool('generate_appium_test', {
      description:
        "Generate a WebdriverIO + Jest test file from a plain-English description of user actions. Uses the current screen's component tree to build accurate selectors.",
      parameters: z.object({
        description: z.string().describe(
          'Description of the test scenario (e.g., "Tap login button, enter email and password, tap submit, verify home screen")'
        ),
        testName: z.string().optional().describe('Name for the describe block (defaults to the description)'),
        platform: z.enum(['ios', 'android', 'both']).default('ios').describe('Target platform'),
        bundleId: z.string().optional().describe('iOS bundle ID or Android app package (e.g. com.example.app)'),
        includeSetup: z.boolean().default(true).describe('Include driver setup/teardown boilerplate'),
        includeAssertions: z.boolean().default(true).describe('Add toBeDisplayed assertions after navigation steps'),
      }),
      handler: async ({ description, testName, platform, bundleId, includeSetup, includeAssertions }) => {
        const elements = await collectElements(ctx.evalInApp.bind(ctx));

        // Pre-compute selectors once so the step loop doesn't recompute per-element.
        const selectorCache = new Map(elements.map((el) => [el, toSelector(el)]));
        // First element with a non-empty selector that isn't the current step's element.
        const firstSelectable = elements.find((e) => selectorCache.get(e));

        const name = testName || description;
        const steps = description.split(/[,;.]/).map((s) => s.trim()).filter(Boolean);
        const lines: string[] = [];

        lines.push(`import { remote, Browser } from 'webdriverio';`);
        lines.push('');

        if (includeSetup) {
          if (platform === 'both') {
            lines.push(`const IOS_CAPS = {`);
            pushCaps(lines, 'ios', bundleId, '  ');
            lines.push(`};`);
            lines.push('');
            lines.push(`const ANDROID_CAPS = {`);
            pushCaps(lines, 'android', bundleId, '  ');
            lines.push(`};`);
            lines.push('');
          }
        }

        lines.push(`describe('${name}', () => {`);

        if (includeSetup) {
          lines.push(`  let driver: Browser;`);
          lines.push('');
          lines.push(`  beforeAll(async () => {`);
          if (platform === 'both') {
            lines.push(`    // Run with IOS_CAPS or ANDROID_CAPS depending on target`);
            lines.push(`    driver = await remote({ capabilities: IOS_CAPS });`);
          } else {
            lines.push(`    driver = await remote({`);
            lines.push(`      capabilities: {`);
            pushCaps(lines, platform, bundleId, '        ');
            lines.push(`      },`);
            lines.push(`    });`);
          }
          lines.push(`  });`);
          lines.push('');
          lines.push(`  afterAll(async () => {`);
          lines.push(`    await driver.deleteSession();`);
          lines.push(`  });`);
          lines.push('');
        }

        lines.push(`  it('${steps[0] || name}', async () => {`);

        if (elements.length > 0) {
          lines.push(`    // Available selectors on current screen:`);
          for (const el of elements.slice(0, 15)) {
            const sel = selectorCache.get(el);
            if (sel) lines.push(`    //   driver.$('${sel}')  // ${el.name}`);
          }
          lines.push('');
        }

        for (const step of steps) {
          const lower = step.toLowerCase();
          const el = findElement(step, elements);
          const sel = el ? selectorCache.get(el) || null : null;

          lines.push(`    // ${step}`);

          if (lower.includes('tap') || lower.includes('click') || lower.includes('press')) {
            lines.push(sel
              ? `    await driver.$('${sel}').click();`
              : `    // TODO: find selector for "${step}"\n    // await driver.$('~element').click();`);

          } else if (lower.includes('type') || lower.includes('enter') || lower.includes('input') || lower.includes('fill')) {
            const quoted = step.match(/["']([^"']+)["']/);
            const value = quoted ? quoted[1] : 'TODO';
            if (sel) {
              lines.push(`    await driver.$('${sel}').setValue(${JSON.stringify(value)});`);
            } else {
              lines.push(`    // TODO: find selector for "${step}"`);
              lines.push(`    // await driver.$('~input').setValue(${JSON.stringify(value)});`);
            }

          } else if (lower.includes('clear')) {
            lines.push(sel
              ? `    await driver.$('${sel}').clearValue();`
              : `    // await driver.$('~input').clearValue();`);

          } else if (lower.includes('swipe') || lower.includes('scroll')) {
            const dir = lower.includes('up') ? 'up' : lower.includes('down') ? 'down'
              : lower.includes('left') ? 'left' : 'right';
            const [sx, sy, ex, ey] = SWIPE_COORDS[dir];
            lines.push(`    await driver.touchAction([`);
            lines.push(`      { action: 'press', x: ${sx}, y: ${sy} },`);
            lines.push(`      { action: 'moveTo', x: ${ex}, y: ${ey} },`);
            lines.push(`      { action: 'release' },`);
            lines.push(`    ]);`);

          } else if (lower.includes('wait')) {
            const ms = (step.match(/(\d+)/) || [])[1];
            if (ms) {
              lines.push(`    await driver.pause(${parseInt(ms) * (parseInt(ms) < 100 ? 1000 : 1)});`);
            } else if (sel) {
              lines.push(`    await driver.$('${sel}').waitForDisplayed({ timeout: 5000 });`);
            } else {
              lines.push(`    await driver.pause(2000);`);
            }

          } else if (lower.includes('assert') || lower.includes('verify') || lower.includes('check') || lower.includes('expect') || lower.includes('see')) {
            lines.push(sel
              ? `    await expect(driver.$('${sel}')).toBeDisplayed();`
              : `    // TODO: assertion for "${step}"\n    // await expect(driver.$('~element')).toBeDisplayed();`);

          } else if (lower.includes('back')) {
            lines.push(`    await driver.back();`);

          } else if (lower.includes('screenshot')) {
            lines.push(`    await driver.saveScreenshot('./screenshot.png');`);

          } else {
            lines.push(sel
              ? `    await driver.$('${sel}').click();`
              : `    // TODO: implement step "${step}"`);
          }

          // Add a waitForDisplayed after tap/press steps using a pre-computed candidate.
          if (includeAssertions && sel && (
            lower.includes('tap') || lower.includes('click') || lower.includes('press') || lower.includes('submit')
          )) {
            const nextSel = firstSelectable && selectorCache.get(firstSelectable) !== sel
              ? selectorCache.get(firstSelectable)
              : null;
            if (nextSel) {
              lines.push(`    await driver.$('${nextSel}').waitForDisplayed({ timeout: 5000 });`);
            }
          }

          lines.push('');
        }

        lines.push(`  });`);
        lines.push(`});`);
        lines.push('');
        lines.push(`/*`);
        lines.push(` * Run with: npx wdio run wdio.conf.ts`);
        lines.push(` * Docs: https://webdriver.io/docs/gettingstarted`);
        lines.push(` * Selectors: https://webdriver.io/docs/selectors#accessibility-id`);
        lines.push(` */`);

        return lines.join('\n');
      },
    });

    ctx.registerTool('record_appium_interactions', {
      description:
        'Start or stop recording interactions and output as WebdriverIO driver calls. Captures onPress events from the React fiber tree.',
      parameters: z.object({
        action: z.enum(['start', 'stop']).describe('Start or stop recording'),
        testName: z.string().optional().describe('Test name for the generated it() block'),
      }),
      handler: async ({ action, testName }) => {
        if (action === 'start') {
          await ctx.evalInApp(`
            (function() {
              globalThis.__METRO_MCP_APPIUM_RECORDING__ = [];
              var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
              if (!hook || !hook.getFiberRoots) return;
              var fiberRoots;
              for (var i = 1; i <= 5; i++) {
                fiberRoots = hook.getFiberRoots(i);
                if (fiberRoots && fiberRoots.size > 0) break;
              }
              if (!fiberRoots || fiberRoots.size === 0) return;
              var stack = [{ f: Array.from(fiberRoots)[0].current, d: 0 }];
              while (stack.length) {
                var item = stack.pop();
                var fiber = item.f; var depth = item.d;
                if (!fiber || depth > 200) continue;
                var props = fiber.memoizedProps;
                if (props && props.onPress && !props.__mcp_patched__) {
                  var orig = props.onPress;
                  var id = props.testID || props.accessibilityLabel ||
                           (fiber.type && (fiber.type.displayName || fiber.type.name)) || 'unknown';
                  props.onPress = function(e) {
                    var rec = globalThis.__METRO_MCP_APPIUM_RECORDING__;
                    if (rec && rec.length < ${MAX_RECORDING_EVENTS}) {
                      rec.push({ type: 'tap', id: id, time: Date.now() });
                    }
                    return orig.apply(this, arguments);
                  };
                  props.__mcp_patched__ = true;
                }
                if (fiber.sibling) stack.push({ f: fiber.sibling, d: depth });
                if (fiber.child) stack.push({ f: fiber.child, d: depth + 1 });
              }
            })()
          `, { timeout: 5000 });

          return 'Recording started. Interact with the app, then call record_appium_interactions with action="stop".';

        } else {
          const events = await ctx.evalInApp(`
            (function() {
              var events = globalThis.__METRO_MCP_APPIUM_RECORDING__ || [];
              delete globalThis.__METRO_MCP_APPIUM_RECORDING__;
              return events;
            })()
          `, { timeout: 5000 }) as Array<{ type: string; id: string; text?: string; time: number }>;

          if (!Array.isArray(events) || events.length === 0) {
            return 'No interactions recorded. Use generate_appium_test for description-based generation instead.';
          }

          const name = testName || 'Recorded interaction';
          const lines: string[] = [`it('${name}', async () => {`, ''];

          for (const event of events) {
            if (event.type === 'tap') {
              lines.push(`  await driver.$('~${event.id}').click();`);
            } else if (event.type === 'input') {
              lines.push(`  await driver.$('~${event.id}').setValue(${JSON.stringify(event.text || '')});`);
            }
            lines.push('');
          }

          lines.push(`});`);
          return lines.join('\n');
        }
      },
    });
  },
});
