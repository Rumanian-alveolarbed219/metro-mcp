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

// Emit capability lines for a platform into the provided array.
function pushCaps(lines: string[], platform: 'ios' | 'android', bundleId: string | undefined, indent: string): void {
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

// Resolve the current route name from the navigation state via CDP.
const CURRENT_ROUTE_JS = `
  (function() {
    try {
      var nav = globalThis.__METRO_MCP_NAV_REF__;
      if (nav && nav.getCurrentRoute) {
        var r = nav.getCurrentRoute();
        return r ? r.name : null;
      }
    } catch(e) {}
    return null;
  })()
`;

// Server-side recording state — persists across tool calls within the plugin lifetime.
interface RecordingStep {
  description: string;
  route: string | null;
  elements: TestableElement[];
}

let recordingSteps: RecordingStep[] | null = null;

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

        // Pre-compute selectors once so the step loop doesn't call toSelector per-element.
        const selectorCache = new Map(elements.map((el) => [el, toSelector(el)]));
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
            lines.push(sel
              ? `    await driver.$('${sel}').setValue(${JSON.stringify(value)});`
              : `    // TODO: find selector for "${step}"\n    // await driver.$('~input').setValue(${JSON.stringify(value)});`);

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
        'Snapshot-based interaction recorder. Call start, perform an action in the app, call step with a description of what you just did, repeat, then call stop to get a WebdriverIO test. More reliable than event interception since it reads live accessibility selectors after each action.',
      parameters: z.object({
        action: z.enum(['start', 'step', 'stop']).describe(
          'start — begin a new recording; step — snapshot current screen after performing an action; stop — finish and output the test'
        ),
        description: z.string().optional().describe(
          'For action="step": plain-English description of the action just performed (e.g. "tap login button")'
        ),
        testName: z.string().optional().describe('For action="stop": name for the generated it() block'),
      }),
      handler: async ({ action, description, testName }) => {
        if (action === 'start') {
          recordingSteps = [];
          const route = await ctx.evalInApp(CURRENT_ROUTE_JS, { timeout: 3000 }).catch(() => null) as string | null;
          const elements = await collectElements(ctx.evalInApp.bind(ctx));
          recordingSteps.push({ description: '__start__', route, elements });
          const routeInfo = route ? ` on screen "${route}"` : '';
          return `Recording started${routeInfo}. Perform an action in the app, then call record_appium_interactions with action="step" and a description of what you did.`;

        } else if (action === 'step') {
          if (!recordingSteps) {
            return 'No recording in progress. Call with action="start" first.';
          }
          if (!description) {
            return 'Provide a description of the action you just performed.';
          }
          const route = await ctx.evalInApp(CURRENT_ROUTE_JS, { timeout: 3000 }).catch(() => null) as string | null;
          const elements = await collectElements(ctx.evalInApp.bind(ctx));
          recordingSteps.push({ description, route, elements });

          const prev = recordingSteps[recordingSteps.length - 2];
          const routeChanged = route && prev.route && route !== prev.route;
          const routeInfo = routeChanged ? ` (navigated to "${route}")` : route ? ` (still on "${route}")` : '';
          return `Step ${recordingSteps.length - 1} captured${routeInfo}: "${description}". Perform the next action or call with action="stop".`;

        } else {
          if (!recordingSteps || recordingSteps.length < 2) {
            recordingSteps = null;
            return 'No steps recorded. Call with action="start" then action="step" after each interaction.';
          }

          const steps = recordingSteps.slice(1); // skip __start__ snapshot
          const name = testName || 'Recorded flow';
          const lines: string[] = [`it('${name}', async () => {`, ''];

          for (const step of steps) {
            lines.push(`  // ${step.description}`);

            const lower = step.description.toLowerCase();
            const prevIdx = recordingSteps!.indexOf(step) - 1;
            const prevElements = recordingSteps![prevIdx]?.elements ?? [];

            // Find the most likely interacted element: look for it in the PREVIOUS screen's elements
            // since taps cause navigations that replace the element list.
            const el = findElement(step.description, prevElements) ?? findElement(step.description, step.elements);
            const sel = el ? toSelector(el) : null;

            if (lower.includes('tap') || lower.includes('click') || lower.includes('press') || lower.includes('select')) {
              lines.push(sel
                ? `  await driver.$('${sel}').click();`
                : `  // await driver.$('~TODO').click(); // no matching selector found`);

            } else if (lower.includes('type') || lower.includes('enter') || lower.includes('input') || lower.includes('fill')) {
              const quoted = step.description.match(/["']([^"']+)["']/);
              const value = quoted ? quoted[1] : 'TODO';
              lines.push(sel
                ? `  await driver.$('${sel}').setValue(${JSON.stringify(value)});`
                : `  // await driver.$('~TODO').setValue(${JSON.stringify(value)});`);

            } else if (lower.includes('swipe') || lower.includes('scroll')) {
              const dir = lower.includes('up') ? 'up' : lower.includes('down') ? 'down'
                : lower.includes('left') ? 'left' : 'right';
              const [sx, sy, ex, ey] = SWIPE_COORDS[dir];
              lines.push(`  await driver.touchAction([`);
              lines.push(`    { action: 'press', x: ${sx}, y: ${sy} },`);
              lines.push(`    { action: 'moveTo', x: ${ex}, y: ${ey} },`);
              lines.push(`    { action: 'release' },`);
              lines.push(`  ]);`);

            } else if (lower.includes('back')) {
              lines.push(`  await driver.back();`);

            } else {
              lines.push(sel
                ? `  await driver.$('${sel}').click();`
                : `  // TODO: implement "${step.description}"`);
            }

            // Assert a visible element from the resulting screen.
            const assertEl = step.elements.find((e) => toSelector(e));
            if (assertEl) {
              lines.push(`  await driver.$('${toSelector(assertEl)}').waitForDisplayed({ timeout: 5000 });`);
            }
            lines.push('');
          }

          lines.push(`});`);
          recordingSteps = null;
          return lines.join('\n');
        }
      },
    });

    ctx.registerTool('generate_wdio_config', {
      description:
        'Generate a minimal but runnable wdio.conf.ts for Appium + React Native testing, along with the npm/yarn install command.',
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'both']).default('ios'),
        bundleId: z.string().optional().describe('iOS bundle ID or Android app package'),
        appPath: z.string().optional().describe('Path to the built .app / .apk (leave empty to use a running simulator)'),
        outputPath: z.string().default('./wdio.conf.ts').describe('Where to write the config (shown in the output, not written to disk)'),
      }),
      handler: async ({ platform, bundleId, appPath, outputPath }) => {
        const lines: string[] = [];

        lines.push(`// ${outputPath}`);
        lines.push(`// Install deps: npm install --save-dev @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/spec-reporter appium wdio-appium-service`);
        lines.push(`import type { Options } from '@wdio/types';`);
        lines.push('');

        const buildCaps = (p: 'ios' | 'android') => {
          const cap: string[] = [];
          cap.push(`      {`);
          if (p === 'ios') {
            cap.push(`        platformName: 'iOS',`);
            cap.push(`        'appium:automationName': 'XCUITest',`);
            cap.push(`        'appium:deviceName': 'iPhone 16',`);
            cap.push(`        'appium:platformVersion': '18.0',`);
            if (appPath) cap.push(`        'appium:app': '${appPath}',`);
            else cap.push(bundleId ? `        'appium:bundleId': '${bundleId}',` : `        'appium:bundleId': 'com.example.app',`);
          } else {
            cap.push(`        platformName: 'Android',`);
            cap.push(`        'appium:automationName': 'UiAutomator2',`);
            cap.push(`        'appium:deviceName': 'emulator-5554',`);
            if (appPath) cap.push(`        'appium:app': '${appPath}',`);
            else {
              cap.push(bundleId ? `        'appium:appPackage': '${bundleId}',` : `        'appium:appPackage': 'com.example.app',`);
              cap.push(`        'appium:appActivity': '.MainActivity',`);
            }
          }
          cap.push(`        'appium:newCommandTimeout': 240,`);
          cap.push(`      },`);
          return cap;
        };

        lines.push(`export const config: Options.Testrunner = {`);
        lines.push(`  runner: 'local',`);
        lines.push(`  autoCompileOpts: { autoCompile: true, tsNodeOpts: { project: './tsconfig.json' } },`);
        lines.push('');
        lines.push(`  port: 4723,`);
        lines.push(`  services: ['appium'],`);
        lines.push(`  appium: { command: 'appium' },`);
        lines.push('');
        lines.push(`  specs: ['./e2e/**/*.test.ts'],`);
        lines.push(`  exclude: [],`);
        lines.push('');
        lines.push(`  capabilities: [`);
        if (platform === 'both') {
          lines.push(...buildCaps('ios'));
          lines.push(...buildCaps('android'));
        } else {
          lines.push(...buildCaps(platform));
        }
        lines.push(`  ],`);
        lines.push('');
        lines.push(`  framework: 'mocha',`);
        lines.push(`  mochaOpts: { ui: 'bdd', timeout: 60000 },`);
        lines.push('');
        lines.push(`  reporters: ['spec'],`);
        lines.push('');
        lines.push(`  // Retry flaky tests once`);
        lines.push(`  bail: 0,`);
        lines.push(`  waitforTimeout: 10000,`);
        lines.push(`  connectionRetryTimeout: 120000,`);
        lines.push(`  connectionRetryCount: 3,`);
        lines.push(`};`);
        lines.push('');
        lines.push(`/*`);
        lines.push(` * Run a single test:`);
        lines.push(` *   npx wdio run ${outputPath} --spec ./e2e/login.test.ts`);
        lines.push(` *`);
        lines.push(` * Run all tests:`);
        lines.push(` *   npx wdio run ${outputPath}`);
        lines.push(` *`);
        lines.push(` * Make sure Appium is installed globally:`);
        lines.push(` *   npm install -g appium`);
        lines.push(` *   appium driver install xcuitest`);
        lines.push(` *   appium driver install uiautomator2`);
        lines.push(` */`);

        return lines.join('\n');
      },
    });
  },
});
