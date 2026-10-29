import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultPortals, loadPortals, portalDirectory, validatePortal } from '../src/config.js';
import { checkSites } from '../src/tracker.js';
import { Store } from '../src/store.js';
import {
  saveCredentials, loadCredentials, saveSession, loadSession,
} from '../src/vault.js';

async function temporary(action) {
  const directory = await mkdtemp(join(tmpdir(), 'workday-sites-'));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function command(directory, ...args) {
  return execFileSync(process.execPath, ['src\\cli.js', ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, WORKDAY_TRACKER_HOME: directory },
  });
}

test('built-in portals keep legacy 3M secrets and separate Wells Fargo secrets', async () => {
  await temporary(async directory => {
    const sites = await loadPortals(directory);
    assert.deepEqual(sites.map(site => site.id), ['3m', 'wells-fargo']);
    assert.equal(portalDirectory(directory, '3m'), directory);
    assert.equal(portalDirectory(directory, 'wells-fargo'), join(directory, 'sites', 'wells-fargo'));
    for (const id of ['..', '..\\escape', 'a/b', 'CON', 'con', 'nul', '', undefined]) {
      assert.throws(() => portalDirectory(directory, id), /Site IDs/);
    }
  });
});

test('additional sites are validated and appended without overriding built-ins', async () => {
  await temporary(async directory => {
    const custom = {
      id: 'example',
      name: 'Example',
      url: 'https://example.wd1.myworkdayjobs.com/en-US/Careers/userHome',
    };
    await writeFile(join(directory, 'sites.json'), JSON.stringify([custom]));
    assert.deepEqual((await loadPortals(directory)).map(site => site.id), ['3m', 'wells-fargo', 'example']);
    const report = JSON.parse(command(directory, 'report', '--json'));
    assert.deepEqual(report.sites.map(site => site.site), ['3m', 'wells-fargo', 'example']);
    assert.ok(report.sites.every(site => site.latestCheck === null && site.lastSuccessfulCheck === null));
    await writeFile(join(directory, 'sites.json'), JSON.stringify([{ ...custom, id: '3m' }]));
    await assert.rejects(loadPortals(directory), /unique/);
    await writeFile(join(directory, 'sites.json'), JSON.stringify([{ ...custom, url: defaultPortals[0].url }]));
    await assert.rejects(loadPortals(directory), /URLs must be unique/);
    await writeFile(join(directory, 'sites.json'), '{ broken json');
    await assert.rejects(loadPortals(directory), /JSON array/);
    await writeFile(join(directory, 'sites.json'), '{}');
    await assert.rejects(loadPortals(directory), /JSON array/);
  });
});

test('site configuration rejects non-Workday URLs and credentials in configuration', () => {
  const site = { id: 'example', name: 'Example', url: defaultPortals[0].url };
  for (const url of [
    'http://3m.wd1.myworkdayjobs.com/en-US/Search/userHome',
    'https://myworkdayjobs.com.attacker.invalid/userHome',
    'https://user:password@3m.wd1.myworkdayjobs.com/en-US/Search/userHome',
    'https://3m.wd1.myworkdayjobs.com/en-US/Search/userHome?token=example',
    'https://3m.wd1.myworkdayjobs.com/en-US/Search',
  ]) {
    assert.throws(() => validatePortal({ ...site, url }), /HTTPS Workday/);
  }
  assert.throws(() => validatePortal({ ...site, password: 'synthetic-only' }), /Do not put credentials/);
  assert.throws(() => validatePortal({ ...site, name: 'Example\nHidden' }), /Each site/);
});

test('batch checks continue after failures and identify every site', async () => {
  const seen = [];
  const progress = [];
  const results = await checkSites(defaultPortals, {
    directory: 'unused',
    onProgress: message => progress.push(message),
  }, async (site, options) => {
    seen.push(site.id);
    options.onProgress('Checking');
    if (site.id === '3m') throw new Error('Sign-in needed');
    return { checkedAt: '2026-10-28T00:00:00.000Z', applications: [], changes: [] };
  });
  assert.deepEqual(seen, ['3m', 'wells-fargo']);
  assert.deepEqual(results.map(result => result.outcome), ['failed', 'success']);
  assert.equal(results[0].error, 'Sign-in needed');
  assert.equal('snapshot' in results[0], false);
  assert.equal(results[1].site, 'wells-fargo');
  assert.deepEqual(progress, ['[3M] Checking', '[Wells Fargo] Checking']);
});

