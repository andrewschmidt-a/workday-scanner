import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { portalDirectory, loginAllowedHosts } from './config.js';
import { loadCredentials, loadSession, saveSession } from './vault.js';
import { openBrowser, collectApplications } from './browser.js';
import { automaticLogin, AuthenticationNeedsUserAction } from './auth.js';
import { Store } from './store.js';
import { SignInRequired } from './extract.js';

export class BrowserCollectionRequired extends Error {}

export function portalSessionState(state, portalUrl) {
  const { hostname, origin } = new URL(portalUrl);
  return {
    ...state,
    cookies: state.cookies.filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '');
      return hostname === domain || hostname.endsWith(`.${domain}`);
    }),
    origins: state.origins.filter(item => item.origin === origin),
  };
}

export async function returnToPortal(active, portalUrl) {
  if (active.page.isClosed()) active.page = await active.context.newPage();
  await active.page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  active.assertNavigation();
}

async function promptForLogin(site, active) {
  const terminal = createInterface({ input: stdin, output: stderr });
  try {
    const instructions = site.auth === 'google'
      ? 'Choose Sign in with Google, complete sign-in/MFA, and return to Workday My Applications.'
      : 'Sign in, complete any MFA, and open My Applications.';
    await terminal.question(`[${site.name}] ${instructions} Press Enter here when ready. `);
  } finally {
    terminal.close();
  }
  if (site.auth === 'google') await returnToPortal(active, site.url);
}

export async function checkSite(site, {
  directory,
  mode = 'check',
  headed = false,
  allowedHosts = [],
  onProgress = () => {},
}) {
  const secrets = portalDirectory(directory, site.id);
  const store = new Store(directory);
  const google = site.auth === 'google';
  const canInteract = stdin.isTTY && stderr.isTTY;
  let active;
  try {
    if (site.collection === 'browser') {
      throw new BrowserCollectionRequired(
        `Collect ${site.name} in your normal Edge profile using the Workday Status Collector extension. Start "npm.cmd start -- bridge --open-edge --site ${site.id}".`,
      );
    }
    if ((mode === 'interactive' || (google && mode === 'auto')) && !canInteract) {
      throw new Error(`Interactive login requires a terminal. Run "npm.cmd start -- login --site ${site.id}".`);
    }
    const credentials = mode !== 'interactive' && !google
      ? await loadCredentials(secrets, site.url, { optional: mode === 'check', siteId: site.id })
      : undefined;
    const storageState = mode === 'check'
      ? await loadSession(secrets, {
        optional: Boolean(credentials), portalUrl: site.url, siteId: site.id, interactiveOnly: google,
      })
      : undefined;
    active = await openBrowser({
      url: site.url,
      headed: mode !== 'check' || headed,
      storageState,
      allowedHosts: loginAllowedHosts(site, allowedHosts),
    });
    let manualLogin = mode === 'interactive' || (google && mode === 'auto');
    if (google && mode === 'auto') {
      onProgress('Google OAuth requires interactive sign-in; no Google password will be loaded or entered.');
    }
    if (credentials) {
      try {
        await automaticLogin(active.page, { portalUrl: site.url, credentials, onProgress, siteId: site.id });
      } catch (error) {
        active.assertNavigation();
        const interactive = (mode !== 'check' || headed) && canInteract;
        if (!(error instanceof AuthenticationNeedsUserAction) || !interactive) throw error;
        onProgress(error.message);
        manualLogin = true;
      }
    }
    if (manualLogin) {
      await promptForLogin(site, active);
    }
    active.assertNavigation();
    let applications;
    try {
      applications = await collectApplications(active.page);
    } catch (error) {
      if (!google || !(error instanceof SignInRequired)) throw error;
      if (!headed || !canInteract || manualLogin) {
        throw new Error(`Google sign-in is required. Run "npm.cmd start -- login --site ${site.id}" and complete sign-in in the browser.`);
      }
      await promptForLogin(site, active);
      applications = await collectApplications(active.page);
    }
    active.assertNavigation();
    const state = await active.context.storageState({ indexedDB: true });
    await saveSession(secrets, google ? portalSessionState(state, site.url) : state, site.url);
    return store.save(site.id, applications);
  } catch (error) {
    const message = `${error.message} [site: ${site.id}]`;
    if (error instanceof BrowserCollectionRequired) {
      store.requireAction(site.id, message);
      throw new BrowserCollectionRequired(message);
    }
    store.fail(site.id, message);
    throw new Error(message);
  } finally {
    try {
      await active?.browser.close();
    } finally {
      store.close();
    }
  }
}

export async function checkSites(sites, options, run = checkSite) {
  const results = [];
  for (const site of sites) {
    try {
      const snapshot = await run(site, {
        ...options,
        onProgress: message => options.onProgress?.(`[${site.name}] ${message}`),
      });
      results.push({ site: site.id, name: site.name, url: site.url, outcome: 'success', snapshot });
    } catch (error) {
      results.push({
        site: site.id, name: site.name, url: site.url,
        outcome: error instanceof BrowserCollectionRequired ? 'needs_user_action' : 'failed',
        error: error.message,
      });
    }
  }
  return results;
}
