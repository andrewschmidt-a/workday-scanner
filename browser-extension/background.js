import { pairingSettings, bridgeRequest } from './client.js';
import { dashboardMatches, collectAndImport } from './collector.js';
import { possibleSignInPage, googleEntryMatches, startGoogleSignIn } from './signin.js';
import { hourlyAlarm, configureHourly, runHourlyBatch } from './hourly.js';
import { passwordEntryMatches, startPasswordSignIn } from './password.js';

let collecting = false;
let hourlyPending = false;
let scheduleSync = Promise.resolve();
const signingIn = new Map();

function reportHourlyError(error) {
  console.error(`Hourly Workday collection: ${error.message}`);
  void chrome.storage.local.set({
    lastResult: { ok: false, message: `Hourly collection stopped: ${error.message}` },
  }).catch(storageError => console.error(`Could not save hourly notice: ${storageError.message}`));
}

function finishCollection() {
  collecting = false;
  if (hourlyPending) {
    hourlyPending = false;
    void runHourly().catch(reportHourlyError);
  }
}

async function runHourly(scheduled = true) {
  if (collecting) {
    if (!scheduled) throw new Error('A collection is already running. Wait for it to finish.');
    hourlyPending = true;
    return;
  }
  collecting = true;
  const startedAt = new Date().toISOString();
  try {
    const saved = await chrome.storage.local.get(['port', 'token', 'hourlyEnabled']);
    if (scheduled && saved.hourlyEnabled === false) return;
    const settings = pairingSettings(saved.port || 8765, saved.token);
    await chrome.storage.local.set({
      lastResult: { ok: false, message: 'Collecting all registered Workday sites. Dashboard tabs may refresh; MFA and Google account selection remain manual.' },
    });
    const { sites, passwordLoginEnabled } = await bridgeRequest(settings, '/sites');
    const results = await runHourlyBatch(sites, settings, chrome, bridgeRequest, passwordLoginEnabled);
    const count = results.filter(result => result.outcome === 'success').length;
    const message = `Collected ${count}/${results.length} sites at ${new Date().toLocaleTimeString()}.` +
      results.filter(result => result.outcome !== 'success').map(result => `\n${result.name}: ${result.error}`).join('');
    await chrome.storage.local.set({
      hourlyLastRun: { startedAt, finishedAt: new Date().toISOString(), results },
      lastResult: { ok: count === results.length, message },
    });
    return { ok: count === results.length, message };
  } catch (error) {
    await chrome.storage.local.set({
      hourlyLastRun: { startedAt, finishedAt: new Date().toISOString(), error: error.message },
    });
    throw error;
  } finally {
    finishCollection();
  }
}

function syncHourly(runNow = false) {
  scheduleSync = scheduleSync.then(async () => {
    const state = await configureHourly();
    if (state.active && (state.created || runNow)) void runHourly().catch(reportHourlyError);
  }).catch(reportHourlyError);
  return scheduleSync;
}

async function hourlyStatus() {
  await syncHourly();
  const saved = await chrome.storage.local.get(['hourlyEnabled', 'hourlyLastRun']);
  const alarm = await chrome.alarms.get(hourlyAlarm);
  return {
    enabled: saved.hourlyEnabled !== false,
    nextCheck: alarm?.scheduledTime || null,
    running: collecting,
    lastRun: saved.hourlyLastRun || null,
  };
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === hourlyAlarm) void runHourly().catch(reportHourlyError);
});

async function checkSignIn(tab) {
  if (!possibleSignInPage(tab.url) || tab.status === 'loading') return;
  if (signingIn.has(tab.id)) {
    signingIn.set(tab.id, tab);
    return;
  }
  signingIn.set(tab.id, null);
  try {
    const saved = await chrome.storage.local.get(['port', 'token']);
    if (!saved.token) return;
    const settings = pairingSettings(saved.port || 8765, saved.token);
    const { sites, passwordLoginEnabled } = await bridgeRequest(settings, '/sites');
    const site = sites.find(item => googleEntryMatches(tab.url, item) ||
      (passwordLoginEnabled && passwordEntryMatches(tab.url, item)));
    if (!site) return;
    const result = site.auth === 'google'
      ? await startGoogleSignIn(tab.id, site)
      : await startPasswordSignIn(tab.id, site, settings);
    if (result.message) {
      await chrome.storage.local.set({ lastResult: { ok: false, message: result.message } });
    }
  } finally {
    const pending = signingIn.get(tab.id);
    signingIn.delete(tab.id);
    if (pending) void checkSignIn(pending).catch(reportSignInError);
  }
}

