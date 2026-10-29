import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { portal, dataDirectory, loadPortals, portalDirectory } from './config.js';
import {
  forgetSession, saveCredentials, forgetCredentials,
} from './vault.js';
import { checkSite, checkSites } from './tracker.js';
import { promptPassword } from './prompt.js';
import { Store } from './store.js';
import { startBridge } from './bridge.js';
import { openEdge } from './edge.js';

const help = `Workday application status tracker

  npm.cmd start -- sites              List configured Workday sites
  npm.cmd start -- bridge             Start the local browser collector bridge
  npm.cmd start -- credentials        Save credentials for password-based sites
  npm.cmd start -- login              Sign in interactively (normal Edge for browser collection)
  npm.cmd start -- login --auto       Sign in using saved credentials
  npm.cmd start -- check [--headed]    Reuse session or sign in with saved credentials
  npm.cmd start -- report [--json]     Report all sites (or select one with --site)
  npm.cmd start -- history [--json]    Show all recorded status observations
  npm.cmd start -- logout             Remove saved session and credentials; keep history

Options:
  --site ID                          Select one site (report defaults to all; others to 3m)
  --all                              Check/report/history across all configured sites
  --json                             Output machine-readable JSON
  --headed                           Show the browser during a check
  --open-edge                        Open selected site in normal Edge (bridge only)
  --port NUMBER                      Local bridge port (default: 8765)
  --allow-password-login             Allow paired Edge extension to use saved Workday passwords
  --auto                             Use saved credentials for the login command
  --allow-host HOST                   Allow a verified login host (repeatable)
  --help                             Show this help

Sessions and saved credentials use Windows account-bound DPAPI encryption.
Set WORKDAY_TRACKER_HOME to change the local storage directory.
Use a separate directory for each candidate account.
Each site has its own encrypted credentials and session.
Google OAuth sites use interactive login; Google passwords are never saved.
Use --site wells-fargo for Wells Fargo; existing 3M storage is preserved.
`;

function print(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    console.table(value);
    return;
  }
  if (value.latestCheck !== undefined) {
    if (!value.latestCheck) {
      console.log('No checks recorded.');
      return;
    }
    console.log(`Last check: ${value.latestCheck.checkedAt} (${value.latestCheck.outcome})`);
    if (value.latestCheck.error) console.error(value.latestCheck.error);
    value = value.lastSuccessfulCheck;
    if (!value) return;
  }
  console.log(`Last successful check: ${value.checkedAt}`);
  console.table(value.applications.map(({ title, status, requisitionId, url }) => ({
    title, status, requisitionId, url,
  })));
  if (!value.applications.length) console.log('The portal explicitly reported no applications.');
  if (value.changes?.length) {
    console.log('Status text changes:');
    console.table(value.changes);
  }
}

