import { dashboardMatches } from './collector.js';
import { extractPage } from './shared/extract.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function possibleSignInPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname.endsWith('.myworkdayjobs.com') || url.hostname.endsWith('.myworkdaysite.com')) &&
      /\/(?:userHome|login)$/.test(url.pathname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function googleEntryMatches(value, site) {
  return site.auth === 'google' && site.collection === 'browser' &&
    (dashboardMatches(value, site) ||
      dashboardMatches(value, { url: new URL('login', site.url).href }));
}

// Runs only in the registered Workday top frame, never in the identity provider.
export function googleEntryStep(expectedPortalUrl, action) {
  const expected = new URL(expectedPortalUrl);
  const login = new URL('login', expected);
  if (location.origin !== expected.origin ||
      ![expected.pathname, login.pathname].includes(location.pathname)) {
    throw new Error('The tab left the registered Workday sign-in page.');
  }
  const visible = element => element.getClientRects().length &&
    !element.closest('[aria-hidden="true"]') &&
    getComputedStyle(element).visibility === 'visible';
  const label = element => (element.getAttribute('aria-label') || element.innerText || '')
    .trim().replace(/\s+/g, ' ');
  const controls = [...document.querySelectorAll('button, a, [role="button"]')].filter(visible);
  const google = controls.filter(element =>
    /^(sign in|continue) with google$/i.test(label(element)) &&
    (location.pathname === login.pathname ||
      element.getAttribute('data-automation-id') === 'GoogleSignInButton' ||
      element.closest('[data-automation-id="signInContent"], [data-automation-id="auth_container"], [role="dialog"]')));
  if (google.length > 1) throw new Error('Multiple Google sign-in controls were found. Choose one manually.');
  const passwordVisible = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const entry = passwordVisible ? [] : controls.filter(element =>
    /^sign in$/i.test(label(element)) && !element.closest('form') &&
    element.getAttribute('type') !== 'submit' &&
    element.getAttribute('data-automation-id') !== 'signInSubmitButton');
  if (!google.length && entry.length > 1) {
    throw new Error('Multiple Workday Sign In controls were found. Open sign-in manually.');
  }
  const target = google[0] || entry[0];
  if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') {
    return { state: 'waiting' };
  }
  let rect = target.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth) {
    target.scrollIntoView({ block: 'center', inline: 'center' });
    rect = target.getBoundingClientRect();
  }
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!hit || !target.contains(hit)) {
    return {
      state: 'blocked',
      message: 'Workday sign-in is covered by a dialog or another control. Handle cookie/consent choices yourself, then reload the page or click Google manually.',
    };
  }
  if (google.length) {
    if (action !== 'google') return { state: 'google' };
    target.click();
    return { state: 'clicked' };
  }
  if (action !== 'open') return { state: 'entry' };
  target.click();
  return { state: 'opened' };
}

async function inject(tabId, site, api, func, args) {
  const tab = await api.tabs.get(tabId);
  if (!googleEntryMatches(tab.url, site)) {
    throw new Error('The tab left the registered Workday sign-in page.');
  }
  const results = await api.scripting.executeScript({ target: { tabId }, func, args });
  if (results.length !== 1 || results[0].error || !results[0].result) {
    throw new Error('The Workday sign-in page could not be inspected.');
  }
  return results[0].result;
}

export async function startGoogleSignIn(tabId, site, api = chrome) {
  const key = `google-entry:${tabId}:${site.id}`;
  const saved = (await api.storage.session.get(key))[key];
  const attempt = saved?.portalUrl === site.url ? saved : undefined;
  let opened = Boolean(attempt);
  let last;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const tab = await api.tabs.get(tabId);
    if (!googleEntryMatches(tab.url, site)) return { state: 'left' };
    if (tab.status === 'loading') {
      await delay(500);
      continue;
    }
    if (dashboardMatches(tab.url, site)) {
      let snapshot;
      try {
        snapshot = await inject(tabId, site, api, extractPage, [site.url]);
      } catch (error) {
        const current = await api.tabs.get(tabId);
        if (googleEntryMatches(current.url, site) && !dashboardMatches(current.url, site)) continue;
        throw error;
      }
      if (!snapshot.passwordVisible && !snapshot.googleSignInVisible &&
          !snapshot.identitySignInVisible && !snapshot.loading && !snapshot.problems.length &&
          (snapshot.applications.length || snapshot.empty)) {
        await api.storage.session.remove(key);
        return { state: 'authenticated' };
      }
    }
    if (attempt?.stage === 'clicked') {
      return {
        state: 'manual',
        message: 'Automatic Google sign-in was already attempted in this tab; it will not retry. Complete sign-in, click Workday\'s Google button manually, or reopen the dashboard in a new tab.',
      };
    }
    last = await inject(tabId, site, api, googleEntryStep, [site.url, 'probe']);
    if (last.state === 'google') {
      await api.storage.session.set({ [key]: { portalUrl: site.url, stage: 'clicked' } });
      const clicked = await inject(tabId, site, api, googleEntryStep, [site.url, 'google']);
      if (clicked.state !== 'clicked') {
        throw new Error('The Google sign-in control changed before it could be clicked. No retry was made; click it manually.');
      }
      return {
        state: 'clicked',
        message: `Clicked ${site.name}'s Workday Google sign-in button. Complete any Google account selection or MFA, then return to My Applications and collect. If no sign-in page opens, check Edge's popup blocker or click Google manually.`,
      };
    }
    if (last.state === 'entry' && !opened) {
      opened = true;
      await api.storage.session.set({ [key]: { portalUrl: site.url, stage: 'opened' } });
      await inject(tabId, site, api, googleEntryStep, [site.url, 'open']);
    }
    await delay(500);
  }
  throw new Error(last?.message ||
    'No usable Workday Google sign-in button appeared within 30 seconds. Open Google sign-in manually; no credentials were entered.');
}
