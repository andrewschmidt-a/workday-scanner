import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { portal as legacyPortal } from './config.js';

function protect(input, decrypt = false) {
  if (process.platform !== 'win32') {
    throw new Error('Secret storage requires Windows DPAPI. No plaintext fallback is supported.');
  }
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Security
    $inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
    $outputBytes = [Security.Cryptography.ProtectedData]::${operation}(
      $inputBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($outputBytes))
  `;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.resume();
    child.on('error', () => reject(new Error('Could not start Windows secret encryption.')));
    child.stdin.on('error', () => reject(new Error('Could not send secret to Windows encryption.')));
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Windows secret ${decrypt ? 'decryption' : 'encryption'} failed.`));
        return;
      }
      resolve(Buffer.from(Buffer.concat(chunks).toString().trim(), 'base64'));
    });
    child.stdin.end(input.toString('base64'));
  });
}

async function saveSecret(directory, filename, value) {
  await mkdir(directory, { recursive: true });
  const encrypted = await protect(Buffer.from(JSON.stringify(value)));
  const temporary = join(directory, `${filename}.tmp`);
  await writeFile(temporary, encrypted, { mode: 0o600 });
  await rename(temporary, join(directory, filename));
}

async function readEncrypted(directory, filename, { optional = false, missingMessage }) {
  let encrypted;
  try {
    encrypted = await readFile(join(directory, filename));
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (optional) return undefined;
      throw new Error(missingMessage);
    }
    throw error;
  }
  return encrypted;
}

async function loadSecret(directory, filename, options) {
  const encrypted = await readEncrypted(directory, filename, options);
  return encrypted === undefined ? undefined : JSON.parse((await protect(encrypted, true)).toString());
}

export function saveSession(directory, state, portalUrl) {
  return saveSecret(directory, 'session.dpapi',
    portalUrl ? { portalUrl: new URL(portalUrl).href, state } : state);
}

export async function loadSession(directory, { optional = false, portalUrl, siteId, interactiveOnly = false } = {}) {
  const selector = siteId ? ` --site ${siteId}` : '';
  const saved = await loadSecret(directory, 'session.dpapi', {
    optional,
    missingMessage: interactiveOnly
      ? `No saved session. Run "npm.cmd start -- login${selector}" and complete Google sign-in in the browser.`
      : `No saved session. Run "npm.cmd start -- login${selector}" or "npm.cmd start -- credentials${selector}" first.`,
  });
  if (saved === undefined) return undefined;
  if (saved.portalUrl) {
    if (portalUrl && saved.portalUrl !== new URL(portalUrl).href) {
      throw new Error('Saved session belongs to a different site. Sign in again for this site.');
    }
    return saved.state;
  }
  if (portalUrl && new URL(portalUrl).href !== legacyPortal.url) {
    throw new Error('Saved session has no site binding. Sign in again for this site.');
  }
  return saved;
}

export function saveCredentials(directory, { username, password }, portalUrl) {
  if (typeof username !== 'string' || !username.trim() ||
      typeof password !== 'string' || !password.length) {
    throw new Error('Both an email address and a nonempty password are required.');
  }
  return saveSecret(directory, 'credentials.dpapi', {
    username: username.trim(), password,
    origin: new URL(portalUrl).origin, portalUrl: new URL(portalUrl).href,
  });
}

export async function loadCredentials(directory, portalUrl, { optional = false, siteId } = {}) {
  const selector = siteId ? ` --site ${siteId}` : '';
  const credentials = await loadSecret(directory, 'credentials.dpapi', {
    optional,
    missingMessage: `No saved credentials. Run "npm.cmd start -- credentials${selector}" first.`,
  });
  if (credentials === undefined) return undefined;
  return validateCredentials(credentials, portalUrl);
}

function validateCredentials(credentials, portalUrl) {
  if (credentials.origin !== new URL(portalUrl).origin ||
      (credentials.portalUrl
        ? credentials.portalUrl !== new URL(portalUrl).href
        : new URL(portalUrl).href !== legacyPortal.url) ||
      typeof credentials.username !== 'string' || !credentials.username.trim() ||
      typeof credentials.password !== 'string' || !credentials.password.length) {
    throw new Error('Saved credentials are invalid or belong to a different portal. Save them again.');
  }
  return credentials;
}

export async function loadBrowserCredentials(directory, portalUrl, blockedRevision) {
  const encrypted = await readEncrypted(directory, 'credentials.dpapi', {
    missingMessage: 'No saved credentials for this site.',
  });
  const revision = createHash('sha256').update(encrypted).digest('hex');
  if (revision === blockedRevision) return { state: 'blocked', revision };
  const credentials = validateCredentials(JSON.parse((await protect(encrypted, true)).toString()), portalUrl);
  return { state: 'ready', revision, credentials: { ...credentials, portalUrl: new URL(portalUrl).href } };
}

export async function forgetSession(directory) {
  await rm(join(directory, 'session.dpapi'), { force: true });
}

export async function forgetCredentials(directory) {
  await rm(join(directory, 'credentials.dpapi'), { force: true });
}
