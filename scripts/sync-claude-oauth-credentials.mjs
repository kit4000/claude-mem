#!/usr/bin/env node
import { execFileSync, spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { dirname, resolve } from 'path';
import { homedir, userInfo } from 'os';

const KEYCHAIN_SERVICE_NAME = 'Claude Code-credentials';
const DEFAULT_TARGET = '.docker-claude-code-credentials.json';
const DEFAULT_MIN_VALID_MS = 10 * 60 * 1000;
const DEFAULT_NOTIFY_MIN_INTERVAL_MS = 60 * 60 * 1000;

function usage() {
  return `
Usage:
  node scripts/sync-claude-oauth-credentials.mjs [options]

Options:
  --target <path>            Destination credentials file for Docker compose.
                             Default: ${DEFAULT_TARGET}
  --mirror <path>            Also write the same JSON to another path.
                             Can be repeated.
  --min-valid-ms <number>    Warn when token expires sooner than this.
                             Default: ${DEFAULT_MIN_VALID_MS}
  --notify-on-stale          Show a macOS notification when missing/stale.
  --notify-min-interval-ms <number>
                             Minimum interval between notifications.
                             Default: ${DEFAULT_NOTIFY_MIN_INTERVAL_MS}
  --quiet                    Only print errors.
  -h, --help                 Show this help.

The script copies the macOS Keychain entry for "${KEYCHAIN_SERVICE_NAME}" to
the target file with 0600 permissions. Existing files are updated in place so
Docker file bind mounts keep pointing at the same inode. It never prints token
values.
`.trim();
}

function parseArgs(argv) {
  const args = {
    target: DEFAULT_TARGET,
    mirrors: [],
    minValidMs: DEFAULT_MIN_VALID_MS,
    notifyOnStale: false,
    notifyMinIntervalMs: DEFAULT_NOTIFY_MIN_INTERVAL_MS,
    quiet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--target') {
      args.target = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--mirror') {
      args.mirrors.push(requireValue(argv, ++i, arg));
      continue;
    }
    if (arg === '--min-valid-ms') {
      const value = Number(requireValue(argv, ++i, arg));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--min-valid-ms must be a non-negative number');
      }
      args.minValidMs = value;
      continue;
    }
    if (arg === '--notify-on-stale') {
      args.notifyOnStale = true;
      continue;
    }
    if (arg === '--notify-min-interval-ms') {
      const value = Number(requireValue(argv, ++i, arg));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--notify-min-interval-ms must be a non-negative number');
      }
      args.notifyMinIntervalMs = value;
      continue;
    }
    if (arg === '--quiet') {
      args.quiet = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readKeychainRaw() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS Keychain sync is only available on darwin');
  }

  const username = userInfo().username;
  const attempts = [
    ['find-generic-password', '-s', KEYCHAIN_SERVICE_NAME, '-a', username, '-w'],
    ['find-generic-password', '-s', KEYCHAIN_SERVICE_NAME, '-w'],
  ];

  const errors = [];
  for (const args of attempts) {
    const result = spawnSync('security', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0 && result.stdout.trim().length > 0) {
      return result.stdout.trim();
    }
    errors.push(result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`);
  }

  throw new Error(`Unable to read "${KEYCHAIN_SERVICE_NAME}" from Keychain: ${errors.join(' | ')}`);
}

function parseCredentials(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Keychain payload is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const oauth = payload.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') {
    throw new Error('Keychain payload has no claudeAiOauth object');
  }
  if (typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) {
    throw new Error('Keychain payload has no claudeAiOauth.accessToken');
  }
  if (typeof oauth.refreshToken !== 'string' || oauth.refreshToken.length === 0) {
    throw new Error('Keychain payload has no claudeAiOauth.refreshToken');
  }

  const expiresAt = typeof oauth.expiresAt === 'number'
    ? oauth.expiresAt
    : decodeJwtExpMs(oauth.accessToken);
  if (expiresAt !== undefined && Date.now() > expiresAt) {
    throw staleError('Claude Code OAuth token is expired', expiresAt);
  }

  return {
    expiresAt,
    hasScopes: Array.isArray(oauth.scopes),
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
  };
}

function decodeJwtExpMs(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function staleError(message, expiresAt) {
  const error = new Error(message);
  error.stale = true;
  error.expiresAt = expiresAt;
  return error;
}

function writeCredentialsFile(path, raw) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });

  const previous = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
  const changed = previous !== raw;

  // Preserve the inode for Docker bind mounts. A rename-based atomic write can
  // make a file bind mount point at an unlinked inode until the container is
  // recreated.
  writeFileSync(absolute, raw, { encoding: 'utf8', mode: 0o600 });
  chmodSync(absolute, 0o600);

  return { path: absolute, changed };
}

function notify(message, key, minIntervalMs) {
  if (process.platform !== 'darwin') return;
  const statePath = resolve(homedir(), '.claude-mem', 'oauth-sync-notify-state.json');
  try {
    const state = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf8'))
      : {};
    const lastAt = typeof state[key] === 'number' ? state[key] : 0;
    if (Date.now() - lastAt < minIntervalMs) return;
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(statePath, JSON.stringify({ ...state, [key]: Date.now() }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Notification throttling is best effort; fall through to notify.
  }
  try {
    execFileSync('osascript', [
      '-e',
      `display notification ${JSON.stringify(message)} with title "claude-mem OAuth sync"`,
    ], { stdio: 'ignore', timeout: 3000 });
  } catch {
    // Notifications are best effort.
  }
}

function printResult(result, quiet) {
  if (quiet) return;
  console.log(JSON.stringify(result, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    const raw = readKeychainRaw();
    const parsed = parseCredentials(raw);
    const writes = [writeCredentialsFile(args.target, raw), ...args.mirrors.map((path) => writeCredentialsFile(path, raw))];
    const expiresInMs = parsed.expiresAt === undefined ? null : parsed.expiresAt - Date.now();
    const staleSoon = expiresInMs !== null && expiresInMs < args.minValidMs;

    if (staleSoon && args.notifyOnStale) {
      notify(
        'Claude Code OAuth token expires soon. Run claude auth login --claudeai if generation starts failing.',
        'expiringSoon',
        args.notifyMinIntervalMs,
      );
    }

    printResult({
      status: staleSoon ? 'synced-but-expiring-soon' : 'synced',
      expiresAtIso: parsed.expiresAt === undefined ? null : new Date(parsed.expiresAt).toISOString(),
      expiresInMinutes: expiresInMs === null ? null : Math.max(0, Math.round(expiresInMs / 60000)),
      subscriptionType: parsed.subscriptionType,
      hasScopes: parsed.hasScopes,
      writes,
    }, args.quiet);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (args.notifyOnStale && err.stale) {
      notify(
        'Claude Code OAuth token is expired. Run claude auth login --claudeai, then the sync agent will pick it up.',
        'expired',
        args.notifyMinIntervalMs,
      );
    }
    console.error(JSON.stringify({
      status: err.stale ? 'stale' : 'error',
      message: err.message,
      expiresAtIso: err.expiresAt === undefined ? null : new Date(err.expiresAt).toISOString(),
    }, null, 2));
    process.exit(err.stale ? 2 : 1);
  }
}

main();
