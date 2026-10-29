import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { startBridge } from '../src/bridge.js';
import { defaultPortals, portalDirectory } from '../src/config.js';
import { saveCredentials } from '../src/vault.js';
import { Store } from '../src/store.js';
import { credentialPageMatches } from '../src/login-dom.js';

const [site, wells] = defaultPortals;
const synthetic = { username: 'fixture@example.invalid', password: 'Synthetic fixture password!' };
const form = `<form onsubmit="return false">
  <label>Email Address<input type="email" data-automation-id="email"></label>
  <label>Password<input type="password"></label>
  <div style="position:relative;width:200px;height:40px">
    <button aria-hidden="true" style="position:absolute;inset:0">Sign In</button>
    <div role="button" aria-label="Sign In" tabindex="0" style="position:absolute;inset:0"></div>
  </div></form>`;
const dashboard = `<table><thead><tr><th>Job Title</th><th>Job Req</th><th>Status</th></tr></thead>
  <tbody><tr><th scope="row">Fixture Engineer</th><td>REQ-1</td>
  <td style="white-space:pre-wrap">In  Process<br>Exact wording</td></tr></tbody></table>`;

async function waitFor(action, description) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

test('password bridge is opt-in, authenticated, portal-bound, revision-blocked, and excludes Google', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workday-password-api-'));
  let bridge;
  try {
    const google = { id: 'google', name: 'Google fixture', url: site.url.replace('Search', 'Google'), auth: 'google' };
    const sibling = { id: 'sibling', name: 'Sibling fixture', url: site.url.replace('Search', 'Other'), collection: 'browser' };
    await writeFile(join(directory, 'sites.json'), JSON.stringify([google, sibling]));
    const command = (...args) => execFileSync(process.execPath, ['src\\cli.js', ...args], {
      encoding: 'utf8', stdio: 'pipe', env: { ...process.env, WORKDAY_TRACKER_HOME: directory },
    });
    assert.throws(() => command('credentials', '--site', sibling.id), /requires an interactive terminal/);
    assert.throws(() => command('sites', '--allow-password-login'), /apply only to the bridge command/);
    await saveCredentials(directory, synthetic, site.url);
    await saveCredentials(portalDirectory(directory, wells.id),
      { username: 'other@example.invalid', password: 'Different fixture password!' }, wells.url);
    const call = (body, headers = {}) => fetch(`${bridge.url}/credentials`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const body = { site: site.id, pageUrl: site.url };
    bridge = await startBridge({ directory, port: 0 });
    assert.equal((await call(body)).status, 403);
    await bridge.close();
    bridge = await startBridge({ directory, port: 0, allowPasswordLogin: true });
    assert.equal((await call(body, { Authorization: '' })).status, 401);
    assert.equal((await call(body, { Origin: 'https://example.invalid' })).status, 403);
    for (const bad of [
      { ...body, site: google.id, pageUrl: google.url },
      { ...body, site: 'unknown' },
      { ...body, pageUrl: wells.url },
      { ...body, pageUrl: sibling.url },
      { ...body, pageUrl: site.url.replace('https:', 'http:') },
      { ...body, pageUrl: site.url.replace('userHome', 'job/fixture') },
    ]) assert.equal((await call(bad)).status, 403);
    for (const bad of [
      { ...body, extra: true }, { ...body, blockedRevision: [] }, { ...body, blockedRevision: 'bad' },
      { ...body, pageUrl: [site.url] },
    ]) assert.equal((await call(bad)).status, 400);
    assert.equal(credentialPageMatches(new URL('login', site.url).href, site.url), true);
    const response = await call(body, { Origin: `chrome-extension://${'a'.repeat(32)}` });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const ready = await response.json();
    assert.equal(ready.state, 'ready');
    assert.deepEqual(ready.credentials, { ...synthetic, origin: new URL(site.url).origin, portalUrl: site.url });
    const blocked = await (await call({ ...body, blockedRevision: ready.revision })).json();
    assert.deepEqual(blocked, { state: 'blocked', revision: ready.revision });
    await saveCredentials(directory, synthetic, site.url);
    const changed = await (await call({ ...body, blockedRevision: ready.revision })).json();
    assert.equal(changed.state, 'ready');
    assert.notEqual(changed.revision, ready.revision);
    const other = await (await call({ site: wells.id, pageUrl: new URL('login', wells.url).href })).json();
    assert.equal(other.credentials.username, 'other@example.invalid');
    const missing = await call({ site: sibling.id, pageUrl: sibling.url });
    assert.equal(missing.status, 409);
    assert.match((await missing.json()).error, /save them again/);
    await writeFile(join(directory, 'credentials.dpapi'), 'invalid synthetic ciphertext');
    const invalid = await call(body);
    assert.equal(invalid.status, 409);
    assert.doesNotMatch(JSON.stringify(await invalid.json()), /ciphertext|fixture@example|Synthetic fixture/);
  } finally {
    await bridge?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('password DOM actions scope forms, commit values, block duplicate fetch/XHR/native POSTs, and restore manual control', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let posts = 0;
  try {
    await page.route('**/*', route => {
      if (route.request().method() === 'POST') posts++;
      return route.fulfill({ contentType: 'text/html', body: route.request().method() === 'POST' ? 'ok' : form });
    });
    await page.goto(site.url);
    const source = await readFile(new URL('../src/login-dom.js', import.meta.url), 'utf8');
    await page.addScriptTag({ type: 'module', content: `${source}\nwindow.helpers = { passwordFormStep, passwordRequestGuard };` });
    const step = (action, credentials) => page.evaluate(({ url, action, credentials }) =>
      window.helpers.passwordFormStep(url, action, credentials), { url: site.url, action, credentials });
    const guard = action => page.evaluate(({ url, action }) =>
      window.helpers.passwordRequestGuard(url, action), { url: site.url, action });
    assert.equal((await step('probe')).state, 'form');
    await page.locator('input[type="password"]').evaluate(element => {
      element.onblur = () => { window.committed = element.value.length > 0; };
    });
    const credentials = { ...synthetic, origin: new URL(site.url).origin, portalUrl: site.url };
    assert.deepEqual(await step('fill', credentials), { state: 'filled' });
    assert.equal(await page.evaluate(() => window.committed), true);
    await guard('install');
    const fetches = await page.evaluate(async () => {
      const results = [];
      for (let i = 0; i < 2; i++) {
        try { await fetch('login', { method: 'POST' }); results.push(true); }
        catch { results.push(false); }
      }
      return results;
    });
    assert.deepEqual(fetches, [true, false]);
    assert.equal(posts, 1);
    await guard('install');
    assert.deepEqual(await page.evaluate(async () => {
      const results = [];
      for (let i = 0; i < 2; i++) {
        results.push(await new Promise(resolve => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', 'login');
          xhr.onload = () => resolve(true);
          try { xhr.send(); } catch { resolve(false); }
        }));
      }
      return results;
    }), [true, false]);
    assert.equal(posts, 2);
    await guard('install');
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.name = 'sink';
      document.body.append(frame);
      const form = document.querySelector('form');
      form.onsubmit = null;
      form.action = 'login';
      form.method = 'POST';
      form.target = 'sink';
      form.requestSubmit();
      form.submit();
      form.requestSubmit();
    });
    await waitFor(() => posts === 3, 'one native form request');
    assert.equal((await guard('state')).requests, 1);
    await page.locator('input[type="email"]').click();
    assert.equal((await guard('state')).active, false);
    await page.evaluate(() => fetch('login', { method: 'POST' }));
    assert.equal(posts, 4);
    await page.locator('form').evaluate(element => { element.action = 'https://other.invalid/login'; });
    assert.equal((await step('probe')).state, 'manual');
    await page.locator('form').evaluate(element => { element.removeAttribute('action'); });
    await page.locator('[role="button"]').evaluate(element => { element.setAttribute('formaction', 'https://other.invalid/login'); });
    assert.equal((await step('probe')).state, 'manual');
    await page.locator('[role="button"]').evaluate(element => { element.removeAttribute('formaction'); });
    await page.locator('input[type="password"]').evaluate(element => { element.autocomplete = 'new-password'; });
    assert.equal((await step('probe')).state, 'manual');
    await page.locator('input[type="password"]').evaluate(element => {
      element.removeAttribute('autocomplete');
      element.after(element.cloneNode());
    });
    assert.equal((await step('probe')).state, 'manual');
  } finally {
    await browser.close();
  }
});

