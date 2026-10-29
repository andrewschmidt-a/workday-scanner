import { bridgeRequest } from './client.js';
import { dashboardMatches } from './collector.js';
import { extractPage } from './shared/extract.js';
import {
  credentialPageMatches, hasLoginChallenge, passwordLoginRejected, passwordFormStep, passwordRequestGuard,
} from './shared/login-dom.js';

const activeSites = new Set();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function passwordEntryMatches(value, site) {
  return site.auth !== 'google' && credentialPageMatches(value, site.url);
}

async function inject(tabId, site, api, func, args = [], world = 'ISOLATED') {
  const tab = await api.tabs.get(tabId);
  if (!passwordEntryMatches(tab.url, site)) throw new Error('The tab left the registered Workday password-login page.');
  try {
    const values = await api.scripting.executeScript({ target: { tabId }, world, func, args });
    if (values.length !== 1 || values[0].error || values[0].result === undefined) throw new Error();
    return values[0].result;
  } catch {
    throw new Error('The Workday password form could not be operated safely. No retry was made; inspect its Edge tab.');
  }
}

export async function startPasswordSignIn(tabId, site, settings, api = chrome, request = bridgeRequest) {
  if (site.auth === 'google') return { state: 'left' };
  if (activeSites.has(site.id)) return { state: 'pending', message: `${site.name} password login is already running in another check.` };
  activeSites.add(site.id);
  const key = `password-entry:${site.id}`;
  let secret;
  let opened = false;
  let submittedAt;
  let confirmed = false;
  let filled = false;
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      const tab = await api.tabs.get(tabId);
      if (!passwordEntryMatches(tab.url, site)) return { state: 'left' };
      if (tab.status === 'loading') {
        await delay(250);
        continue;
      }
      if (dashboardMatches(tab.url, site)) {
        let snapshot;
        try {
          snapshot = await inject(tabId, site, api, extractPage, [site.url]);
        } catch (error) {
          const current = await api.tabs.get(tabId);
          if (passwordEntryMatches(current.url, site) && !dashboardMatches(current.url, site)) continue;
          throw error;
        }
        if (!snapshot.passwordVisible && !snapshot.googleSignInVisible && !snapshot.loading &&
            !snapshot.problems.length && (snapshot.applications.length || snapshot.empty)) {
          await api.storage.local.remove(key);
          return { state: 'authenticated' };
        }
      }
      if (await inject(tabId, site, api, hasLoginChallenge)) {
        return { state: 'manual', message: `${site.name} requires MFA, CAPTCHA, or a password update. Complete it in Edge; no automatic retry will be made.` };
      }
      if (submittedAt) {
        if (await inject(tabId, site, api, passwordLoginRejected)) {
          return { state: 'manual', message: `${site.name} rejected sign-in. Update its saved credentials or sign in manually. Automatic retries are blocked until credentials change or a signed-in dashboard is recognized.` };
        }
        const guard = await inject(tabId, site, api, passwordRequestGuard, [site.url], 'MAIN');
        if (!guard.active) return { state: 'manual', message: 'Manual interaction took over Workday sign-in. Finish it in Edge; automatic login has stopped.' };
        if (!guard.requests && !confirmed && Date.now() - submittedAt >= 1000) {
          confirmed = true;
          await inject(tabId, site, api, passwordFormStep, [site.url, 'submit']);
        }
      } else {
        const probe = await inject(tabId, site, api, passwordFormStep, [site.url]);
        if (probe.state === 'manual') return probe;
        if (probe.state === 'entry' && !opened) {
          opened = true;
          await inject(tabId, site, api, passwordFormStep, [site.url, 'open']);
        }
        if (probe.state === 'form') {
          if (!filled) {
            const previous = (await api.storage.local.get(key))[key];
            const pageUrl = new URL(tab.url);
            pageUrl.search = '';
            pageUrl.hash = '';
            let response;
            try {
              response = await request(settings, '/credentials', {
                site: site.id, pageUrl: pageUrl.href,
                ...(previous?.portalUrl === site.url ? { blockedRevision: previous.revision } : {}),
              });
            } catch (error) {
              if (error.status === 403 || error.status === 409) return { state: 'manual', message: error.message };
              throw error;
            }
            if (response.state === 'blocked') {
              return { state: 'manual', message: `${site.name}: a previous password-login attempt needs attention. Sign in manually or update saved credentials; no retry was made.` };
            }
            secret = response.credentials;
            if (response.state !== 'ready' || typeof response.revision !== 'string' ||
                !/^[a-f0-9]{64}$/.test(response.revision) ||
                secret?.portalUrl !== site.url || secret.origin !== new URL(site.url).origin ||
                typeof secret.username !== 'string' || typeof secret.password !== 'string') {
              throw new Error('The bridge did not return credentials bound to this Workday portal.');
            }
            await api.storage.local.set({ [key]: { portalUrl: site.url, revision: response.revision } });
            await inject(tabId, site, api, passwordRequestGuard, [site.url, 'install'], 'MAIN');
            if (await inject(tabId, site, api, hasLoginChallenge)) {
              return { state: 'manual', message: `${site.name} requires verification. Complete it in Edge; credentials were not entered.` };
            }
            const fill = await inject(tabId, site, api, passwordFormStep, [site.url, 'fill', secret]);
            secret = undefined;
            if (fill.state !== 'filled') return fill;
            filled = true;
          }
          const guard = await inject(tabId, site, api, passwordRequestGuard, [site.url], 'MAIN');
          if (!guard.active) return { state: 'manual', message: 'Manual interaction took over Workday sign-in. Finish it in Edge; automatic login has stopped.' };
          const submitted = await inject(tabId, site, api, passwordFormStep, [site.url, 'submit']);
          if (submitted.state === 'manual') return submitted;
          if (submitted.state === 'submitted') submittedAt = Date.now();
        }
      }
      await delay(250);
    }
    return { state: 'manual', message: `${site.name} did not complete password login within 30 seconds. Inspect its Edge tab; automatic retries are blocked until credentials change or you sign in manually.` };
  } finally {
    secret = undefined;
    activeSites.delete(site.id);
  }
}
