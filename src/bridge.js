import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadPortals, portalDirectory } from './config.js';
import { loadBrowserCredentials } from './vault.js';
import { credentialPageMatches } from './login-dom.js';
import { applicationKey } from './extract.js';
import { Store } from './store.js';

const maximumBody = 1024 * 1024;
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function authorize(request, token) {
  const supplied = request.headers.authorization;
  const expected = `Bearer ${token}`;
  if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw new RequestError(401, 'Pair the extension using the token shown in the bridge terminal.');
  }
}

async function readJSON(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
    throw new RequestError(415, 'Use application/json.');
  }
  return new Promise((resolve, reject) => {
    let length = 0;
    let oversized = false;
    const chunks = [];
    request.on('data', chunk => {
      if (oversized) return;
      length += chunk.length;
      if (length > maximumBody) {
        oversized = true;
        chunks.length = 0;
        reject(new RequestError(413, 'The collection exceeds the 1 MiB request limit.'));
      } else {
        chunks.push(chunk);
      }
    });
    request.once('end', () => {
      if (oversized) return;
      try {
        resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      } catch {
        reject(new RequestError(400, 'The request must contain valid UTF-8 JSON.'));
      }
    });
    request.once('error', () => reject(new RequestError(400, 'The collection request was interrupted.')));
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function string(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

export function validateCollection(body, sites) {
  if (!isObject(body) || Object.keys(body).some(key => !['site', 'pageUrl', 'applications', 'empty'].includes(key))) {
    throw new RequestError(400, 'Invalid collection fields. Send application data only, never cookies or credentials.');
  }
  const site = sites.find(item => item.id === body.site);
  if (!site || body.pageUrl !== site.url) {
    throw new RequestError(400, 'The collection must come from the registered site dashboard.');
  }
  if (!Array.isArray(body.applications) || body.applications.length > 5000 ||
      typeof body.empty !== 'boolean' || body.empty !== (body.applications.length === 0)) {
    throw new RequestError(400, 'Provide a complete application list or an explicit empty state.');
  }
  const keys = new Set();
  const applications = body.applications.map(value => {
    if (!isObject(value) || Object.keys(value).some(key =>
      !['title', 'status', 'url', 'applicationId', 'requisitionId'].includes(key)) ||
        !string(value.title, 1000) || !string(value.status, 2000) ||
        !(value.applicationId === null || string(value.applicationId, 200)) ||
        !(value.requisitionId === null || string(value.requisitionId, 200)) ||
        !(value.url === null || string(value.url, 8192))) {
      throw new RequestError(400, 'An application has invalid fields or is missing its exact status text.');
    }
    if (value.url !== null) {
      let url;
      try {
        url = new URL(value.url);
      } catch {
        throw new RequestError(400, 'An application URL is invalid.');
      }
      if (url.protocol !== 'https:' || url.origin !== new URL(site.url).origin ||
          !url.pathname.startsWith(new URL('.', site.url).pathname) || url.username || url.password) {
        throw new RequestError(400, 'Application links must belong to the selected Workday site.');
      }
    }
    const key = applicationKey(value);
    if (keys.has(key)) throw new RequestError(400, 'Duplicate application identities; no snapshot was saved.');
    keys.add(key);
    return { ...value, key };
  });
  return { site, applications };
}

export async function startBridge({
  directory, port = 8765, token = randomBytes(32).toString('hex'), logger = console.error,
  allowPasswordLogin = false,
}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid local bridge port.');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local pairing token.');
  const store = new Store(directory);
  const server = createServer((request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    void (async () => {
      if (request.headers.host !== `127.0.0.1:${request.socket.localPort}`) {
        throw new RequestError(403, 'The collector is available only through its loopback address.');
      }
      const origin = request.headers.origin;
      if (origin && !extensionOrigin.test(origin)) {
        throw new RequestError(403, 'Only the paired browser extension may access this collector.');
      }
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        if (origin && request.headers['access-control-request-private-network'] === 'true') {
          response.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET' && request.url === '/health') {
        send(200, { status: 'ok' });
        return;
      }
      authorize(request, token);
      if (request.method === 'GET' && request.url === '/sites') {
        send(200, { sites: await loadPortals(directory), passwordLoginEnabled: allowPasswordLogin });
      } else if (request.method === 'POST' && request.url === '/credentials') {
        if (!allowPasswordLogin) {
          throw new RequestError(403, 'Password login is disabled. Start the bridge with --allow-password-login to reuse saved Workday credentials.');
        }
        const body = await readJSON(request);
        const sites = await loadPortals(directory);
        if (!isObject(body) || Object.keys(body).some(key => !['site', 'pageUrl', 'blockedRevision'].includes(key)) ||
            typeof body.pageUrl !== 'string' || body.pageUrl.length > 8192 ||
            !(body.blockedRevision === undefined ||
              (typeof body.blockedRevision === 'string' && /^[a-f0-9]{64}$/.test(body.blockedRevision)))) {
          throw new RequestError(400, 'Invalid password-login request.');
        }
        const site = sites.find(site => site.id === body.site);
        if (!site || site.auth === 'google' || !credentialPageMatches(body.pageUrl, site.url)) {
          throw new RequestError(403, 'Passwords are released only for the registered password-based Workday dashboard or login page.');
        }
        let result;
        try {
          result = await loadBrowserCredentials(portalDirectory(directory, site.id), site.url, body.blockedRevision);
        } catch {
          throw new RequestError(409, `No usable saved credentials for ${site.name}. Run "npm.cmd start -- credentials --site ${site.id}" to save them again.`);
        }
        send(200, result);
      } else if (request.method === 'POST' && request.url === '/observations') {
        const { site, applications } = validateCollection(await readJSON(request), await loadPortals(directory));
        const snapshot = store.save(site.id, applications);
        send(200, { site: site.id, name: site.name, ...snapshot });
      } else if (request.method === 'POST' && request.url === '/checks') {
        const body = await readJSON(request);
        const sites = await loadPortals(directory);
        if (!isObject(body) || Object.keys(body).some(key => !['site', 'outcome', 'error'].includes(key)) ||
            !sites.some(site => site.id === body.site) ||
            !['failed', 'needs_user_action'].includes(body.outcome) || !string(body.error, 2000)) {
          throw new RequestError(400, 'Provide a registered site, a failed/action-required outcome, and a bounded error message.');
        }
        if (body.outcome === 'needs_user_action') store.requireAction(body.site, body.error);
        else store.fail(body.site, body.error);
        send(200, { site: body.site, outcome: body.outcome });
      } else {
        throw new RequestError(404, 'Unknown collector endpoint.');
      }
    })().catch(error => {
      request.resume();
      if (error instanceof RequestError) {
        send(error.status, { error: error.message });
      } else {
        logger(`Local collector failed: ${error.message}`);
        send(500, { error: 'The local collector failed. Check its terminal; no successful import is being reported.' });
      }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    store.close();
    throw new Error(`Could not start the local collector (${error.code || error.name}). Choose a different --port if it is in use.`);
  }
  const address = server.address();
  let closing;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    token,
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close(error => {
          store.close();
          if (error) reject(error);
          else resolve();
        });
      });
      return closing;
    },
  };
}
