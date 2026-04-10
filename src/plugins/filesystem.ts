import { z } from 'zod';
import { definePlugin } from '../plugin.js';

const MAX_BYTES_DEFAULT = 50 * 1024;  // 50 KB
const MAX_BYTES_CAP     = 1024 * 1024; // 1 MB

export const filesystemPlugin = definePlugin({
  name: 'filesystem',

  description:
    'Browse and read files in the app sandboxed directories ' +
    '(Documents, Library/Caches, temp). Supports iOS Simulator and Android.',

  async setup(ctx) {
    // ── Helpers ──────────────────────────────────────────────────────────────

    async function detectPlatform(): Promise<'ios' | 'android' | null> {
      try {
        const out = await ctx.exec('xcrun simctl list booted 2>/dev/null');
        if (out.includes('Booted')) return 'ios';
      } catch {}
      try {
        const out = await ctx.exec('adb devices 2>/dev/null');
        const connected = out
          .trim()
          .split('\n')
          .slice(1)
          .filter((l) => l.trim() && !l.startsWith('*'));
        if (connected.length > 0) return 'android';
      } catch {}
      return null;
    }

    /** Throw if the path contains ".." segments to prevent directory traversal. */
    function assertSafePath(p: string): void {
      if (p.split('/').includes('..')) {
        throw new Error('Directory traversal not allowed: ".." segments are forbidden');
      }
    }

    /** Return the iOS Simulator data-container root for the given bundle ID. */
    async function getIosContainer(bundleId: string): Promise<string> {
      const out = await ctx.exec(
        `xcrun simctl get_app_container booted "${bundleId}" data`
      );
      return out.trim();
    }

    interface FileEntry {
      name: string;
      path: string;
      isDirectory: boolean;
      size: number;
      modified: string;
    }

    /**
     * Parse `ls -la` output (macOS or Android busybox) into structured entries.
     * parentPath is the directory that was listed.
     */
    function parseLsOutput(output: string, parentPath: string): FileEntry[] {
      const base = parentPath.replace(/\/$/, '');
      const entries: FileEntry[] = [];
      for (const line of output.trim().split('\n')) {
        if (!line.trim() || line.startsWith('total ')) continue;
        // permissions  links  owner  group  size  date(3 tokens)  name
        const match = line.match(
          /^([dlrwxbcpst\-]{10}[+@.]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/
        );
        if (!match) continue;
        const [, perms, sizeStr, modified, name] = match;
        if (name === '.' || name === '..') continue;
        entries.push({
          name,
          path: `${base}/${name}`,
          isDirectory: perms.startsWith('d'),
          size: parseInt(sizeStr, 10),
          modified,
        });
      }
      return entries;
    }

    /**
     * Parse a single `ls -lad` line for get_file_info.
     * Returns structured metadata for the item at `itemPath`.
     */
    function parseFileInfoLine(
      output: string,
      itemPath: string
    ): FileEntry | null {
      for (const line of output.trim().split('\n')) {
        if (!line.trim() || line.startsWith('total ')) continue;
        const match = line.match(
          /^([dlrwxbcpst\-]{10}[+@.]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)/
        );
        if (!match) continue;
        const [, perms, sizeStr, modified] = match;
        const name = itemPath.split('/').filter(Boolean).pop() ?? itemPath;
        return {
          name,
          path: itemPath,
          isDirectory: perms.startsWith('d'),
          size: parseInt(sizeStr, 10),
          modified,
        };
      }
      return null;
    }

    // ── get_app_directories ───────────────────────────────────────────────────

    ctx.registerTool('get_app_directories', {
      description:
        'Get known app sandbox directory paths (documents, cache, temp, library). ' +
        'Returns absolute paths usable with list_directory and read_file.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        bundleId: z
          .string()
          .optional()
          .describe(
            'App bundle ID (iOS, e.g. com.example.app) or package name (Android). ' +
            'Required for iOS; used for Android private-directory resolution.'
          ),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ bundleId, platform }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        if (p === 'ios') {
          if (!bundleId) return { error: 'bundleId is required for iOS' };
          try {
            const root = await getIosContainer(bundleId);
            return {
              root,
              documents: `${root}/Documents`,
              library:   `${root}/Library`,
              cache:     `${root}/Library/Caches`,
              temp:      `${root}/tmp`,
            };
          } catch (err) {
            return {
              error: `Failed to get container path: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        // Android — try adb first, fall back to evalInApp
        if (bundleId) {
          try {
            const homeOut = await ctx.exec(
              `adb shell run-as "${bundleId}" sh -c 'echo $HOME' 2>/dev/null`
            );
            const home = homeOut.trim() || `/data/data/${bundleId}`;
            return {
              root:      home,
              documents: `${home}/files`,
              library:   home,
              cache:     `${home}/cache`,
              temp:      `${home}/cache`,
            };
          } catch {
            // fall through to evalInApp
          }
        }

        try {
          const result = await ctx.evalInApp(
            `(function() {
              try {
                var FS;
                try { FS = require('expo-file-system'); } catch(e) {}
                if (!FS) try { FS = require('react-native-fs'); } catch(e) {}
                if (FS) return {
                  documents: FS.documentDirectory  || FS.DocumentDirectoryPath  || null,
                  cache:     FS.cacheDirectory     || FS.CachesDirectoryPath    || null,
                  temp:      FS.cacheDirectory     || FS.TemporaryDirectoryPath || null,
                  library:   FS.libraryDirectory   || FS.LibraryDirectoryPath   || null,
                };
                return { error: 'expo-file-system and react-native-fs not available' };
              } catch(e) { return { error: e.message }; }
            })()`
          );
          return result;
        } catch (err) {
          return {
            error: `Failed to resolve app directories: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    // ── list_directory ────────────────────────────────────────────────────────

    ctx.registerTool('list_directory', {
      description:
        'List files and directories in an app sandbox path. ' +
        'Call get_app_directories first to obtain the root path.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        path: z
          .string()
          .optional()
          .describe(
            'Absolute directory path to list. ' +
            'Defaults to the app data container root (bundleId required).'
          ),
        bundleId: z
          .string()
          .optional()
          .describe(
            'App bundle ID (iOS) or package name (Android). ' +
            'Required when path is omitted; also used for Android run-as access.'
          ),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
        recursive: z
          .boolean()
          .default(false)
          .describe('Recursively list subdirectories (returns raw text)'),
      }),
      handler: async ({ path, bundleId, platform, recursive }) => {
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        let targetPath = path;
        if (!targetPath) {
          if (!bundleId) return { error: 'Provide either path or bundleId' };
          targetPath =
            p === 'ios'
              ? await getIosContainer(bundleId)
              : `/data/data/${bundleId}`;
        }

        assertSafePath(targetPath);

        try {
          const flags = recursive ? '-laR' : '-la';
          let output: string;

          if (p === 'ios') {
            output = await ctx.exec(`ls ${flags} "${targetPath}" 2>&1`);
          } else {
            const runAs = bundleId ? `run-as "${bundleId}" ` : '';
            output = await ctx.exec(
              `adb shell ${runAs}ls ${flags} "${targetPath}" 2>&1`
            );
          }

          if (recursive) return { path: targetPath, raw: output };
          return parseLsOutput(output, targetPath);
        } catch (err) {
          return {
            error: `Failed to list directory: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    // ── read_file ─────────────────────────────────────────────────────────────

    ctx.registerTool('read_file', {
      description:
        'Read the contents of a file from the app sandbox. ' +
        'Enforces a configurable size cap (default 50 KB, max 1 MB) to avoid flooding context.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        path: z.string().describe('Absolute path to the file'),
        bundleId: z
          .string()
          .optional()
          .describe('App package name (Android, for run-as access to private files)'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
        encoding: z
          .enum(['utf8', 'base64'])
          .default('utf8')
          .describe('Output encoding. Use base64 for binary files (images, SQLite, etc.)'),
        maxBytes: z
          .number()
          .default(MAX_BYTES_DEFAULT)
          .describe('Maximum bytes to read (default 50 KB, hard cap 1 MB)'),
      }),
      handler: async ({ path, bundleId, platform, encoding, maxBytes }) => {
        assertSafePath(path);
        const limit = Math.min(maxBytes, MAX_BYTES_CAP);
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        try {
          let content: string;

          if (p === 'ios') {
            if (encoding === 'base64') {
              content = await ctx.exec(`head -c ${limit} "${path}" | base64`);
            } else {
              content = await ctx.exec(`head -c ${limit} "${path}"`);
            }
          } else {
            const runAs = bundleId ? `run-as "${bundleId}" ` : '';
            if (encoding === 'base64') {
              content = await ctx.exec(
                `adb shell "${runAs}sh -c 'dd if=${path} bs=1 count=${limit} 2>/dev/null | base64'"`
              );
            } else {
              content = await ctx.exec(
                `adb shell ${runAs}dd if="${path}" bs=1 count=${limit} 2>/dev/null`
              );
            }
          }

          return { path, content, encoding, bytesLimitApplied: limit };
        } catch (err) {
          return {
            error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    // ── get_file_info ─────────────────────────────────────────────────────────

    ctx.registerTool('get_file_info', {
      description:
        'Get file or directory metadata: size, modification date, and whether it is a directory.',
      annotations: { readOnlyHint: true },
      parameters: z.object({
        path: z.string().describe('Absolute path to the file or directory'),
        bundleId: z
          .string()
          .optional()
          .describe('App package name (Android, for run-as)'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
      }),
      handler: async ({ path, bundleId, platform }) => {
        assertSafePath(path);
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        try {
          let output: string;
          if (p === 'ios') {
            output = await ctx.exec(`ls -lad "${path}" 2>&1`);
          } else {
            const runAs = bundleId ? `run-as "${bundleId}" ` : '';
            output = await ctx.exec(
              `adb shell ${runAs}ls -lad "${path}" 2>&1`
            );
          }

          const info = parseFileInfoLine(output, path);
          if (info) return info;
          // Fallback: return raw output if parsing failed
          return { path, raw: output.trim() };
        } catch (err) {
          return {
            error: `Failed to get file info: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });

    // ── delete_file ───────────────────────────────────────────────────────────

    ctx.registerTool('delete_file', {
      description:
        'Delete a file from the app sandbox. ' +
        'Requires confirm: true to prevent accidental deletion.',
      annotations: { destructiveHint: true },
      parameters: z.object({
        path: z.string().describe('Absolute path to the file to delete'),
        bundleId: z
          .string()
          .optional()
          .describe('App package name (Android, for run-as)'),
        platform: z.enum(['ios', 'android', 'auto']).default('auto'),
        confirm: z
          .boolean()
          .describe('Must be set to true to confirm the deletion'),
      }),
      handler: async ({ path, bundleId, platform, confirm }) => {
        if (!confirm) {
          return {
            error: 'Deletion not confirmed. Pass confirm: true to proceed.',
          };
        }
        assertSafePath(path);
        const p = platform === 'auto' ? await detectPlatform() : platform;
        if (!p) return { error: 'No simulator/emulator detected' };

        try {
          if (p === 'ios') {
            await ctx.exec(`rm -f "${path}"`);
          } else {
            const runAs = bundleId ? `run-as "${bundleId}" ` : '';
            await ctx.exec(`adb shell ${runAs}rm "${path}"`);
          }
          return { success: true, deleted: path };
        } catch (err) {
          return {
            error: `Failed to delete file: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    });
  },
});
