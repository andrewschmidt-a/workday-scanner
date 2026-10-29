import { setTimeout as delay } from 'node:timers/promises';
import { extractPage } from './extract.js';
import { evaluatePage } from './page.js';
import { hasLoginChallenge, passwordLoginRejected } from './login-dom.js';

export class AuthenticationNeedsUserAction extends Error {}

function assertCredentialOrigin(page, portalUrl, credentials) {
  const origin = new URL(portalUrl).origin;
  const prefix = new URL('.', portalUrl).pathname;
  if (new URL(page.url()).origin !== origin || credentials.origin !== origin ||
      !new URL(page.url()).pathname.startsWith(prefix) ||
      (credentials.portalUrl && credentials.portalUrl !== new URL(portalUrl).href) ||
      new URL(page.url()).protocol !== 'https:') {
    throw new AuthenticationNeedsUserAction(
      'Automatic password entry is restricted to the configured HTTPS Workday portal. Use interactive login for external identity providers.',
    );
  }
}

async function isDashboard(page) {
  const snapshot = await evaluatePage(page, extractPage);
  return !snapshot.passwordVisible && !snapshot.loading &&
    (snapshot.applications.length > 0 || snapshot.empty);
}

async function needsChallenge(page) {
  return evaluatePage(page, hasLoginChallenge);
}

async function loginAction(stage, action, siteId) {
  try {
    await action();
  } catch (error) {
    if (error instanceof AuthenticationNeedsUserAction) throw error;
    // Raw Playwright errors can include the value passed to fill().
    let reason = 'the control could not be operated';
    if (/intercepts pointer events/i.test(error.message)) {
      reason = 'another element covers the control';
    } else if (/not (?:enabled|editable)|disabled|read.?only/i.test(error.message)) {
      reason = 'the control is disabled or not editable';
    } else if (error.name === 'TimeoutError') {
      reason = 'the control did not become ready before the timeout';
    }
    const selector = siteId ? ` --site ${siteId}` : '';
    throw new Error(`Automatic login failed while ${stage}: ${reason}. Run "npm.cmd start -- check${selector} --headed" to inspect the browser. No retry was made.`);
  }
}

export async function automaticLogin(page, {
  portalUrl, credentials, timeout = 30_000, onProgress = () => {}, siteId,
}) {
  const action = (stage, run) => loginAction(stage, run, siteId);
  let opened = false;
  let submitted = false;
  let credentialRequestSent = false;
  let confirmed = false;
  let submittedAt;
  let submitControl;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assertCredentialOrigin(page, portalUrl, credentials);
    if (await isDashboard(page)) return;
    if (await needsChallenge(page)) {
      throw new AuthenticationNeedsUserAction('Login requires MFA, CAPTCHA, or a password update. Complete it in the browser with --headed.');
    }
    if (submitted) {
      if (await evaluatePage(page, passwordLoginRejected)) {
        throw new Error('Sign-in was rejected. Verify your saved credentials; no automatic retry was made.');
      }
      if (!credentialRequestSent && !confirmed && Date.now() - submittedAt >= 1_000 &&
          await page.locator('input[type="password"]:visible').count() === 1) {
        confirmed = true;
        onProgress('Workday has not sent a login request; confirming Sign In once. Only one credential request is permitted.');
        assertCredentialOrigin(page, portalUrl, credentials);
        await action('confirming Sign In', () => submitControl.click({ timeout: 10_000 }));
      }
      await delay(200);
      continue;
    }
    const password = page.locator('input[type="password"]:visible');
    const passwordCount = await password.count();
    if (passwordCount > 1) {
      throw new AuthenticationNeedsUserAction('Multiple password fields were found. Use interactive login; credentials were not entered.');
    }
    if (passwordCount === 1) {
      const username = page.locator('input[data-automation-id="email"]:visible, input[type="email"]:visible, input[autocomplete="username"]:visible, input[name="username"]:visible, input[name="email"]:visible')
        .or(page.getByRole('textbox', { name: /^(email|email address|username|user name)$/i }));
      if (await username.count() !== 1) {
        throw new AuthenticationNeedsUserAction('Could not identify exactly one email field. Use interactive login; credentials were not entered.');
      }
      const form = password.locator('xpath=ancestor::form[1]');
      const dialog = password.locator('xpath=ancestor::*[@role="dialog"][1]');
      const scope = await form.count() ? form : await dialog.count() ? dialog : page;
      const submit = scope.getByRole('button', { name: /^sign in$/i });
      if (await submit.count() !== 1) {
        throw new AuthenticationNeedsUserAction('Could not identify exactly one Sign In button. Use interactive login; credentials were not entered.');
      }
      assertCredentialOrigin(page, portalUrl, credentials);
      onProgress('Entering saved credentials...');
      await action('entering the email address', () =>
        username.fill(credentials.username, { timeout: 10_000 }));
      assertCredentialOrigin(page, portalUrl, credentials);
      await action('entering the password', () =>
        password.fill(credentials.password, { timeout: 10_000 }));
      assertCredentialOrigin(page, portalUrl, credentials);
      // Workday commits password state on blur; clicking while focused can submit stale state.
      await action('committing the password field', () => password.blur({ timeout: 10_000 }));
      assertCredentialOrigin(page, portalUrl, credentials);
      const loginUrl = new URL('login', portalUrl);
      await page.route(url => url.origin === loginUrl.origin && url.pathname === loginUrl.pathname, async route => {
        if (route.request().method() !== 'POST') {
          await route.fallback();
          return;
        }
        if (credentialRequestSent) {
          onProgress('Blocked a duplicate login request; no additional credentials were submitted.');
          await route.abort('blockedbyclient');
          return;
        }
        credentialRequestSent = true;
        await route.fallback();
      });
      submitControl = submit;
      await action('clicking Sign In', () => submit.click({ timeout: 10_000 }));
      onProgress('Sign In clicked once; waiting for Workday to finish login...');
      submitted = true;
      submittedAt = Date.now();
      continue;
    }
    const signIn = page.locator('[data-automation-id="signInLink"]:visible')
      .or(page.getByRole('button', { name: /^sign in$/i }))
      .or(page.getByRole('link', { name: /^sign in$/i }));
    if (!opened && await signIn.count() === 1) {
      await action('opening Sign In', () => signIn.click({ timeout: 10_000 }));
      opened = true;
    }
    await delay(200);
  }
  if (submitted && (await evaluatePage(page, extractPage)).passwordVisible) {
    throw new AuthenticationNeedsUserAction('Workday is still showing Sign In after the submission. In a visible browser, complete Sign In manually. No automatic retry was made.');
  }
  throw new AuthenticationNeedsUserAction('Automatic login did not reach a recognizable application dashboard. Use --headed to complete login or inspect the page. No retry was made.');
}