function printSites(sites, json, kind) {
  if (json) {
    console.log(JSON.stringify({ sites }, null, 2));
    return;
  }
  for (const site of sites) {
    console.log(`\n${site.name} (${site.site})`);
    if (site.outcome && site.outcome !== 'success') {
      console.error(`${site.outcome === 'needs_user_action' ? 'Action required' : 'Error'}: ${site.error}`);
    } else if (kind === 'check') {
      print(site.snapshot, false);
    } else if (kind === 'history') {
      print(site.history, false);
    } else {
      print(site, false);
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      json: { type: 'boolean' },
      headed: { type: 'boolean' },
      auto: { type: 'boolean' },
      site: { type: 'string' },
      all: { type: 'boolean' },
      'open-edge': { type: 'boolean' },
      port: { type: 'string' },
      'allow-password-login': { type: 'boolean' },
      'allow-host': { type: 'string', multiple: true, default: [] },
    },
  });
  if (values.help || !positionals.length) {
    console.log(help);
    return;
  }
  const [command] = positionals;
  if (positionals.length !== 1 || !['sites', 'bridge', 'credentials', 'login', 'check', 'report', 'history', 'logout'].includes(command)) {
    throw new Error('Unknown command. Run "npm.cmd start -- --help".');
  }
  if (values.auto && command !== 'login') {
    throw new Error('--auto applies only to login. The check command automatically uses saved credentials when needed.');
  }
  if (values.all && values.site) throw new Error('Use either --site or --all, not both.');
  if (values.all && !['check', 'report', 'history'].includes(command)) {
    throw new Error('--all is supported only for check, report, and history. Credentials and login are configured per site.');
  }
  if ((values['open-edge'] || values.port !== undefined || values['allow-password-login']) && command !== 'bridge') {
    throw new Error('--open-edge, --port, and --allow-password-login apply only to the bridge command.');
  }
  for (const host of values['allow-host']) {
    if (!/^[a-z0-9.-]+$/i.test(host) || host.includes('..')) {
      throw new Error('--allow-host requires an exact hostname, not a URL or wildcard.');
    }
  }
  const directory = dataDirectory();
  const sites = await loadPortals(directory);
  if (command === 'sites') {
    if (values.site) throw new Error('The sites command lists every configured site; do not pass --site.');
    if (values.json) console.log(JSON.stringify({ sites }, null, 2));
    else console.table(sites);
    return;
  }
  const site = sites.find(item => item.id === (values.site || portal.id));
  if (!site) throw new Error('Unknown site. Run "npm.cmd start -- sites" for available IDs.');
  const allSites = values.all || (command === 'report' && !values.site);
  const selected = allSites ? sites : [site];
  const secrets = portalDirectory(directory, site.id);
  if (command === 'bridge') {
    const port = values.port === undefined ? 8765 : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer from 1 to 65535.');
    const extensionDirectory = resolve(import.meta.dirname, '..', 'browser-extension');
    try {
      for (const filename of ['extract.js', 'login-dom.js']) {
        await access(resolve(extensionDirectory, 'shared', filename));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error('Build the browser collector first: "npm.cmd run extension:build".');
    }
    const bridge = await startBridge({ directory, port, allowPasswordLogin: Boolean(values['allow-password-login']) });
    try {
      if (values['open-edge']) await openEdge(site.url);
    } catch (error) {
      await bridge.close();
      throw error;
    }
    console.log(`Local collector: ${bridge.url}`);
    console.log(`Pairing token: ${bridge.token}`);
    console.log('Keep this token local. It changes whenever this bridge restarts.');
    if (values['allow-password-login']) console.log('Password login enabled: the pairing token permits access to saved Workday passwords. Keep it private.');
    console.log(`Load unpacked extension from: ${extensionDirectory}`);
    console.log('Keep this terminal open. Sign in normally in Edge, then collect from the Workday dashboard.');
    const stop = () => {
      void bridge.close().catch(error => {
        console.error(`Could not close the local collector: ${error.message}`);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  if (command === 'login' && site.collection === 'browser') {
    await openEdge(site.url);
    console.log(`Opened ${site.name} in normal Edge. ${site.auth === 'google'
      ? 'Complete Google sign-in manually.'
      : 'The paired extension can use saved credentials when the bridge has --allow-password-login.'} Use the collector extension with the local bridge.`);
    return;
  }
  if (command === 'credentials') {
    if (site.collection === 'browser' && site.auth === 'google') {
      throw new Error(`${site.name} uses your normal browser. No password is collected. Run "npm.cmd start -- bridge --open-edge --site ${site.id}".`);
    }
    if (site.auth === 'google') {
      throw new Error(`${site.name} uses Google OAuth; do not save a Google password. Run "npm.cmd start -- login --site ${site.id}" instead.`);
    }
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error(`Saving credentials requires an interactive terminal. Run "npm.cmd start -- credentials --site ${site.id}".`);
    }
    console.log(`Saving separate credentials for ${site.name} (${site.id}).`);
    const terminal = createInterface({ input: stdin, output: stdout });
    let username;
    try {
      username = await terminal.question('Workday email address: ');
    } finally {
      terminal.close();
    }
    const password = await promptPassword();
    await saveCredentials(secrets, { username, password }, site.url);
    await forgetSession(secrets);
    console.log(`Credentials encrypted for ${site.name}. ${site.collection === 'browser'
      ? 'Use the paired Edge extension with "npm.cmd start -- bridge --allow-password-login" to sign in automatically.'
      : `Run "npm.cmd start -- check --site ${site.id}" to sign in automatically.`}`);
    return;
  }
  if (command === 'logout') {
    await forgetSession(secrets);
    await forgetCredentials(secrets);
    console.log(`Saved session and credentials removed for ${site.name}. Local application history is retained.`);
    return;
  }
  if (command === 'report' || command === 'history') {
    const store = new Store(directory);
    try {
      if (allSites) {
        const reports = selected.map(item => ({
          site: item.id, name: item.name, url: item.url,
          ...(command === 'report' ? store.report(item.id) : { history: store.history(item.id) }),
        }));
        printSites(reports, values.json, command);
      } else {
        if (!values.json && values.site) console.log(`${site.name} (${site.id})`);
        print(command === 'report' ? store.report(site.id) : store.history(site.id), values.json);
      }
    } finally {
      store.close();
    }
    return;
  }
  const options = {
    directory,
    mode: command === 'login' ? (values.auto ? 'auto' : 'interactive') : 'check',
    headed: values.headed,
    allowedHosts: values['allow-host'].map(host => host.toLowerCase()),
    onProgress: message => console.error(message),
  };
  if (values.all) {
    const results = await checkSites(selected, options);
    printSites(results, values.json, 'check');
    if (results.some(result => result.outcome !== 'success')) process.exitCode = 1;
    return;
  }
  if (!values.json && values.site) console.log(`${site.name} (${site.id})`);
  print(await checkSite(site, options), values.json);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
