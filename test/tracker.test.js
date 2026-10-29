import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { extractPage, validatePage, applicationKey } from '../src/extract.js';
import { collectApplications, openBrowser } from '../src/browser.js';
import { Store } from '../src/store.js';
import {
  saveSession, loadSession, forgetSession, saveCredentials, loadCredentials, forgetCredentials,
} from '../src/vault.js';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function withPage(html, action) {
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await action(page);
  } finally {
    await page.close();
  }
}

function table(rows, extra = '') {
  return `<table><thead><tr><th>Job Title</th><th>Application Status</th><th>Requisition ID</th></tr></thead>
    <tbody>${rows}</tbody></table>${extra}`;
}

const row = (title, status, id = 'R1') =>
  `<tr><td><a href="https://3m.wd1.myworkdayjobs.com/job/${id}">${title}</a></td><td>${status}</td><td>${id}</td></tr>`;

test('table extraction preserves employer text, case, punctuation, and internal whitespace', async () => {
  await withPage(table(row('Engineer', '  In Process - Recruiter Review  ', 'R42')), async page => {
    const snapshot = await page.evaluate(extractPage);
    validatePage(snapshot);
    assert.equal(snapshot.applications[0].status, 'In Process - Recruiter Review');
    assert.equal(snapshot.applications[0].title, 'Engineer');
    assert.equal(applicationKey(snapshot.applications[0]), 'req:R42');
    assert.equal('normalizedStatus' in snapshot.applications[0], false);
    await page.locator('tbody td').nth(1).evaluate(element => {
      element.style.whiteSpace = 'pre';
      element.textContent = 'Employer  SPECIFIC\nStatus';
    });
    assert.equal((await page.evaluate(extractPage)).applications[0].status, 'Employer  SPECIFIC\nStatus');
  });
});

test('Workday card statuses are paired with the right job', async () => {
  await withPage(`
    <div><h2 data-automation-id="applicationTitle">First job</h2><p data-automation-id="applicationStatus">Under Consideration</p></div>
    <div><h2 data-automation-id="jobTitle">Second job</h2><p data-automation-id="applicationStatus">Not Selected</p></div>
  `, async page => {
    const snapshot = await page.evaluate(extractPage);
    validatePage(snapshot);
    assert.deepEqual(snapshot.applications.map(({ title, status }) => [title, status]),
      [['First job', 'Under Consideration'], ['Second job', 'Not Selected']]);
  });
});

test('3M table captures Job Req alongside a row-header title and My Application Status', async () => {
  await withPage(`<table>
    <thead><tr><th>Job Title</th><th>Job Req</th><th>My Application<br>Status</th><th>Date Submitted</th><th>Action</th></tr></thead>
    <tbody><tr>
      <th scope="row"><div data-automation-id="applicationTitle"><a href="https://3m.wd1.myworkdayjobs.com/job/Engineer_R12345678">Engineer</a></div></th>
      <td>R12345678</td>
      <td><div data-automation-id="applicationStatus">In Process - Employer Wording</div></td>
      <td>October 28, 2026</td><td><button>Actions</button></td>
    </tr></tbody>
  </table>`, async page => {
    const snapshot = await page.evaluate(extractPage);
    validatePage(snapshot);
    assert.equal(snapshot.applications.length, 1);
    assert.equal(snapshot.applications[0].title, 'Engineer');
    assert.equal(snapshot.applications[0].requisitionId, 'R12345678');
    assert.equal(snapshot.applications[0].status, 'In Process - Employer Wording');
    assert.equal(applicationKey(snapshot.applications[0]), 'req:R12345678');
  });
});

test('ARIA row-header titles retain requisition-column alignment', async () => {
  await withPage(`<div role="table">
    <div role="row"><span role="columnheader">Job Title</span><span role="columnheader">Job Req</span><span role="columnheader">My Application Status</span></div>
    <div role="row"><span role="rowheader">Engineer</span><span role="cell">R12345678</span><span role="cell">In Process</span></div>
  </div>`, async page => {
    const snapshot = await page.evaluate(extractPage);
    validatePage(snapshot);
    assert.equal(snapshot.applications[0].requisitionId, 'R12345678');
    assert.equal(snapshot.applications[0].status, 'In Process');
  });
});

test('semantic ARIA application tables are supported', async () => {
  await withPage(`<div role="table">
    <div role="row"><span role="columnheader">Position</span><span role="columnheader">Status</span></div>
    <div role="row"><span role="cell">Analyst</span><span role="cell">Application Received</span></div>
  </div>`, async page => {
    const snapshot = await page.evaluate(extractPage);
    validatePage(snapshot);
    assert.equal(snapshot.applications[0].status, 'Application Received');
  });
});

