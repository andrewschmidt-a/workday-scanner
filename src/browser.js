import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { extractPage, validatePage, applicationKey } from './extract.js';
import { evaluatePage } from './page.js';

export async function openBrowser({ url, storageState, headed = false, allowedHosts = [] }) {
  const browser = await chromium.launch({ headless: !headed });
  try {
    const context = await browser.newContext({ storageState, serviceWorkers: 'block' });
    const hosts = new Set([new URL(url).hostname, ...allowedHosts]);
    let blockedHost;
    await context.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest()) {
        const destination = new URL(request.url());
        if (destination.protocol !== 'https:' || !hosts.has(destination.hostname)) {
          blockedHost = destination.hostname;
          await route.abort('blockedbyclient');
          return;
        }
      }
      await route.continue();
    });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      if (blockedHost) {
        throw new Error(`Navigation to "${blockedHost}" was blocked. Verify the identity provider, then pass --allow-host ${blockedHost}.`);
      }
      throw error;
    }
    return {
      browser, context, page,
      assertNavigation() {
        if (blockedHost) {
          throw new Error(`Navigation to "${blockedHost}" was blocked. Verify the host before allowing it with --allow-host.`);
        }
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function readySnapshot(page, previous) {
  const deadline = Date.now() + 30_000;
  let stableSince = Date.now();
  let lastFingerprint;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await evaluatePage(page, extractPage);
    if (snapshot.passwordVisible || snapshot.googleSignInVisible || snapshot.identitySignInVisible) validatePage(snapshot);
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint !== lastFingerprint) stableSince = Date.now();
    lastFingerprint = fingerprint;
    const changed = JSON.stringify(snapshot.applications) !== previous;
    const recognizable = snapshot.applications.length || snapshot.empty;
    if (changed && recognizable && !snapshot.loading && Date.now() - stableSince >= 750) {
      validatePage(snapshot);
      return snapshot;
    }
    await delay(250);
  }
  if (previous !== undefined) {
    throw new Error('The next application page did not load completely; no results were saved.');
  }
  validatePage(snapshot);
  throw new Error('The application dashboard did not finish loading; no results were saved.');
}

export async function collectApplications(page) {
  const applications = [];
  const pageFingerprints = new Set();
  const applicationIds = new Set();
  let previous;
  for (let index = 0; index < 100; index++) {
    const snapshot = await readySnapshot(page, previous);
    if (index > 0 && !snapshot.applications.length) {
      throw new Error('Pagination reached an unexpected empty page; no results were saved.');
    }
    const fingerprint = JSON.stringify(snapshot.applications);
    if (pageFingerprints.has(fingerprint)) throw new Error('Pagination repeated a page; refusing to save incomplete results.');
    pageFingerprints.add(fingerprint);
    for (const application of snapshot.applications) {
      const key = applicationKey(application);
      if (applicationIds.has(key)) {
        throw new Error('Applications have duplicate identities. The portal adapter needs a more specific application identifier.');
      }
      applicationIds.add(key);
      applications.push({ ...application, key });
    }
    if (!snapshot.hasNext) return applications;
    previous = fingerprint;
    await page.getByRole('button', { name: /^(next|next page|go to next page)$/i })
      .or(page.getByRole('link', { name: /^(next|next page|go to next page)$/i })).click();
  }
  throw new Error('Pagination exceeded 100 pages; no results were saved.');
}
