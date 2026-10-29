import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { configureHourly, hourlyAlarm, hourlyMinutes, runHourlyBatch } from '../browser-extension/hourly.js';
import { defaultPortals, loadPortals } from '../src/config.js';
import { startBridge } from '../src/bridge.js';
import { Store } from '../src/store.js';

test('hourly alarms are exactly 60 minutes, survive worker reconfiguration, and pause when disabled or unpaired', async () => {
  const saved = { token: 'fixture' };
  let alarm;
  const created = [];
  const api = {
    storage: { local: { get: async () => saved } },
    alarms: {
      get: async name => { assert.equal(name, hourlyAlarm); return alarm; },
      create: async (name, value) => { created.push({ name, ...value }); alarm = value; },
      clear: async name => { assert.equal(name, hourlyAlarm); alarm = undefined; },
    },
  };
  assert.equal(hourlyMinutes, 60);
  assert.deepEqual(await configureHourly(api), { active: true, created: true });
  assert.deepEqual(created, [{ name: hourlyAlarm, delayInMinutes: 60, periodInMinutes: 60 }]);
  assert.deepEqual(await configureHourly(api), { active: true, created: false });
  assert.equal(created.length, 1);
  saved.hourlyEnabled = false;
  assert.deepEqual(await configureHourly(api), { active: false, created: false });
  assert.equal(alarm, undefined);
  saved.hourlyEnabled = true;
  await configureHourly(api);
  assert.equal(created.length, 2);
  alarm = undefined;
  await configureHourly(api);
  assert.equal(created.length, 3);
  delete saved.token;
  assert.equal((await configureHourly(api)).active, false);
  assert.equal(alarm, undefined);
});

test('hourly batches reuse dashboards, preserve login forms, open inactive tabs, and continue after login failures', async () => {
  const sites = [
    defaultPortals[0], defaultPortals[1],
    { id: 'fixture', name: 'Fixture', url: 'https://fixture.wd5.myworkdayjobs.com/en-US/Careers/userHome' },
  ];
  const tabs = sites.slice(0, 2).map((site, index) => ({ id: index + 1, url: site.url, status: 'complete' }));
  const session = {};
  const reloaded = [];
  const opened = [];
  const updated = [];
  const requests = [];
  const application = { title: 'Fixture', status: 'In  Process\nExact status', url: null, applicationId: null, requisitionId: 'R1' };
  const api = {
    storage: { session: {
      get: async key => ({ [key]: session[key] }),
      set: async value => Object.assign(session, value),
    } },
    tabs: {
      query: async () => tabs,
      get: async id => tabs.find(tab => tab.id === id),
      reload: async id => reloaded.push(id),
      update: async (id, value) => {
        updated.push({ id, ...value });
        tabs.find(tab => tab.id === id).url = value.url;
      },
      create: async value => {
        opened.push(value);
        const tab = { id: tabs.length + 1, url: value.url, status: 'complete' };
        tabs.push(tab);
        return tab;
      },
    },
    scripting: {
      executeScript: async ({ target }) => [{
        result: {
          applications: target.tabId === 2 ? [] : [application],
          passwordVisible: target.tabId === 2, empty: false, loading: false, problems: [], hasNext: false,
        },
      }],
    },
  };
  const request = async (settings, path, body) => {
    requests.push({ path, body });
    return { checkedAt: '2026-10-28T12:00:00.000Z', applications: body.applications };
  };
  const results = await runHourlyBatch(sites, {}, api, request);
  assert.deepEqual(results.map(result => result.outcome), ['success', 'needs_user_action', 'success']);
  assert.deepEqual(reloaded, [1]);
  assert.deepEqual(opened, [{ url: 'about:blank', active: false }]);
  assert.deepEqual(updated, [{ id: 3, url: sites[2].url }]);
  assert.equal(requests.filter(value => value.path === '/observations').length, 2);
  assert.equal(requests[0].body.applications[0].status, application.status);
  assert.equal(requests[1].path, '/checks');
  assert.equal(requests[1].body.site, 'wells-fargo');
  assert.equal(requests[1].body.outcome, 'needs_user_action');
  await runHourlyBatch(sites, {}, api, request);
  assert.equal(opened.length, 1);
  tabs[2].url = undefined;
  const waiting = await runHourlyBatch([sites[2]], {}, api, request);
  assert.equal(waiting[0].outcome, 'needs_user_action');
  assert.equal(opened.length, 1);
});

test('hourly errors do not persist provider URLs and explicitly report failed outcome recording', async () => {
  const site = defaultPortals[0];
  const api = {
    storage: { session: { get: async () => ({}) } },
    tabs: {
      query: async () => [],
      create: async () => { throw new Error('Cannot access https://accounts.google.com/signin?state=fixture-private'); },
    },
  };
  const results = await runHourlyBatch([site], {}, api, async (settings, path, body) => {
    assert.equal(path, '/checks');
    assert.doesNotMatch(body.error, /accounts\.google|fixture-private/);
    throw new Error('Bridge is unavailable');
  });
  assert.equal(results[0].outcome, 'failed');
  assert.match(results[0].error, /Latest check could not be recorded/);
  assert.doesNotMatch(results[0].error, /fixture-private/);
});

async function waitFor(action, description) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

