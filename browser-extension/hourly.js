import { bridgeRequest } from './client.js';
import { dashboardMatches, collectAndImport } from './collector.js';
import { extractPage, SignInRequired } from './shared/extract.js';
import { passwordEntryMatches, startPasswordSignIn } from './password.js';
import { hasLoginChallenge } from './shared/login-dom.js';

export const hourlyAlarm = 'workday-hourly-collection';
export const hourlyMinutes = 60;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function configureHourly(api = chrome) {
  const saved = await api.storage.local.get(['hourlyEnabled', 'token']);
  if (saved.hourlyEnabled === false || !saved.token) {
    await api.alarms.clear(hourlyAlarm);
    return { active: false, created: false };
  }
  const alarm = await api.alarms.get(hourlyAlarm);
  if (alarm?.periodInMinutes === hourlyMinutes) return { active: true, created: false };
  await api.alarms.create(hourlyAlarm, { delayInMinutes: hourlyMinutes, periodInMinutes: hourlyMinutes });
  return { active: true, created: true };
}

function loginMatches(url, site) {
  return dashboardMatches(url, { url: new URL('login', site.url).href });
}

function signInMessage(site) {
  if (site.auth === 'google') {
    return `Complete Google sign-in and any MFA in ${site.name}'s normal Edge tab, then return to My Applications.`;
  }
  return `Sign in to ${site.name} in its normal Edge tab, complete any MFA, and return to My Applications. Enable bridge password login to use saved Workday credentials.`;
}

async function dashboardTab(site, api, allowPasswordLogin) {
  const tabs = await api.tabs.query({});
  const key = `hourly-tab:${site.id}`;
  const saved = (await api.storage.session.get(key))[key];
  const owned = saved?.portalUrl === site.url ? tabs.find(tab => tab.id === saved.tabId) : undefined;
  let tab = tabs.find(item => dashboardMatches(item.url, site)) ||
    tabs.find(item => loginMatches(item.url, site)) || owned;
  let navigating = false;
  if (!tab) {
    tab = await api.tabs.create({ url: 'about:blank', active: false });
    await api.storage.session.set({ [key]: { tabId: tab.id, portalUrl: site.url } });
    await api.tabs.update(tab.id, { url: site.url });
    navigating = true;
  }
  else if (dashboardMatches(tab.url, site) && tab.status !== 'loading') {
    const values = await api.scripting.executeScript({
      target: { tabId: tab.id }, func: extractPage, args: [site.url],
    });
    if (values.length !== 1 || values[0].error || !values[0].result) {
      throw new Error('Could not inspect the existing dashboard. Its tab was not refreshed.');
    }
    const snapshot = values[0].result;
    const challenge = await api.scripting.executeScript({ target: { tabId: tab.id }, func: hasLoginChallenge });
    if (challenge.length !== 1 || challenge[0].error || challenge[0].result === undefined) {
      throw new Error('Could not inspect Workday verification controls. Its tab was not refreshed.');
    }
    if (challenge[0].result === true) {
      throw new SignInRequired(`${site.name} requires MFA, CAPTCHA, or a password update. Complete it in its Edge tab; it was not refreshed.`);
    }
    if (snapshot.passwordVisible && !allowPasswordLogin) throw new SignInRequired(signInMessage(site));
    if (!snapshot.googleSignInVisible && !snapshot.passwordVisible) {
      if (tab.url === site.url) await api.tabs.reload(tab.id);
      else await api.tabs.update(tab.id, { url: site.url });
      navigating = true;
    }
  }
  await api.storage.session.set({ [key]: { tabId: tab.id, portalUrl: site.url } });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const current = await api.tabs.get(tab.id);
    if (navigating && (!current.url || current.url === 'about:blank' ||
        dashboardMatches(current.pendingUrl, site))) {
      await delay(500);
      continue;
    }
    if (current.status !== 'loading') {
      if (dashboardMatches(current.url, site)) return current;
      if (allowPasswordLogin && passwordEntryMatches(current.url, site)) return current;
      if (!loginMatches(current.url, site) || site.auth !== 'google' || site.collection !== 'browser') {
        throw new SignInRequired(signInMessage(site));
      }
    }
    await delay(500);
  }
  const current = await api.tabs.get(tab.id);
  if (!dashboardMatches(current.url, site)) throw new SignInRequired(signInMessage(site));
  throw new Error('The Workday dashboard did not finish loading within 60 seconds.');
}

function safeError(error) {
  return String(error.message || 'The browser collection failed.')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[URL omitted]').slice(0, 1800);
}

export async function runHourlyBatch(sites, settings, api = chrome, request = bridgeRequest, allowPasswordLogin = false) {
  const results = [];
  for (const site of sites) {
    try {
      const tab = await dashboardTab(site, api, allowPasswordLogin);
      if (allowPasswordLogin && passwordEntryMatches(tab.url, site)) {
        const deadline = Date.now() + 35_000;
        let login;
        do {
          login = await startPasswordSignIn(tab.id, site, settings, api, request);
          if (login.state !== 'pending') break;
          await delay(250);
        } while (Date.now() < deadline);
        if (login.state !== 'authenticated') {
          throw new SignInRequired(login.message || signInMessage(site));
        }
      }
      const snapshot = await collectAndImport(tab.id, site, settings, api, request);
      results.push({
        site: site.id, name: site.name, outcome: 'success',
        checkedAt: snapshot.checkedAt, applications: snapshot.applications.length,
      });
    } catch (error) {
      const outcome = error instanceof SignInRequired ? 'needs_user_action' : 'failed';
      let message = safeError(error);
      try {
        await request(settings, '/checks', { site: site.id, outcome, error: message });
      } catch (recordError) {
        message += ` Latest check could not be recorded: ${safeError(recordError)}`;
      }
      results.push({ site: site.id, name: site.name, outcome, error: message });
    }
  }
  return results;
}
