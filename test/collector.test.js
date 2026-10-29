import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { chromium } from 'playwright';
import { startBridge } from '../src/bridge.js';
import { validatePortal, defaultPortals } from '../src/config.js';
import { checkSite, checkSites, BrowserCollectionRequired } from '../src/tracker.js';
import { Store } from '../src/store.js';
import { dashboardMatches, collectTab } from '../browser-extension/collector.js';
import {
  possibleSignInPage, googleEntryMatches, googleEntryStep, startGoogleSignIn,
} from '../browser-extension/signin.js';
import { extractPage } from '../src/extract.js';

const site = {
  id: 'example',
  name: 'Example',
  url: 'https://example.wd1.myworkdayjobs.com/en-US/Careers/userHome',
  auth: 'google',
  collection: 'browser',
};
const application = {
  title: 'Fixture Role',
  status: 'In  Process\nReview pending',
  url: 'https://example.wd1.myworkdayjobs.com/en-US/Careers/job/Fixture-Role_R123',
  applicationId: null,
  requisitionId: 'R123',
};
const payload = { site: site.id, pageUrl: site.url, applications: [application], empty: false };
const allowedOrigin = `chrome-extension://${'a'.repeat(32)}`;

async function temporary(action) {
  const directory = await mkdtemp(join(tmpdir(), 'workday-collector-'));
  try {
    await writeFile(join(directory, 'sites.json'), JSON.stringify([site]));
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withBridge(action) {
  return temporary(async directory => {
    const bridge = await startBridge({ directory, port: 0 });
    try {
      const call = (path, body, headers = {}) => fetch(`${bridge.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${bridge.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return await action({ bridge, directory, call });
    } finally {
      await bridge.close();
    }
  });
}

function command(directory, ...args) {
  return execFileSync(process.execPath, ['src\\cli.js', ...args], {
    encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, WORKDAY_TRACKER_HOME: directory },
  });
}

async function waitForExtension(page, predicate, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

test('browser collection is explicit and dashboard matching enforces employer and tenant', () => {
  assert.deepEqual(validatePortal(site), site);
  assert.throws(() => validatePortal({ ...site, collection: 'unknown' }), /collection must be/);
  assert.equal(dashboardMatches(`${site.url}?ignored=1#applications`, site), true);
  for (const url of [
    site.url.replace('https:', 'http:'),
    site.url.replace('Careers', 'OtherEmployer'),
    site.url.replace('example.wd1', 'other.wd1'),
    'https://accounts.google.com/',
    'https://wd1-identity.myworkday.com/',
    undefined,
  ]) assert.equal(dashboardMatches(url, site), false);
});

test('automatic Google entry is restricted to registered Google browser dashboard/login routes', () => {
  const login = new URL('login', site.url).href;
  assert.equal(possibleSignInPage(login), true);
  assert.equal(googleEntryMatches(login, site), true);
  assert.equal(googleEntryMatches(site.url, site), true);
  for (const url of [
    'https://accounts.google.com/',
    'https://wd1-identity.myworkday.com/',
    site.url.replace('Careers', 'Other'),
    login.replace('example.wd1', 'unregistered.wd1'),
    login.replace('https:', 'http:'),
    site.url.replace('userHome', 'job/fixture'),
  ]) assert.equal(googleEntryMatches(url, site), false);
  for (const url of [
    undefined, 'https://accounts.google.com/login',
    'https://example.myworkdayjobs.com.attacker.invalid/login',
    'https://myworkdayjobs.com/login', 'http://example.myworkdayjobs.com/login',
  ]) assert.equal(possibleSignInPage(url), false);
  assert.equal(googleEntryMatches(login, { ...site, auth: 'password' }), false);
  assert.equal(googleEntryMatches(login, { ...site, collection: 'playwright' }), false);
});

function signInAPI() {
  const stored = {};
  const state = {
    url: new URL('login', site.url).href, phase: 'google',
    snapshot: { applications: [], empty: true, problems: [], loading: false },
    clicks: [], stored,
  };
  const api = {
    tabs: { get: async () => ({ url: state.url }) },
    storage: {
      session: {
        get: async key => ({ [key]: stored[key] }),
        set: async value => Object.assign(stored, value),
        remove: async key => { delete stored[key]; },
      },
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        if (func.name === extractPage.name) return [{ result: state.snapshot }];
        assert.equal(func, googleEntryStep);
        const action = args[1];
        if (action === 'probe') return [{ result: { state: state.phase } }];
        const marker = stored[`google-entry:1:${site.id}`];
        assert.equal(marker.portalUrl, site.url);
        assert.equal(marker.stage, action === 'open' ? 'opened' : 'clicked');
        state.clicks.push(action);
        state.phase = 'google';
        return [{ result: { state: action === 'open' ? 'opened' : 'clicked' } }];
      },
    },
  };
  return { api, state };
}

test('automatic entry persists its one-attempt guard before clicking and resets only after authentication', async () => {
  const { api, state } = signInAPI();
  assert.equal((await startGoogleSignIn(1, site, api)).state, 'clicked');
  assert.deepEqual(state.clicks, ['google']);
  assert.equal((await startGoogleSignIn(1, site, api)).state, 'manual');
  assert.deepEqual(state.clicks, ['google']);
  state.url = site.url;
  assert.equal((await startGoogleSignIn(1, site, api)).state, 'authenticated');
  assert.deepEqual(state.stored, {});
  state.url = new URL('login', site.url).href;
  assert.equal((await startGoogleSignIn(1, site, api)).state, 'clicked');
  assert.deepEqual(state.clicks, ['google', 'google']);
});

test('automatic entry opens Workday Sign In once but never interacts with Google pages', async () => {
  const { api, state } = signInAPI();
  state.phase = 'entry';
  assert.equal((await startGoogleSignIn(1, site, api)).state, 'clicked');
  assert.deepEqual(state.clicks, ['open', 'google']);
  state.url = 'https://accounts.google.com/';
  api.scripting.executeScript = async () => assert.fail('Google must never be injected.');
  assert.equal((await startGoogleSignIn(1, site, api)).state, 'left');
});

test('a navigation between detecting Google and clicking it prevents injection and further retries', async () => {
  const { api, state } = signInAPI();
  const save = api.storage.session.set;
  api.storage.session.set = async value => {
    await save(value);
    state.url = 'https://accounts.google.com/';
  };
  await assert.rejects(startGoogleSignIn(1, site, api), /tab left/);
  assert.deepEqual(state.clicks, []);
  state.url = new URL('login', site.url).href;
  assert.equal((await startGoogleSignIn(1, site, api)).state, 'manual');
});

test('a normal dashboard-to-login redirect only retries the DOM read, not the Google click', async () => {
  const { api, state } = signInAPI();
  state.url = site.url;
  const execute = api.scripting.executeScript;
  api.scripting.executeScript = async options => {
    if (options.func.name === extractPage.name) {
      state.url = new URL('login', site.url).href;
      throw new Error('Registered dashboard navigated to login during DOM read.');
    }
    return execute(options);
  };
  assert.equal((await startGoogleSignIn(1, site, api)).state, 'clicked');
  assert.deepEqual(state.clicks, ['google']);
});

test('bridge requires pairing, refuses website origins, and reveals no data in health', async () => {
  await withBridge(async ({ bridge, call }) => {
    let response = await fetch(`${bridge.url}/health`);
    assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    response = await fetch(`${bridge.url}/sites`);
    assert.equal(response.status, 401);
    assert.equal((await call('/sites', undefined, { Authorization: `Bearer ${'b'.repeat(64)}` })).status, 401);
    for (const origin of [
      'https://example.wd1.myworkdayjobs.com',
      'https://accounts.google.com',
      'http://127.0.0.1',
      'chrome-extension://not-an-extension',
    ]) assert.equal((await call('/sites', undefined, { Origin: origin })).status, 403);
    response = await call('/sites', undefined, { Origin: allowedOrigin });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), allowedOrigin);
    assert.deepEqual((await response.json()).sites.map(value => value.id), ['3m', 'wells-fargo', site.id]);
    response = await fetch(`${bridge.url}/observations`, {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
    assert.equal((await call('/missing')).status, 404);
    const rebound = await new Promise((resolveResponse, reject) => {
      const request = httpRequest(`${bridge.url}/health`, {
        headers: { Host: 'attacker.invalid' },
      }, response => {
        response.resume();
        resolveResponse(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(rebound, 403);
  });
});

test('bridge imports exact status text, change history, explicit empty state, and isolated reports', async () => {
  await withBridge(async ({ call, directory }) => {
    let response = await call('/observations', payload);
    assert.equal(response.status, 200);
    let result = await response.json();
    assert.equal(result.applications[0].status, application.status);
    assert.equal(result.applications[0].requisitionId, 'R123');
    response = await call('/observations', {
      ...payload, applications: [{ ...application, status: 'Under Consideration' }],
    });
    result = await response.json();
    assert.deepEqual(result.changes, [{
      title: application.title, previousStatus: application.status, status: 'Under Consideration',
    }]);
    const report = JSON.parse(command(directory, 'report', '--json'));
    assert.equal(report.sites.find(value => value.site === site.id).lastSuccessfulCheck.applications[0].status,
      'Under Consideration');
    assert.ok(report.sites.filter(value => value.site !== site.id).every(value => value.lastSuccessfulCheck === null));
    const store = new Store(directory);
    try {
      assert.deepEqual(store.history(site.id).map(value => value.status), [application.status, 'Under Consideration']);
    } finally {
      store.close();
    }
    response = await call('/observations', { ...payload, applications: [], empty: true });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).applications, []);
  });
});

test('scheduled failure outcomes require pairing and preserve the last successful snapshot', async () => {
  await withBridge(async ({ call, bridge, directory }) => {
    assert.equal((await call('/observations', payload)).status, 200);
    const failed = { site: site.id, outcome: 'needs_user_action', error: 'Sign in in Edge.' };
    assert.equal((await fetch(`${bridge.url}/checks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(failed),
    })).status, 401);
    for (const body of [
      null, {}, { ...failed, site: 'unknown' }, { ...failed, outcome: 'success' },
      { ...failed, error: '' }, { ...failed, error: 'x'.repeat(2001) }, { ...failed, cookies: [] },
    ]) assert.equal((await call('/checks', body)).status, 400);
    assert.equal((await call('/checks', failed)).status, 200);
    let report = JSON.parse(command(directory, 'report', '--site', site.id, '--json'));
    assert.equal(report.latestCheck.outcome, 'needs_user_action');
    assert.equal(report.lastSuccessfulCheck.applications[0].status, application.status);
    assert.equal((await call('/checks', { ...failed, outcome: 'failed', error: 'Unrecognized layout.' })).status, 200);
    report = JSON.parse(command(directory, 'report', '--site', site.id, '--json'));
    assert.equal(report.latestCheck.outcome, 'failed');
    assert.equal(report.lastSuccessfulCheck.applications[0].status, application.status);
  });
});

test('invalid or incomplete snapshots never replace saved application data', async () => {
  await withBridge(async ({ call, directory }) => {
    assert.equal((await call('/observations', payload)).status, 200);
    const invalid = [
      null, [], {}, { ...payload, site: 'unregistered' },
      { ...payload, pageUrl: site.url.replace('Careers', 'Other') },
      { ...payload, applications: [], empty: false },
      { ...payload, empty: true },
      { ...payload, applications: [application, application] },
      { ...payload, cookies: [] },
      ...[
        { status: ' ' }, { title: '' }, { status: 12 }, { status: 'x'.repeat(2001) },
        { requisitionId: undefined }, { applicationId: 7 }, { key: 'id:injected' },
        { url: 'not a URL' }, { url: 'https://accounts.google.com/' },
        { url: 'http://example.wd1.myworkdayjobs.com/job/fixture' },
        { url: 'https://example.wd1.myworkdayjobs.com/en-US/Other/job/fixture' },
      ].map(value => ({ ...payload, applications: [{ ...application, ...value }] })),
    ];
    for (const value of invalid) {
      const response = await call('/observations', value);
      assert.equal(response.status, 400, JSON.stringify(value));
    }
    const store = new Store(directory);
    try {
      assert.equal(store.history(site.id).length, 1);
      assert.equal(store.latest(site.id).applications[0].status, application.status);
    } finally {
      store.close();
    }
  });
});

test('bridge rejects malformed, wrong-content-type, and oversized payloads including chunked requests', async () => {
  await withBridge(async ({ bridge, call }) => {
    assert.equal((await call('/observations', payload, { 'Content-Type': 'text/plain' })).status, 415);
    const headers = { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' };
    const malformed = await fetch(`${bridge.url}/observations`, {
      method: 'POST', headers, body: '{',
    });
    assert.equal(malformed.status, 400);
    const oversized = await fetch(`${bridge.url}/observations`, {
      method: 'POST', headers, body: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    const chunked = await new Promise((resolveResponse, reject) => {
      const request = httpRequest(`${bridge.url}/observations`, { method: 'POST', headers }, response => {
        response.resume();
        resolveResponse(response.statusCode);
      });
      request.on('error', reject);
      for (let index = 0; index < 17; index++) request.write(Buffer.alloc(65536, 120));
      request.end();
    });
    assert.equal(chunked, 413);
    assert.equal((await fetch(`${bridge.url}/health`)).status, 200);
  });
});

test('browser checks require action without launching login or replacing last successful observations', async () => {
  await temporary(async directory => {
    const store = new Store(directory);
    try {
      store.save(site.id, [{ ...application, key: 'req:R123' }]);
    } finally {
      store.close();
    }
    await assert.rejects(checkSite(site, { directory }), BrowserCollectionRequired);
    const report = JSON.parse(command(directory, 'report', '--site', site.id, '--json'));
    assert.equal(report.latestCheck.outcome, 'needs_user_action');
    assert.equal(report.lastSuccessfulCheck.applications[0].status, application.status);
    const results = await checkSites([site, defaultPortals[0]], { directory }, async (value, options) => {
      if (value.id === site.id) return checkSite(value, options);
      return { applications: [], checkedAt: 'fixture' };
    });
    assert.deepEqual(results.map(value => value.outcome), ['needs_user_action', 'success']);
    assert.throws(() => command(directory, 'check', '--site', site.id), /normal Edge/);
    assert.throws(() => command(directory, 'credentials', '--site', site.id), /No password is collected/);
    assert.throws(() => command(directory, 'check', '--all', '--json'), error => {
      assert.equal(error.status, 1);
      const { sites } = JSON.parse(error.stdout);
      assert.equal(sites.find(value => value.site === site.id).outcome, 'needs_user_action');
      return true;
    });
  });
});

test('pairing rotates, occupied ports fail clearly, and bridge shutdown is repeatable', async () => {
  await withBridge(async ({ bridge, directory }) => {
    await assert.rejects(startBridge({ directory, port: bridge.port }), /Could not start the local collector.*EADDRINUSE/);
    const another = await startBridge({ directory, port: 0 });
    try {
      assert.notEqual(another.token, bridge.token);
      const response = await fetch(`${another.url}/sites`, {
        headers: { Authorization: `Bearer ${bridge.token}` },
      });
      assert.equal(response.status, 401);
    } finally {
      await another.close();
      await another.close();
    }
  });
});

test('extension permissions exclude cookies, Google, and identity-provider hosts', async () => {
  const root = resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(join(root, 'browser-extension', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['scripting', 'storage', 'alarms']);
  assert.deepEqual(manifest.host_permissions, [
    'https://*.myworkdayjobs.com/*', 'https://*.myworkdaysite.com/*', 'http://127.0.0.1/*',
  ]);
  assert.equal(await readFile(join(root, 'browser-extension', 'shared', 'extract.js'), 'utf8'),
    await readFile(join(root, 'src', 'extract.js'), 'utf8'));
  assert.equal(await readFile(join(root, 'browser-extension', 'shared', 'login-dom.js'), 'utf8'),
    await readFile(join(root, 'src', 'login-dom.js'), 'utf8'));
  let injected = false;
  await assert.rejects(collectTab(1, site, {
    tabs: { get: async () => ({ url: 'https://accounts.google.com/' }) },
    scripting: { executeScript: async () => { injected = true; } },
  }), /tab changed/);
  assert.equal(injected, false);
});

test('real extension automatically clicks Workday Google entry, handles delayed controls, and does not loop', { timeout: 60_000 }, async () => {
  await withBridge(async ({ bridge, directory }) => {
    const extension = resolve(import.meta.dirname, '..', 'browser-extension');
    const profile = await mkdtemp(join(tmpdir(), 'workday-auto-signin-'));
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).hostname;
      const login = new URL('login', site.url).href;
      const probe = await context.newPage();
      await probe.route('**/*', route => route.fulfill({
        contentType: 'text/html', body: '<h1>Sign In fixture</h1>',
      }));
      await probe.goto(login);
      await probe.setContent('<button data-automation-id="GoogleSignInButton">Sign in with Google</button>');
      assert.equal((await probe.evaluate(googleEntryStep, site.url)).state, 'google');
      await probe.setContent('<button disabled data-automation-id="GoogleSignInButton">Sign in with Google</button>');
      assert.equal((await probe.evaluate(googleEntryStep, site.url)).state, 'waiting');
      await probe.setContent('<form><input type="password"><button type="submit">Sign In</button></form>');
      assert.equal((await probe.evaluate(googleEntryStep, site.url)).state, 'waiting');
      await probe.setContent('<button>Sign in with Google</button><button>Sign in with Google</button>');
      await assert.rejects(probe.evaluate(googleEntryStep, site.url), /Multiple Google/);
      await probe.setContent(`<button data-automation-id="GoogleSignInButton">Sign in with Google</button>
        <div style="position:fixed;inset:0;background:white;z-index:10">Cookie consent fixture</div>`);
      assert.equal((await probe.evaluate(googleEntryStep, site.url)).state, 'blocked');
      await probe.goto(site.url.replace('Careers', 'Other'));
      await assert.rejects(probe.evaluate(googleEntryStep, site.url), /left the registered/);
      await probe.close();
      const dashboard = await context.newPage();
      const providerButton = `<button data-automation-id="GoogleSignInButton"
        onclick="localStorage.setItem('googleClicks', String(Number(localStorage.getItem('googleClicks') || 0) + 1))">Sign in with Google</button>`;
      await dashboard.route('**/*', route => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><h1>Sign In</h1><main id="auth"></main>
          <script>setTimeout(() => {
            const entry = document.createElement('button');
            entry.id = 'entry';
            entry.textContent = 'Sign In';
            entry.onclick = () => {
              localStorage.setItem('entryClicks', String(Number(localStorage.getItem('entryClicks') || 0) + 1));
              document.getElementById('auth').innerHTML = ${JSON.stringify(providerButton)};
            };
            document.getElementById('auth').append(entry);
          }, 600);</script>`,
      }));
      await dashboard.goto(login);
      assert.equal(await dashboard.evaluate(() => localStorage.getItem('googleClicks')), null);
      await worker.evaluate(async settings => chrome.storage.local.set(settings), {
        port: bridge.port, token: bridge.token, hourlyEnabled: false,
      });
      await dashboard.waitForFunction(() => localStorage.getItem('googleClicks') === '1');
      assert.equal(await dashboard.evaluate(() => localStorage.getItem('entryClicks')), '1');
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForFunction(() =>
        /Clicked Example|already attempted/.test(document.getElementById('status').textContent));
      await dashboard.reload();
      await dashboard.waitForSelector('#entry');
      await waitForExtension(popup, async () => {
        const { lastResult } = await chrome.storage.local.get('lastResult');
        return lastResult?.message.includes('already attempted');
      }, 'the no-retry notice');
      await popup.waitForFunction(() =>
        document.getElementById('status').textContent.includes('already attempted'));
      const { version } = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
      assert.ok((await popup.locator('#connection').innerText()).startsWith(`Version ${version}.`));
      assert.equal(await dashboard.evaluate(() => localStorage.getItem('googleClicks')), '1');
      assert.equal(await dashboard.evaluate(() => localStorage.getItem('entryClicks')), '1');
      await dashboard.bringToFront();
      const connection = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'signin-status' }));
      assert.equal(connection.ok, true, connection.message);
      assert.match(connection.message, /Example is registered/);
      const notCollected = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'collect' }));
      assert.equal(notCollected.ok, false);
      assert.match(notCollected.message, /sign-in is still required/);

      await dashboard.unroute('**/*');
      await dashboard.route('**/*', route => route.fulfill({
        contentType: 'text/html',
        body: '<h1>My Applications</h1><p>You have no applications</p>',
      }));
      await dashboard.goto(site.url);
      await waitForExtension(popup, async () => {
        const markers = await chrome.storage.session.get(null);
        return !Object.keys(markers).some(key => key.startsWith('google-entry:'));
      }, 'authentication to clear the attempt marker');
      await dashboard.unroute('**/*');
      await dashboard.route('**/*', route => route.fulfill({
        contentType: 'text/html', body: providerButton,
      }));
      await dashboard.goto(login);
      await dashboard.waitForFunction(() => localStorage.getItem('googleClicks') === '2').catch(async error => {
        const detail = await popup.evaluate(async () => ({
          ...(await chrome.storage.local.get('lastResult')),
          markers: await chrome.storage.session.get(null),
        }));
        const pageState = await dashboard.evaluate(() => ({
          path: location.pathname, count: localStorage.getItem('googleClicks'),
          buttons: [...document.querySelectorAll('button')].map(button => button.textContent),
        }));
        throw new Error(`Automatic entry did not resume after authentication: ${JSON.stringify({ ...detail, pageState })}`, { cause: error });
      });
      await dashboard.goto('https://unregistered.wd1.myworkdayjobs.com/en-US/Careers/login');
      await dashboard.waitForSelector('[data-automation-id="GoogleSignInButton"]');
      await dashboard.waitForTimeout(1000);
      assert.equal(await dashboard.evaluate(() => localStorage.getItem('googleClicks')), null);
      const store = new Store(directory);
      try {
        assert.equal(store.report(site.id).latestCheck, null);
      } finally {
        store.close();
      }
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
});

test('real unpacked extension paginates fixtures, imports exact statuses, and refuses Google', { timeout: 60_000 }, async () => {
  await withBridge(async ({ bridge, directory }) => {
    const extension = resolve(import.meta.dirname, '..', 'browser-extension');
    const profile = await mkdtemp(join(tmpdir(), 'workday-extension-profile-'));
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).hostname;
      assert.match(extensionId, /^[a-p]{32}$/);
      await worker.evaluate(async settings => {
        await chrome.storage.local.set(settings);
      }, { port: bridge.port, token: bridge.token, hourlyEnabled: false });
      const dashboard = await context.newPage();
      await dashboard.route('**/*', route => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><h1>My Applications</h1>
          <table><thead><tr><th>Job Title</th><th>Job Req</th><th>My Application Status</th></tr></thead>
          <tbody><tr><th>Fixture Role</th><td>R123</td><td style="white-space: pre-wrap">In  Process<br>Review pending</td></tr></tbody></table>
          <button aria-label="Next page" onclick="document.querySelector('tbody').innerHTML =
            '<tr><th>Another Role</th><td>R456</td><td>Application Received</td></tr>'; this.disabled = true">Next</button>`,
      }));
      await dashboard.goto(site.url);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await dashboard.bringToFront();
      const result = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'collect' }));
      assert.equal(result.ok, true, result.message);
      assert.match(result.message, /Saved 2 application/);
      let store = new Store(directory);
      try {
        assert.deepEqual(store.latest(site.id).applications.map(value => [value.requisitionId, value.status]), [
          ['R123', application.status], ['R456', 'Application Received'],
        ]);
      } finally {
        store.close();
      }
      const google = await context.newPage();
      await google.route('**/*', route => route.fulfill({
        contentType: 'text/html', body: '<h1>Google sign-in fixture</h1>',
      }));
      await google.goto('https://accounts.google.com/');
      await google.bringToFront();
      const rejected = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'collect' }));
      assert.equal(rejected.ok, false);
      assert.match(rejected.message, /Google and identity-provider pages are not read/);
      await dashboard.bringToFront();
      await dashboard.evaluate(() => { document.body.innerHTML = '<p>Unrecognized layout</p>'; });
      const invalid = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'collect' }));
      assert.equal(invalid.ok, false);
      assert.match(invalid.message, /No recognizable application list/);
      store = new Store(directory);
      try {
        assert.equal(store.history(site.id).length, 2);
      } finally {
        store.close();
      }
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });
});
