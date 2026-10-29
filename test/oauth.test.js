import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { validatePortal, portalDirectory, loginAllowedHosts } from '../src/config.js';
import { portalSessionState, returnToPortal } from '../src/tracker.js';
import { collectApplications } from '../src/browser.js';
import { SignInRequired } from '../src/extract.js';

const cvs = {
  id: 'cvs-health',
  name: 'CVS Health',
  url: 'https://cvshealth.wd1.myworkdayjobs.com/en-US/CVS_Health_Careers/userHome',
  auth: 'google',
};

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

test('Google OAuth is an explicit site setting and unknown auth modes fail', () => {
  assert.deepEqual(validatePortal(cvs), cvs);
  assert.throws(() => validatePortal({ ...cvs, auth: 'unknown' }), /auth must be/);
});

test('OAuth allows Google and only the portal shard identity broker', () => {
  assert.deepEqual(loginAllowedHosts(cvs), [
    'accounts.google.com', 'wd1-identity.myworkday.com',
  ]);
  const differentShard = {
    ...cvs, url: 'https://example.wd5.myworkdayjobs.com/en-US/Careers/userHome',
  };
  assert.deepEqual(loginAllowedHosts(differentShard), [
    'accounts.google.com', 'wd5-identity.myworkday.com',
  ]);
  assert.deepEqual(loginAllowedHosts({ ...cvs, auth: 'password' }), []);
  assert.deepEqual(loginAllowedHosts(cvs, ['accounts.google.com', 'verified.example.com']), [
    'accounts.google.com', 'verified.example.com', 'wd1-identity.myworkday.com',
  ]);
  assert.equal(loginAllowedHosts(cvs).includes('wd5-identity.myworkday.com'), false);
  assert.equal(loginAllowedHosts(cvs).includes('myworkday.com'), false);
});

test('OAuth session persistence keeps Workday state but discards Google identity state', () => {
  const state = {
    cookies: [
      { name: 'workday', domain: 'cvshealth.wd1.myworkdayjobs.com', value: 'synthetic-workday' },
      { name: 'workday-parent', domain: '.wd1.myworkdayjobs.com', value: 'synthetic-parent' },
      { name: 'google', domain: '.google.com', value: 'synthetic-google' },
      { name: 'other-employer', domain: 'other.wd1.myworkdayjobs.com', value: 'synthetic-other' },
      { name: 'lookalike', domain: '.myworkdayjobs.com.attacker.invalid', value: 'synthetic-lookalike' },
    ],
    origins: [
      { origin: new URL(cvs.url).origin, localStorage: [{ name: 'workday', value: 'synthetic' }], indexedDB: [] },
      { origin: 'https://accounts.google.com', localStorage: [{ name: 'google', value: 'synthetic' }], indexedDB: [] },
    ],
  };
  const filtered = portalSessionState(state, cvs.url);
  assert.deepEqual(filtered.cookies.map(cookie => cookie.name), ['workday', 'workday-parent']);
  assert.deepEqual(filtered.origins.map(item => item.origin), [new URL(cvs.url).origin]);
  assert.equal(state.cookies.length, 5);
  assert.equal(state.origins.length, 2);
});

test('a Workday Google sign-in screen is a login requirement, not an empty application list', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div data-automation-id="signInContent"><button>Sign in with Google</button></div>');
    await assert.rejects(collectApplications(page), error =>
      error instanceof SignInRequired && /Google sign-in is required/.test(error.message));
    await page.setContent('<h1>Sign In</h1><button data-automation-id="GoogleSignInButton" aria-label="Sign in with Google">Sign in with Google</button>');
    await assert.rejects(collectApplications(page), error =>
      error instanceof SignInRequired && /Google sign-in is required/.test(error.message));
    await page.setContent('<footer><a href="#">Continue with Google</a></footer><h1>My Applications</h1><p>You have no applications</p>');
    assert.deepEqual(await collectApplications(page), []);
  } finally {
    await page.close();
  }
});

test('Google identity pages are never treated as application dashboards', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({
      contentType: 'text/html', body: '<h1>Sign in</h1><input type="email">',
    }));
    await page.goto('https://accounts.google.com/signin');
    await assert.rejects(collectApplications(page), SignInRequired);
  } finally {
    await page.close();
  }
});

test('Workday identity broker pages promptly request login instead of hanging on extraction', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({
      contentType: 'text/html', body: '<h1>Choose a sign-in provider</h1>',
    }));
    await page.goto('https://wd1-identity.myworkday.com/');
    await assert.rejects(collectApplications(page), error =>
      error instanceof SignInRequired && /Workday identity sign-in/.test(error.message));
  } finally {
    await page.close();
  }
});

test('returning from OAuth uses shared context state even when the original tab was closed', async () => {
  const context = await browser.newContext();
  try {
    await context.route('**/*', route => route.fulfill({
      contentType: 'text/html', body: '<p>You have no applications</p>',
    }));
    const original = await context.newPage();
    const popup = await context.newPage();
    await popup.goto('https://accounts.google.com/signin');
    await context.addCookies([{
      name: 'workday-fixture', value: 'synthetic-only', url: new URL(cvs.url).origin,
    }]);
    await original.close();
    let checked = false;
    const active = { page: original, context, assertNavigation() { checked = true; } };
    await returnToPortal(active, cvs.url);
    assert.equal(active.page.url(), cvs.url);
    assert.equal(checked, true);
    assert.deepEqual(await collectApplications(active.page), []);
    assert.ok((await context.cookies(cvs.url)).some(cookie => cookie.name === 'workday-fixture'));
  } finally {
    await context.close();
  }
});

test('Google sites refuse saved passwords and missing sessions point to interactive login', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workday-oauth-'));
  const run = (...args) => execFileSync(process.execPath, ['src\\cli.js', ...args], {
    encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, WORKDAY_TRACKER_HOME: directory },
  });
  try {
    await writeFile(join(directory, 'sites.json'), JSON.stringify([cvs]));
    assert.throws(() => run('credentials', '--site', cvs.id), error => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /do not save a Google password/);
      assert.match(error.stderr, /login --site cvs-health/);
      return true;
    });
    const secrets = portalDirectory(directory, cvs.id);
    await mkdir(secrets, { recursive: true });
    await writeFile(join(secrets, 'credentials.dpapi'), 'not-a-valid-password-vault');
    assert.throws(() => run('check', '--site', cvs.id), error => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /No saved session/);
      assert.match(error.stderr, /login --site cvs-health/);
      assert.doesNotMatch(error.stderr, /credentials --site|decryption failed/);
      return true;
    });
    assert.throws(() => run('login', '--auto', '--site', cvs.id), error => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /Interactive login requires a terminal/);
      return true;
    });
    const report = JSON.parse(run('report', '--json'));
    assert.deepEqual(report.sites.map(site => site.site), ['3m', 'wells-fargo', 'cvs-health']);
    const cv = report.sites.find(site => site.site === cvs.id);
    assert.equal(cv.latestCheck.outcome, 'failed');
    assert.equal(cv.lastSuccessfulCheck, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
