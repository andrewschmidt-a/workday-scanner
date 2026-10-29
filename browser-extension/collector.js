import { extractPage, validatePage, applicationKey } from './shared/extract.js';
import { bridgeRequest } from './client.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function dashboardMatches(value, site) {
  if (typeof value !== 'string') return false;
  try {
    const current = new URL(value);
    const expected = new URL(site.url);
    return current.origin === expected.origin && current.pathname === expected.pathname &&
      !current.username && !current.password;
  } catch {
    return false;
  }
}

function clickNextPage(expectedPortalUrl) {
  const expected = new URL(expectedPortalUrl);
  if (location.origin !== expected.origin || location.pathname !== expected.pathname) {
    throw new Error('The tab left the registered Workday dashboard. Nothing was imported.');
  }
  const candidates = [...document.querySelectorAll('button, a, [role="button"]')].filter(element => {
    const label = element.getAttribute('aria-label') || element.innerText.trim();
    return element.getClientRects().length && /^(next|next page|go to next page)$/i.test(label.trim()) &&
      !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  });
  if (candidates.length !== 1) throw new Error('Could not identify exactly one next-page control.');
  candidates[0].click();
}

async function inject(tabId, site, api, func) {
  const tab = await api.tabs.get(tabId);
  if (!dashboardMatches(tab.url, site)) {
    throw new Error('The tab changed. Open the registered Workday My Applications dashboard and collect again.');
  }
  const values = await api.scripting.executeScript({ target: { tabId }, func, args: [site.url] });
  if (values.length !== 1 || values[0].error) throw new Error('The Workday page could not be read.');
  return values[0].result;
}

async function readySnapshot(tabId, site, api, previous) {
  const deadline = Date.now() + 30_000;
  let stableSince = Date.now();
  let last;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await inject(tabId, site, api, extractPage);
    if (!snapshot) throw new Error('The Workday page returned no collection result.');
    if (snapshot.passwordVisible || snapshot.googleSignInVisible || snapshot.identitySignInVisible) {
      validatePage(snapshot);
    }
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint !== last) stableSince = Date.now();
    last = fingerprint;
    if (JSON.stringify(snapshot.applications) !== previous &&
        (snapshot.applications.length || snapshot.empty) && !snapshot.loading &&
        Date.now() - stableSince >= 750) {
      validatePage(snapshot);
      return snapshot;
    }
    await delay(250);
  }
  validatePage(snapshot);
  throw new Error('The dashboard or next page did not finish loading. Nothing was imported.');
}

export async function collectTab(tabId, site, api = chrome) {
  const applications = [];
  const pages = new Set();
  const keys = new Set();
  let previous;
  for (let index = 0; index < 100; index++) {
    const snapshot = await readySnapshot(tabId, site, api, previous);
    if (index > 0 && !snapshot.applications.length) {
      throw new Error('Pagination reached an unexpected empty page. Nothing was imported.');
    }

    const fingerprint = JSON.stringify(snapshot.applications);
    if (pages.has(fingerprint)) throw new Error('Pagination repeated a page. Nothing was imported.');
    pages.add(fingerprint);
    for (const application of snapshot.applications) {
      const key = applicationKey(application);
      if (keys.has(key)) throw new Error('Duplicate application identities. Nothing was imported.');
      keys.add(key);
      applications.push(application);
    }
    if (!snapshot.hasNext) return { applications, empty: applications.length === 0 };
    previous = fingerprint;
    await inject(tabId, site, api, clickNextPage);
  }
  throw new Error('Pagination exceeded 100 pages. Nothing was imported.');
}

export async function collectAndImport(tabId, site, settings, api = chrome, request = bridgeRequest) {
  const snapshot = await collectTab(tabId, site, api);
  return request(settings, '/observations', { site: site.id, pageUrl: site.url, ...snapshot });
}
