import { z } from 'zod';
import { definePlugin } from '../plugin.js';

export const permissionsPlugin = definePlugin({
  name: 'permissions',

  description: 'Inspect and manage app permissions on iOS Simulator and Android Emulator',

  async setup(ctx) {
    async function detectPlatform(): Promise<'ios' | 'android' | null> {
      try {
        await ctx.exec('xcrun simctl list booted 2>/dev/null | grep -q Booted');
        return 'ios';
      } catch {}
      try {
        const output = await ctx.exec('adb devices 2>/dev/null');
        if (output.trim().split('\n').length > 1) return 'android';
      } catch {}
      return null;
    }

    async function detectBundleId(platform: 'ios' | 'android'): Promise<string | null> {
      const config = ctx.config as Record<string, unknown>;
      if (platform === 'android' && config.packageName) return String(config.packageName);
      if (config.bundleId) return String(config.bundleId);

      try {
        if (ctx.cdp.isConnected) {
          const id = await ctx.evalInApp(
            `(function(){ try { return require('react-native-device-info').getBundleId(); } catch(e) { return null; } })()`,
            { awaitPromise: false }
          );
          if (id) return String(id);
        }
      } catch {}

      return null;
    }

    function resolvePlatform(platform: 'ios' | 'android' | 'auto' | undefined) {
      return platform === 'auto' || !platform ? detectPlatform() : Promise.resolve(platform);
    }

    ctx.registerTool('list_permissions', {
      description:
        'List all app permission statuses on the connected iOS simulator or Android emulator. Returns an object mapping service/permission → status.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe('Bundle ID (iOS) or package name (Android). Auto-detected if omitted.'),
      }),
      handler: async ({ platform, bundleId }) => {
        const p = await resolvePlatform(platform);
        if (!p) return 'No simulator/emulator detected.';

        const id = bundleId || (await detectBundleId(p));
        if (!id)
          return 'Bundle ID / package name required. Provide bundleId or ensure the app is running.';

        if (p === 'ios') {
          try {
            const output = await ctx.exec(
              `xcrun simctl privacy booted list "${id}" 2>/dev/null`
            );
            const permissions: Record<string, string> = {};
            for (const line of output.trim().split('\n')) {
              const match = line.match(/^\s*(\w+):\s*(\S+)/);
              if (match) permissions[match[1].toLowerCase()] = match[2].toLowerCase();
            }
            if (Object.keys(permissions).length === 0)
              return `No permissions found for "${id}". Make sure the app is installed on the booted simulator.`;
            return permissions;
          } catch (err) {
            return `Failed to list permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          try {
            const output = await ctx.exec(
              `adb shell dumpsys package "${id}" 2>/dev/null`
            );
            const permissions: Record<string, string> = {};
            // Parse all "android.permission.FOO: granted=true/false" entries
            const permRegex = /(android\.permission\.\w+):\s*granted=(\w+)/g;
            let match;
            while ((match = permRegex.exec(output)) !== null) {
              permissions[match[1]] = match[2] === 'true' ? 'granted' : 'denied';
            }
            if (Object.keys(permissions).length === 0)
              return `No permissions found for "${id}". Make sure the app is installed on the connected device.`;
            return permissions;
          } catch (err) {
            return `Failed to list permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      },
    });

    ctx.registerTool('grant_permission', {
      description:
        'Grant a permission to the app on the connected iOS simulator or Android emulator.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        service: z
          .string()
          .describe(
            'iOS: service name (e.g. "camera", "location"). Android: permission name (e.g. "CAMERA" or "android.permission.CAMERA").'
          ),
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe('Bundle ID (iOS) or package name (Android). Auto-detected if omitted.'),
      }),
      handler: async ({ service, platform, bundleId }) => {
        const p = await resolvePlatform(platform);
        if (!p) return 'No simulator/emulator detected.';

        const id = bundleId || (await detectBundleId(p));
        if (!id) return 'Bundle ID / package name required.';

        if (p === 'ios') {
          try {
            await ctx.exec(`xcrun simctl privacy booted grant "${service}" "${id}"`);
            return `Granted "${service}" permission to ${id} on iOS simulator.`;
          } catch (err) {
            return `Failed to grant permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          const perm = service.startsWith('android.permission.')
            ? service
            : `android.permission.${service.toUpperCase()}`;
          try {
            await ctx.exec(`adb shell pm grant "${id}" "${perm}"`);
            return `Granted "${perm}" to ${id} on Android device.`;
          } catch (err) {
            return `Failed to grant permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      },
    });

    ctx.registerTool('revoke_permission', {
      description:
        'Revoke a permission from the app on the connected iOS simulator or Android emulator.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        service: z
          .string()
          .describe(
            'iOS: service name (e.g. "camera", "location"). Android: permission name (e.g. "CAMERA" or "android.permission.CAMERA").'
          ),
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe('Bundle ID (iOS) or package name (Android). Auto-detected if omitted.'),
      }),
      handler: async ({ service, platform, bundleId }) => {
        const p = await resolvePlatform(platform);
        if (!p) return 'No simulator/emulator detected.';

        const id = bundleId || (await detectBundleId(p));
        if (!id) return 'Bundle ID / package name required.';

        if (p === 'ios') {
          try {
            await ctx.exec(`xcrun simctl privacy booted revoke "${service}" "${id}"`);
            return `Revoked "${service}" permission from ${id} on iOS simulator.`;
          } catch (err) {
            return `Failed to revoke permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          const perm = service.startsWith('android.permission.')
            ? service
            : `android.permission.${service.toUpperCase()}`;
          try {
            await ctx.exec(`adb shell pm revoke "${id}" "${perm}"`);
            return `Revoked "${perm}" from ${id} on Android device.`;
          } catch (err) {
            return `Failed to revoke permission: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      },
    });

    ctx.registerTool('reset_permissions', {
      description:
        'Reset one or all permissions for the app on the connected iOS simulator or Android emulator. On iOS, omitting service resets all services. On Android, omitting service resets all runtime permissions.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        service: z
          .string()
          .optional()
          .describe(
            'iOS: specific service to reset (e.g. "camera"); omit to reset all. Android: permission name (e.g. "CAMERA"); omit to reset all runtime permissions.'
          ),
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe('Bundle ID (iOS) or package name (Android). Auto-detected if omitted.'),
      }),
      handler: async ({ service, platform, bundleId }) => {
        const p = await resolvePlatform(platform);
        if (!p) return 'No simulator/emulator detected.';

        const id = bundleId || (await detectBundleId(p));
        if (!id) return 'Bundle ID / package name required.';

        if (p === 'ios') {
          const target = service ?? 'all';
          try {
            await ctx.exec(`xcrun simctl privacy booted reset "${target}" "${id}"`);
            return `Reset ${service ? `"${service}"` : 'all'} permissions for ${id} on iOS simulator.`;
          } catch (err) {
            return `Failed to reset permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          try {
            if (service) {
              const perm = service.startsWith('android.permission.')
                ? service
                : `android.permission.${service.toUpperCase()}`;
              await ctx.exec(`adb shell pm revoke "${id}" "${perm}"`);
              return `Reset "${perm}" for ${id} on Android device.`;
            } else {
              // pm reset-permissions is available on newer Android; fall back to pm clear
              try {
                await ctx.exec(`adb shell pm reset-permissions -p "${id}" 2>/dev/null`);
              } catch {
                await ctx.exec(`adb shell pm clear "${id}"`);
              }
              return `Reset all permissions for ${id} on Android device.`;
            }
          } catch (err) {
            return `Failed to reset permissions: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      },
    });

    ctx.registerTool('open_app_settings', {
      description:
        "Open the app's system settings page on the connected iOS simulator or Android emulator.",
      annotations: { destructiveHint: false },
      parameters: z.object({
        platform: z.enum(['ios', 'android', 'auto']).default('auto').describe('Target platform'),
        bundleId: z
          .string()
          .optional()
          .describe(
            'Bundle ID (iOS) or package name (Android). Auto-detected if omitted. Required for Android.'
          ),
      }),
      handler: async ({ platform, bundleId }) => {
        const p = await resolvePlatform(platform);
        if (!p) return 'No simulator/emulator detected.';

        if (p === 'ios') {
          try {
            await ctx.exec('xcrun simctl openurl booted app-settings:');
            return 'Opened app settings on iOS simulator.';
          } catch (err) {
            return `Failed to open app settings: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          const id = bundleId || (await detectBundleId(p));
          if (!id) return 'Package name required for Android. Provide bundleId.';
          try {
            await ctx.exec(
              `adb shell am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d "package:${id}"`
            );
            return `Opened app settings for ${id} on Android device.`;
          } catch (err) {
            return `Failed to open app settings: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      },
    });
  },
});
