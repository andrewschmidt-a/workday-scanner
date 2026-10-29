import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';

export const portal = {
  id: '3m',
  name: '3M',
  url: 'https://3m.wd1.myworkdayjobs.com/en-US/Search/userHome',
};

export const defaultPortals = [
  portal,
  {
    id: 'wells-fargo',
    name: 'Wells Fargo',
    url: 'https://wd1.myworkdaysite.com/en-US/recruiting/wf/WellsFargoJobs/userHome',
  },
];

export function dataDirectory() {
  return resolve(process.env.WORKDAY_TRACKER_HOME || '.workday-tracker');
}

export function loginAllowedHosts(site, extra = []) {
  const hosts = new Set(extra);
  if (site.auth === 'google') {
    hosts.add('accounts.google.com');
    const shard = new URL(site.url).hostname.match(/(?:^|\.)(wd\d+)\.(?:myworkdayjobs\.com|myworkdaysite\.com)$/i);
    if (shard) hosts.add(`${shard[1].toLowerCase()}-identity.myworkday.com`);
  }
  return [...hosts];
}

export function portalDirectory(directory, id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) {
    throw new Error('Site IDs must be safe lowercase names containing only letters, numbers, and hyphens.');
  }
  return id === portal.id ? directory : join(directory, 'sites', id);
}

export function validatePortal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['id', 'name', 'url', 'auth', 'collection'].includes(key)) ||
      typeof value.id !== 'string' || typeof value.name !== 'string' ||
      !value.name.trim() || /[\x00-\x1f\x7f]/.test(value.name) ||
      typeof value.url !== 'string') {
    throw new Error('Each site must contain id, name, and url, with optional auth and collection. Do not put credentials in sites.json.');
  }
  if (value.auth !== undefined && !['password', 'google'].includes(value.auth)) {
    throw new Error(`Site "${value.id}" auth must be "password" or "google".`);
  }
  if (value.collection !== undefined && !['playwright', 'browser'].includes(value.collection)) {
    throw new Error(`Site "${value.id}" collection must be "playwright" or "browser".`);
  }
  portalDirectory('.', value.id);
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error(`Invalid URL for site "${value.id}".`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.port || !/\.(myworkdayjobs\.com|myworkdaysite\.com)$/i.test(url.hostname) ||
      !url.pathname.endsWith('/userHome')) {
    throw new Error(`Site "${value.id}" requires an HTTPS Workday userHome URL without credentials, query parameters, or fragments.`);
  }
  return {
    id: value.id, name: value.name.trim(), url: url.href,
    ...(value.auth === undefined ? {} : { auth: value.auth }),
    ...(value.collection === undefined ? {} : { collection: value.collection }),
  };
}

export async function loadPortals(directory) {
  let source;
  try {
    source = await readFile(join(directory, 'sites.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return defaultPortals.map(site => ({ ...site }));
    throw error;
  }
  let additional;
  try {
    additional = JSON.parse(source);
  } catch {
    throw new Error('sites.json must contain a JSON array of sites. Do not put credentials in this file.');
  }
  if (!Array.isArray(additional)) throw new Error('sites.json must contain a JSON array of sites.');
  const sites = [...defaultPortals, ...additional.map(validatePortal)];
  if (new Set(sites.map(site => site.id)).size !== sites.length) {
    throw new Error('Site IDs must be unique; built-in site IDs cannot be overridden.');
  }
  if (new Set(sites.map(site => site.url)).size !== sites.length) {
    throw new Error('Site URLs must be unique. Use separate data directories for separate accounts on the same site.');
  }
  return sites;
}