test('real hourly alarm collects every registered site without manual collection and preserves snapshots on expiration', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workday-hourly-'));
  let bridge;
  let context;
  try {
    const custom = [
      { id: 'fixture-cvs', name: 'Fixture CVS', url: 'https://fixture-cvs.wd1.myworkdayjobs.com/en-US/Careers/userHome', auth: 'google', collection: 'browser' },
      { id: 'fixture-tr', name: 'Fixture TR', url: 'https://fixture-tr.wd5.myworkdayjobs.com/en-US/Careers/userHome', auth: 'google', collection: 'browser' },
    ];
    await writeFile(join(directory, 'sites.json'), JSON.stringify(custom));
    const sites = await loadPortals(directory);
    bridge = await startBridge({ directory, port: 0 });
    const extension = resolve(import.meta.dirname, '..', 'browser-extension');
    context = await chromium.launchPersistentContext(join(directory, 'profile'), {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    let phase = 'initial';
    await context.route(/^https:\/\/[^/]+\.(?:myworkdayjobs|myworkdaysite)\.com\//, async route => {
      const current = new URL(route.request().url());
      const site = sites.find(item => new URL(item.url).origin === current.origin);
      assert.ok(site, 'Only fixture employers may be contacted.');
      const body = phase === 'expired' && site.id === '3m'
        ? '<h1>Sign In</h1><input type="password"><button>Sign In</button>'
        : `<h1>My Applications</h1><table><thead><tr><th>Job Title</th><th>Job Req</th><th>Status</th></tr></thead>
          <tbody><tr><td>Fixture ${site.id}</td><td>REQ-${site.id}</td><td style="white-space:pre-wrap">In  Process<br>${phase}</td></tr></tbody></table>`;
      await route.fulfill({ contentType: 'text/html', body });
    });
    await context.route('https://accounts.google.com/**', route =>
      route.fulfill({ contentType: 'text/html', body: '<h1>Google fixture: manual login required</h1>' }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(settings => chrome.storage.local.set(settings), {
      port: bridge.port, token: bridge.token, hourlyEnabled: false,
    });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).hostname}/popup.html`);
    const existing = await context.newPage();
    await existing.goto(sites[0].url);
    const applicationTab = await context.newPage();
    const applicationUrl = custom[1].url.replace('userHome', 'job/unfinished-application');
    await applicationTab.goto(applicationUrl);
    const anchor = context.pages()[0];
    await anchor.bringToFront();
    const activeBefore = await worker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0].id);
    const originalTabs = await worker.evaluate(() => chrome.tabs.query({}));
    const existingId = originalTabs.find(tab => tab.url === sites[0].url).id;
    await worker.evaluate(() => chrome.storage.local.set({ hourlyEnabled: true }));
    await waitFor(async () => {
      const { lastResult } = await worker.evaluate(() => chrome.storage.local.get('lastResult'));
      return lastResult?.message.startsWith('Collecting all registered');
    }, 'initial batch to start');
    const overlap = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'collect-all' }));
    assert.equal(overlap.ok, false);
    assert.match(overlap.message, /already running/);
    const first = await waitFor(async () => {
      const { hourlyLastRun } = await worker.evaluate(() => chrome.storage.local.get('hourlyLastRun'));
      return hourlyLastRun;
    }, 'the automatic initial batch');
    assert.equal(first.results.length, 4);
    assert.ok(first.results.every(result => result.outcome === 'success'), JSON.stringify(first));
    const alarm = await worker.evaluate(name => chrome.alarms.get(name), hourlyAlarm);
    assert.equal(alarm.periodInMinutes, 60);
    assert.ok(alarm.scheduledTime >= Date.now() + 59 * 60_000);
    assert.ok(alarm.scheduledTime <= Date.now() + 61 * 60_000);
    let tabs = await worker.evaluate(() => chrome.tabs.query({}));
    assert.equal(tabs.find(tab => tab.url === sites[0].url).id, existingId);
    assert.equal(tabs.filter(tab => sites.some(site => site.url === tab.url)).length, 4);
    assert.equal(applicationTab.url(), applicationUrl);
    assert.equal((await worker.evaluate(() => chrome.tabs.query({ active: true })))[0].id, activeBefore);
    let store = new Store(directory);
    try {
      for (const site of sites) assert.equal(store.latest(site.id).applications[0].status, 'In  Process\ninitial');
    } finally {
      store.close();
    }
    phase = 'expired';
    await worker.evaluate(name => chrome.alarms.create(name, { when: Date.now() + 1000, periodInMinutes: 60 }), hourlyAlarm);
    const second = await waitFor(async () => {
      const { hourlyLastRun } = await worker.evaluate(() => chrome.storage.local.get('hourlyLastRun'));
      return hourlyLastRun?.startedAt !== first.startedAt ? hourlyLastRun : null;
    }, 'a real browser alarm to collect again');
    assert.deepEqual(second.results.map(result => result.outcome), ['needs_user_action', 'success', 'success', 'success']);
    store = new Store(directory);
    try {
      assert.equal(store.report('3m').latestCheck.outcome, 'needs_user_action');
      assert.equal(store.latest('3m').applications[0].status, 'In  Process\ninitial');
      assert.equal(store.latest(custom[1].id).applications[0].status, 'In  Process\nexpired');
      assert.equal(store.history(custom[1].id).length, 2);
    } finally {
      store.close();
    }
    await worker.evaluate(() => chrome.storage.local.set({ hourlyEnabled: false }));
    await waitFor(async () => !(await worker.evaluate(name => chrome.alarms.get(name), hourlyAlarm)), 'pause to remove the alarm');
    tabs = await worker.evaluate(() => chrome.tabs.query({}));
    const trTab = context.pages().find(page => page.url() === custom[1].url);
    await trTab.goto('https://accounts.google.com/signin');
    const manual = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'collect-all' }));
    assert.equal(manual.ok, false);
    assert.match(manual.message, /Fixture TR/);
    assert.equal((await worker.evaluate(() => chrome.tabs.query({}))).length, tabs.length);
    assert.equal(await worker.evaluate(name => chrome.alarms.get(name), hourlyAlarm), undefined);
  } finally {
    await context?.close();
    await bridge?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