test('hidden rows and unrelated tables are not applications', async () => {
  await withPage(table(row('Visible', 'Review', 'R1') +
    `<tr hidden><td>Hidden</td><td>Secret</td><td>R2</td></tr>`) +
    '<table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Profile</td><td>Active</td></tr></tbody></table>',
  async page => {
    const snapshot = await page.evaluate(extractPage);
    assert.equal(snapshot.applications.length, 1);
    assert.equal(snapshot.applications[0].title, 'Visible');
  });
});

test('unknown layouts, missing statuses, and sign-in are explicit failures', async () => {
  for (const html of ['<h1>Welcome</h1>', table(row('Engineer', '')), '<input type="password">']) {
    await withPage(html, async page => {
      const snapshot = await page.evaluate(extractPage);
      assert.throws(() => validatePage(snapshot), /required|Extraction failed|No recognizable/);
    });
  }
});

test('explicit empty state is accepted without inventing statuses', async () => {
  await withPage('<h1>My Applications</h1><p>You have no applications</p>', async page => {
    const applications = await collectApplications(page);
    assert.deepEqual(applications, []);
  });
});

test('collector follows Next pages and preserves exact status strings', async () => {
  await withPage(table(row('First', 'Received', 'R1'), '<button aria-label="Next page">Next</button>'), async page => {
    await page.locator('button').evaluate(button => {
      button.onclick = () => {
        const cells = document.querySelectorAll('tbody td');
        cells[0].innerHTML = '<a href="https://3m.wd1.myworkdayjobs.com/job/R2">Second</a>';
        cells[1].textContent = 'In Progress - Business Review';
        cells[2].textContent = 'R2';
        button.disabled = true;
      };
    });
    const applications = await collectApplications(page);
    assert.deepEqual(applications.map(application => application.status), ['Received', 'In Progress - Business Review']);
    assert.equal(applications.length, 2);
  });
});

test('duplicate application identities are rejected, not silently merged', async () => {
  await withPage(table(row('First', 'Review') + row('Second', 'Received')), async page => {
    await assert.rejects(collectApplications(page), /duplicate identities/);
  });
});

test('pagination loops are rejected instead of saving repeated applications', async () => {
  await withPage(table(row('First', 'Received', 'R1'), '<button>Next</button>'), async page => {
    await page.locator('button').evaluate(button => {
      let second = false;
      button.onclick = () => {
        second = !second;
        const cells = document.querySelectorAll('tbody td');
        const id = second ? 'R2' : 'R1';
        const title = second ? 'Second' : 'First';
        cells[0].innerHTML = `<a href="https://3m.wd1.myworkdayjobs.com/job/${id}">${title}</a>`;
        cells[2].textContent = id;
      };
    });
    await assert.rejects(collectApplications(page), /Pagination repeated a page/);
  });
});

test('incomplete rows prevent a successful partial snapshot', async () => {
  await withPage(table(row('Complete', 'Received', 'R1') + row('Incomplete', '', 'R2')), async page => {
    await assert.rejects(collectApplications(page), /missing its title or status/);
  });
});

test('insecure document navigation is blocked before loading', async () => {
  await assert.rejects(openBrowser({ url: 'http://unapproved.invalid' }), /blocked/);
});

