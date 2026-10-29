import { pairingSettings } from './client.js';

const port = document.getElementById('port');
const token = document.getElementById('token');
const status = document.getElementById('status');
const collect = document.getElementById('collect');
const connection = document.getElementById('connection');
const version = chrome.runtime.getManifest().version;
const hourlyEnabled = document.getElementById('hourly-enabled');
const hourlyStatus = document.getElementById('hourly-status');
const collectAll = document.getElementById('collect-all');

async function refreshHourly() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'hourly-status' });
    if (!result.ok) throw new Error(result.message);
    hourlyEnabled.checked = result.enabled;
    hourlyStatus.textContent = !result.enabled ? 'Hourly collection paused.' :
      result.nextCheck ? `Next check: ${new Date(result.nextCheck).toLocaleString()}.` :
        'Pair the extension to start hourly collection.';
    if (result.running) hourlyStatus.textContent += ' A collection is running.';
    if (result.lastRun) {
      hourlyStatus.textContent += ` Last batch: ${new Date(result.lastRun.finishedAt).toLocaleString()}.`;
      if (result.lastRun.error) hourlyStatus.textContent += ` Failed: ${result.lastRun.error}`;
      if (result.lastRun.results) {
        const results = result.lastRun.results;
        hourlyStatus.textContent += ` ${results.filter(site => site.outcome === 'success').length}/${results.length} sites collected.`;
        for (const site of results.filter(site => site.outcome !== 'success')) {
          hourlyStatus.textContent += `\n${site.name}: ${site.error}`;
        }
      }
    }
  } catch (error) {
    hourlyStatus.textContent = `Could not read the schedule: ${error.message}`;
  }
}

async function refreshConnection() {
  connection.textContent = `Version ${version}. Checking the local bridge and current tab...`;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'signin-status' });
    connection.textContent = `Version ${version}. ${result.message}`;
  } catch {
    connection.textContent = `Version ${version}. Could not contact the extension background worker. Reload this extension at edge://extensions, then refresh Workday.`;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lastResult?.newValue?.message && !collect.disabled) {
    status.textContent = changes.lastResult.newValue.message;
  }
  if (area === 'local' && (changes.hourlyLastRun || changes.hourlyEnabled)) void refreshHourly();
});

try {
  const saved = await chrome.storage.local.get(['port', 'token', 'lastResult']);
  port.value = saved.port || 8765;
  token.value = saved.token || '';
  status.textContent = saved.lastResult?.message || 'Start the local bridge, then save its pairing token here.';
} catch {
  status.textContent = 'Could not load extension settings.';
}
void refreshConnection();
void refreshHourly();

hourlyEnabled.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ hourlyEnabled: hourlyEnabled.checked });
    await refreshHourly();
  } catch (error) {
    hourlyStatus.textContent = `Could not change the schedule: ${error.message}`;
  }
});

collectAll.addEventListener('click', async () => {
  collectAll.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'collect-all' });
    status.textContent = result.message;
    await refreshHourly();
  } catch {
    status.textContent = 'The batch collector stopped unexpectedly. Check the report before retrying.';
  } finally {
    collectAll.disabled = false;
  }
});

document.getElementById('pairing').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await chrome.storage.local.set(pairingSettings(port.value, token.value));
    status.textContent = 'Pairing saved. Open your Workday dashboard and collect.';
    await refreshConnection();
  } catch (error) {
    status.textContent = error.message;
  }
});

collect.addEventListener('click', async () => {
  collect.disabled = true;
  status.textContent = 'Reading application pages. Keep this Workday tab open until collection finishes.';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'collect' });
    status.textContent = result.message;
  } catch {
    status.textContent = 'The collector stopped unexpectedly. Check the tracker report before retrying.';
  } finally {
    collect.disabled = false;
  }
});