function reportSignInError(error) {
  console.error(`Automatic Workday sign-in: ${error.message}`);
  void chrome.storage.local.set({
    lastResult: { ok: false, message: `Automatic Workday sign-in stopped: ${error.message}` },
  }).catch(storageError => console.error(`Could not save sign-in notice: ${storageError.message}`));
}

async function scanSignInTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => checkSignIn(tab).catch(reportSignInError)));
}

async function signInStatus() {
  const saved = await chrome.storage.local.get(['port', 'token']);
  const settings = pairingSettings(saved.port || 8765, saved.token);
  const { sites, passwordLoginEnabled } = await bridgeRequest(settings, '/sites');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = sites.find(item => dashboardMatches(tab?.url, item) ||
    dashboardMatches(tab?.url, { url: new URL('login', item.url).href }));
  if (!site) {
    throw new Error('Bridge connected, but this tab is not a registered Workday dashboard or login page. Open the configured employer My Applications URL in this Edge profile.');
  }
  const google = googleEntryMatches(tab.url, site);
  if (google || passwordLoginEnabled) void checkSignIn(tab).catch(reportSignInError);
  return {
    ok: true,
    message: `Connected to the local bridge. ${site.name} is registered; ` +
      (google ? 'checking automatic Google sign-in. See the sign-in notice below.' :
        passwordLoginEnabled ? 'checking password login using this site\'s saved credentials.' :
          'password login is disabled; restart the bridge with --allow-password-login to enable it.'),
  };
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'complete' || change.url) {
    void checkSignIn(tab).catch(reportSignInError);
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  void (async () => {
    const stored = await chrome.storage.session.get(null);
    const keys = Object.keys(stored).filter(key => key.startsWith(`google-entry:${tabId}:`));
    if (keys.length) await chrome.storage.session.remove(keys);
  })().catch(reportSignInError);
});
chrome.runtime.onInstalled.addListener(() => { void scanSignInTabs().catch(reportSignInError); });
chrome.runtime.onStartup.addListener(() => { void scanSignInTabs().catch(reportSignInError); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.port || changes.token)) {
    void scanSignInTabs().catch(reportSignInError);
  }
  if (area === 'local' && (changes.port || changes.token || changes.hourlyEnabled)) {
    void syncHourly(Boolean(changes.token?.oldValue || changes.port?.oldValue));
  }
});

async function collect() {
  const saved = await chrome.storage.local.get(['port', 'token']);
  const settings = pairingSettings(saved.port || 8765, saved.token);
  const { sites } = await bridgeRequest(settings, '/sites');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = sites.find(item => dashboardMatches(tab?.url, item));
  if (!site) {
    if (sites.some(item => googleEntryMatches(tab?.url, item))) {
      throw new Error('Workday sign-in is still required. Automatic sign-in only clicks Workday\'s Google button; complete Google login, return to My Applications, and collect again.');
    }
    throw new Error('Open a registered Workday My Applications dashboard. Google and identity-provider pages are not read.');
  }
  const result = await collectAndImport(tab.id, site, settings);
  return `Saved ${result.applications.length} application(s) for ${site.name} at ${result.checkedAt}.`;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'hourly-status') {
    void hourlyStatus().then(result => reply({ ok: true, ...result }),
      error => reply({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === 'collect-all') {
    void runHourly(false).then(reply,
      error => reply({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type === 'signin-status') {
    void signInStatus().then(reply, error => reply({ ok: false, message: error.message }));
    return true;
  }
  if (message?.type !== 'collect') return false;
  if (collecting) {
    reply({ ok: false, message: 'A collection is already running. Wait for it to finish.' });
    return false;
  }
  collecting = true;
  void (async () => {
    let result;
    try {
      result = { ok: true, message: await collect() };
    } catch (error) {
      result = { ok: false, message: error.message };
    }
    try {
      await chrome.storage.local.set({ lastResult: result });
      reply(result);
    } catch {
      reply({ ok: false, message: 'Could not save the collection result locally. Check the tracker report before retrying.' });
    } finally {
      finishCollection();
    }
  })();
  return true;
});

void scanSignInTabs().catch(reportSignInError);
void syncHourly();