test('aggregate reports and history isolate identical application IDs between sites', async () => {
  await temporary(async directory => {
    const store = new Store(directory);
    const application = { key: 'req:123', title: 'Engineer', url: null, requisitionId: '123' };
    try {
      store.save('3m', [{ ...application, status: 'In Process - 3M' }]);
      store.save('wells-fargo', [{ ...application, status: 'Under Review - Wells Fargo' }]);
      store.fail('wells-fargo', 'Session expired');
    } finally {
      store.close();
    }
    const all = JSON.parse(command(directory, 'report', '--all', '--json'));
    assert.deepEqual(all.sites.map(site => site.site), ['3m', 'wells-fargo']);
    assert.equal(all.sites[0].lastSuccessfulCheck.applications[0].status, 'In Process - 3M');
    assert.equal(all.sites[1].lastSuccessfulCheck.applications[0].status, 'Under Review - Wells Fargo');
    assert.equal(all.sites[1].latestCheck.outcome, 'failed');
    assert.equal(all.sites[1].latestCheck.error, 'Session expired');
    const wf = JSON.parse(command(directory, 'report', '--site', 'wells-fargo', '--json'));
    assert.equal(wf.lastSuccessfulCheck.applications[0].status, 'Under Review - Wells Fargo');
    const defaultReport = JSON.parse(command(directory, 'report', '--json'));
    assert.deepEqual(defaultReport, all);
    const threeM = JSON.parse(command(directory, 'report', '--site', '3m', '--json'));
    assert.equal(threeM.lastSuccessfulCheck.applications[0].status, 'In Process - 3M');
    const history = JSON.parse(command(directory, 'history', '--all', '--json'));
    assert.equal(history.sites[0].history.length, 1);
    assert.equal(history.sites[1].history.length, 1);
    assert.match(command(directory, 'report', '--all'), /Wells Fargo \(wells-fargo\)/);
    const humanReport = command(directory, 'report');
    assert.match(humanReport, /3M \(3m\)/);
    assert.match(humanReport, /Wells Fargo \(wells-fargo\)/);
    assert.equal(JSON.parse(command(directory, 'sites', '--json')).sites.length, 2);
  });
});

test('batch failure output remains JSON and persists a failure for each unconfigured site', async () => {
  await temporary(async directory => {
    assert.throws(() => command(directory, 'check', '--all', '--json'), error => {
      assert.equal(error.status, 1);
      const results = JSON.parse(error.stdout);
      assert.equal(results.sites.length, 2);
      assert.ok(results.sites.every(site => site.outcome === 'failed'));
      assert.match(results.sites[1].error, /credentials --site wells-fargo/);
      return true;
    });
    const report = JSON.parse(command(directory, 'report', '--all', '--json'));
    assert.ok(report.sites.every(site => site.latestCheck.outcome === 'failed'));
    assert.ok(report.sites.every(site => site.lastSuccessfulCheck === null));
    for (const args of [
      ['report', '--all', '--site', '3m'],
      ['credentials', '--all'],
      ['login', '--all'],
      ['report', '--site', 'unknown'],
    ]) {
      assert.throws(() => command(directory, ...args), error => error.status === 1);
    }
  });
});

test('site-specific credentials and sessions cannot be used for another tenant on the same host', {
  skip: process.platform !== 'win32',
}, async () => {
  await temporary(async directory => {
    const [threeM, wf] = defaultPortals;
    const threeMDirectory = portalDirectory(directory, threeM.id);
    const wfDirectory = portalDirectory(directory, wf.id);
    const first = { username: 'first@example.invalid', password: 'First synthetic secret!' };
    const second = { username: 'second@example.invalid', password: 'Second synthetic secret!' };
    await saveCredentials(threeMDirectory, first, threeM.url);
    await saveCredentials(wfDirectory, second, wf.url);
    assert.equal((await loadCredentials(threeMDirectory, threeM.url)).username, first.username);
    assert.equal((await loadCredentials(wfDirectory, wf.url)).username, second.username);
    const differentTenant = 'https://wd1.myworkdaysite.com/en-US/recruiting/other/Careers/userHome';
    await assert.rejects(loadCredentials(wfDirectory, differentTenant), /different portal/);
    const state = { cookies: [], origins: [] };
    await saveSession(wfDirectory, state, wf.url);
    assert.deepEqual(await loadSession(wfDirectory, { portalUrl: wf.url }), state);
    await assert.rejects(loadSession(wfDirectory, { portalUrl: differentTenant }), /different site/);
    await saveSession(threeMDirectory, state);
    assert.deepEqual(await loadSession(threeMDirectory, { portalUrl: threeM.url }), state);
    command(directory, 'logout', '--site', 'wells-fargo');
    assert.equal(await loadCredentials(wfDirectory, wf.url, { optional: true }), undefined);
    assert.equal(await loadSession(wfDirectory, { optional: true, portalUrl: wf.url }), undefined);
    assert.equal((await loadCredentials(threeMDirectory, threeM.url)).username, first.username);
    assert.deepEqual(await loadSession(threeMDirectory, { portalUrl: threeM.url }), state);
  });
});