test('real extension signs password sites in during collection and never retries a rejected credential revision', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workday-password-edge-'));
  let bridge;
  let context;
  const posts = new Map(defaultPortals.map(site => [site.id, 0]));
  const authenticated = new Set();
  let reject = false;
  try {
    for (const employer of defaultPortals) {
      await saveCredentials(portalDirectory(directory, employer.id), synthetic, employer.url);
    }
    bridge = await startBridge({ directory, port: 0, allowPasswordLogin: true });
    const extension = resolve(import.meta.dirname, '..', 'browser-extension');
    context = await chromium.launchPersistentContext(join(directory, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route(/^https:\/\/[^/]+\.(?:myworkdayjobs|myworkdaysite)\.com\//, async route => {
      const current = new URL(route.request().url());
      const employer = defaultPortals.find(site => new URL(site.url).origin === current.origin);
      assert.ok(employer, 'Only fixture employers may be contacted.');
      if (route.request().method() === 'POST') {
        posts.set(employer.id, posts.get(employer.id) + 1);
        const values = JSON.parse(route.request().postData());
        assert.ok(values.username === synthetic.username && values.password === synthetic.password,
          'Only synthetic credentials may be submitted.');
        const ok = !(reject && employer.id === site.id);
        if (ok) authenticated.add(employer.id);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok }) });
      }
      const body = authenticated.has(employer.id) ? dashboard : `${form}
        <div role="alert"></div>
        <script>
        window.clicks = 0;
        const email = document.querySelector('input[type="email"]');
        const password = document.querySelector('input[type="password"]');
        password.onblur = () => window.committed = true;
        const send = async () => {
          try {
            const response = await fetch('login', { method: 'POST',
              body: JSON.stringify({ username: email.value, password: password.value }) });
            const result = await response.json();
            if (result.ok) document.body.innerHTML = ${JSON.stringify(dashboard)};
            else document.querySelector('[role="alert"]').innerText = 'Invalid email or password';
          } catch { window.duplicateBlocked = true; }
        };
        document.querySelector('[role="button"]').onclick = () => {
          if (!window.committed) return;
          window.clicks++;
          if (window.clicks === 1) setTimeout(send, 1500);
          else void send();
        };
        </script>`;
      await route.fulfill({ contentType: 'text/html', body });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const threeM = await context.newPage();
    await threeM.goto(site.url);
    await worker.evaluate(settings => chrome.storage.local.set(settings), {
      port: bridge.port, token: bridge.token, hourlyEnabled: false,
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).hostname}/popup.html`);
    const collect = async () => {
      const result = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'collect-all' }));
      return { result, run: await worker.evaluate(async () => (await chrome.storage.local.get('hourlyLastRun')).hourlyLastRun) };
    };
    const first = await collect();
    assert.equal(first.result.ok, true, JSON.stringify({
      message: first.result.message, posts: [...posts],
      tabs: await worker.evaluate(async () => (await chrome.tabs.query({})).map(({ url, pendingUrl, status }) => ({ url, pendingUrl, status }))),
      notice: await worker.evaluate(() => chrome.storage.local.get(['lastResult', 'password-entry:3m'])),
    }));
    assert.deepEqual([...posts.values()], [1, 1]);
    assert.equal(await threeM.evaluate(() => window.clicks), 2);
    await waitFor(() => threeM.evaluate(() => window.duplicateBlocked), 'late duplicate to be blocked');
    assert.equal(posts.get(site.id), 1);
    reject = true;
    authenticated.delete(site.id);
    const second = await collect();
    assert.equal(second.result.ok, false);
    assert.equal(second.run.results[0].outcome, 'needs_user_action');
    assert.match(second.run.results[0].error, /rejected sign-in|previous password-login attempt/);
    assert.equal(posts.get(site.id), 2);
    const third = await collect();
    assert.match(third.run.results[0].error, /previous password-login attempt/);
    assert.equal(posts.get(site.id), 2);
    const metadata = await worker.evaluate(() => chrome.storage.local.get('password-entry:3m'));
    assert.deepEqual(Object.keys(metadata['password-entry:3m']).sort(), ['portalUrl', 'revision']);
    assert.doesNotMatch(JSON.stringify(metadata), /fixture@example|Synthetic fixture/);
    let store = new Store(directory);
    try {
      assert.equal(store.report(site.id).latestCheck.outcome, 'needs_user_action');
      assert.equal(store.latest(site.id).applications[0].status, 'In  Process\nExact wording');
    } finally { store.close(); }
    reject = false;
    await saveCredentials(directory, synthetic, site.url);
    const recovered = await collect();
    assert.equal(recovered.result.ok, true, recovered.result.message);
    assert.equal(posts.get(site.id), 3);
    assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get('password-entry:3m')), {});
    await threeM.evaluate(() => {
      document.body.innerHTML = '<h1>Verify your identity</h1><input autocomplete="one-time-code">';
    });
    authenticated.delete(site.id);
    const mfa = await collect();
    assert.equal(mfa.run.results[0].outcome, 'needs_user_action');
    assert.match(mfa.run.results[0].error, /MFA|verification/);
    assert.equal(posts.get(site.id), 3);
  } finally {
    await context?.close();
    await bridge?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