test('database keeps exact history, errors, empty snapshots, and transactional writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workday-store-'));
  const store = new Store(directory);
  try {
    const application = { key: 'id:1', title: 'Engineer', status: 'In Process', url: null, requisitionId: null };
    store.save('3m', [application], '2026-10-28T00:00:00.000Z');
    const second = store.save('3m', [{ ...application, status: 'In Process - HR Review' }]);
    assert.deepEqual(second.changes, [{
      title: 'Engineer', previousStatus: 'In Process', status: 'In Process - HR Review',
    }]);
    store.fail('3m', 'Sign-in required');
    const report = store.report('3m');
    assert.equal(report.latestCheck.outcome, 'failed');
    assert.equal(report.lastSuccessfulCheck.applications[0].status, 'In Process - HR Review');
    assert.equal(store.history('3m').length, 2);
    assert.throws(() => store.save('3m', [application, application]), /UNIQUE/);
    assert.equal(store.history('3m').length, 2);
    assert.deepEqual(store.save('3m', []).changes, []);
    assert.deepEqual(store.latest('3m').applications, []);
    assert.equal(store.latest('other'), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows vault encrypts sessions, restores them, and supports logout', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workday-vault-'));
  try {
    const state = { cookies: [{ name: 'session', value: 'test-secret-value' }], origins: [] };
    await assert.rejects(loadSession(directory), /No saved session/);
    await saveSession(directory, state);
    assert.equal((await readFile(join(directory, 'session.dpapi'))).includes(Buffer.from('test-secret-value')), false);
    assert.deepEqual(await loadSession(directory), state);
    await saveSession(directory, { ...state, cookies: [] });
    assert.deepEqual(await loadSession(directory), { cookies: [], origins: [] });
    await forgetSession(directory);
    await assert.rejects(loadSession(directory), /No saved session/);
    assert.equal(await loadSession(directory, { optional: true }), undefined);
    const url = 'https://3m.wd1.myworkdayjobs.com/en-US/Search/userHome';
    const credentials = { username: 'test@example.invalid', password: ' Synthetic password! ' };
    assert.equal(await loadCredentials(directory, url, { optional: true }), undefined);
    await assert.rejects(loadCredentials(directory, url), /No saved credentials/);
    await saveCredentials(directory, credentials, url);
    const encrypted = await readFile(join(directory, 'credentials.dpapi'));
    assert.equal(encrypted.includes(Buffer.from(credentials.password)), false);
    assert.equal(encrypted.includes(Buffer.from(credentials.username)), false);
    assert.deepEqual(await loadCredentials(directory, url), {
      ...credentials, origin: new URL(url).origin, portalUrl: url,
    });
    await assert.rejects(loadCredentials(directory, 'https://other.invalid'), /different portal/);
    await forgetCredentials(directory);
    await assert.rejects(loadCredentials(directory, url), /No saved credentials/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('learning a requisition ID preserves a unique URL-based application history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workday-enrichment-'));
  const store = new Store(directory);
  try {
    const url = 'https://3m.wd1.myworkdayjobs.com/job/Engineer_R12345678';
    const original = {
      key: `url:${url}`, url, title: 'Engineer', status: 'In Process', requisitionId: null,
    };
    store.save('3m', [original]);
    const enriched = { ...original, key: 'req:R12345678', requisitionId: 'R12345678' };
    const second = store.save('3m', [{ ...enriched, status: 'In Process - HR Review' }]);
    assert.equal(second.applications[0].key, original.key);
    assert.equal(second.applications[0].requisitionId, 'R12345678');
    assert.deepEqual(second.changes, [{
      title: 'Engineer', previousStatus: 'In Process', status: 'In Process - HR Review',
    }]);
    store.save('3m', [enriched]);
    assert.deepEqual(store.history('3m').map(item => item.key), [original.key, original.key, original.key]);
    const different = store.save('3m', [{ ...enriched, key: 'req:R99999999', requisitionId: 'R99999999' }]);
    assert.equal(different.applications[0].key, 'req:R99999999');
    assert.deepEqual(different.changes, []);
    store.save('ambiguous', [original]);
    const ambiguous = store.save('ambiguous', [
      enriched, { ...enriched, key: 'req:R99999999', requisitionId: 'R99999999' },
    ]);
    assert.deepEqual(ambiguous.applications.map(item => item.key), ['req:R12345678', 'req:R99999999']);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI reports no data and rejects invalid commands without contacting Workday', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workday-cli-'));
  const options = { encoding: 'utf8', env: { ...process.env, WORKDAY_TRACKER_HOME: directory } };
  try {
    const output = execFileSync(process.execPath, ['src\\cli.js', 'report', '--json'], options);
    const report = JSON.parse(output);
    assert.deepEqual(report.sites.map(site => site.site), ['3m', 'wells-fargo']);
    assert.ok(report.sites.every(site => site.latestCheck === null && site.lastSuccessfulCheck === null));
    assert.match(execFileSync(process.execPath, ['src\\cli.js', '--help'], options), /login/);
    assert.throws(() => execFileSync(process.execPath, ['src\\cli.js', 'invalid'], { ...options, stdio: 'pipe' }),
      error => error.status === 1 && error.stderr.includes('Unknown command'));
    assert.throws(() => execFileSync(process.execPath, ['src\\cli.js', 'credentials'], { ...options, stdio: 'pipe' }),
      error => error.status === 1 && error.stderr.includes('interactive terminal'));
    assert.throws(() => execFileSync(process.execPath, ['src\\cli.js', 'login', '--auto'], { ...options, stdio: 'pipe' }),
      error => error.status === 1 && error.stderr.includes('No saved credentials'));
    assert.throws(() => execFileSync(process.execPath, ['src\\cli.js', 'report', '--auto'], { ...options, stdio: 'pipe' }),
      error => error.status === 1 && error.stderr.includes('--auto applies only to login'));
    assert.throws(() => execFileSync(process.execPath, ['src\\cli.js', 'check'], { ...options, stdio: 'pipe' }),
      error => error.status === 1 && error.stderr.includes('No saved session'));
    const failed = JSON.parse(execFileSync(process.execPath, ['src\\cli.js', 'report', '--json'], options));
    const threeM = failed.sites.find(site => site.site === '3m');
    assert.equal(threeM.latestCheck.outcome, 'failed');
    assert.equal(threeM.lastSuccessfulCheck, null);
    assert.match(execFileSync(process.execPath, ['src\\cli.js', 'logout'], options), /session and credentials removed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
