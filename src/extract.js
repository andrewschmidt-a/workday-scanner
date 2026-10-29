// This function runs inside the browser; keep it independent of Node imports.
export function extractPage(expectedPortalUrl) {
  if (expectedPortalUrl) {
    const expected = new URL(expectedPortalUrl);
    if (location.origin !== expected.origin || location.pathname !== expected.pathname) {
      throw new Error('The tab left the registered Workday dashboard. Nothing was imported.');
    }
  }
  const text = element => element?.innerText?.trim() || '';
  const heading = element => text(element).replace(/\s+/g, ' ');
  const visible = element => Boolean(element && element.getClientRects().length);
  const body = text(document.body);
  const statusHeading = /^(my )?(application )?status$/i;
  const titleHeading = /^(job title|job|position|job posting)$/i;
  const result = [];
  const problems = [];

  function add(container, titleElement, statusElement, requisitionElement) {
    const title = text(titleElement);
    const status = text(statusElement);
    if (!title || !status) {
      problems.push('An application is missing its title or status.');
      return;
    }
    const link = titleElement.matches('a[href]')
      ? titleElement
      : titleElement.querySelector('a[href]') || container.querySelector('a[href*="/job/"]');
    let url = null;
    if (link) {
      const parsed = new URL(link.getAttribute('href'), location.href);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        url = parsed.href;
      }
    }
    const applicationId = container.getAttribute('data-application-id') || null;
    result.push({
      title,
      status,
      url,
      applicationId,
      requisitionId: text(requisitionElement) || null,
    });
  }

  for (const table of document.querySelectorAll('table, [role="table"], [role="grid"]')) {
    if (!visible(table)) continue;
    const headers = [...table.querySelectorAll('thead th, [role="columnheader"]')];
    const statusIndex = headers.findIndex(header => statusHeading.test(heading(header)));
    const titleIndex = headers.findIndex(header => titleHeading.test(heading(header)));
    const requisitionIndex = headers.findIndex(header => /^(job )?(req(uisition)?)( id)?$/i.test(heading(header)));
    if (statusIndex < 0 || titleIndex < 0) continue;
    for (const row of table.querySelectorAll('tbody tr, [role="row"]')) {
      if (!visible(row) || row.closest('thead')) continue;
      const cells = [...row.querySelectorAll(':scope > th, :scope > td, :scope > [role="rowheader"], :scope > [role="cell"], :scope > [role="gridcell"]')];
      if (!cells.length) continue;
      if (cells.length === 1 && /no applications/i.test(text(row))) continue;
      add(row, cells[titleIndex], cells[statusIndex], cells[requisitionIndex]);
    }
  }

  if (!result.length) {
    const statuses = [...document.querySelectorAll('[data-automation-id="applicationStatus"]')].filter(visible);
    for (const status of statuses) {
      let container = status.parentElement;
      let title;
      while (container && container !== document.body) {
        const titles = container.querySelectorAll('[data-automation-id="applicationTitle"], [data-automation-id="jobTitle"]');
        if (titles.length === 1 && container.querySelectorAll('[data-automation-id="applicationStatus"]').length === 1) {
          title = titles[0];
          break;
        }
        container = container.parentElement;
      }
      if (!title) {
        problems.push('Could not associate an application status with exactly one job.');
      } else {
        add(container, title, status, container.querySelector('[data-automation-id="requisitionId"]'));
      }
    }
  }

  const empty = /you (?:currently )?(?:have no|do not have any|don't have any) (?:submitted )?(?:job )?applications|no applications (?:found|to display)|you (?:have not|haven't) applied (?:for|to) any/i.test(body);
  const passwordVisible = [...document.querySelectorAll('input[type="password"]')].some(visible);
  const googleSignInVisible = location.hostname === 'accounts.google.com' || [...document.querySelectorAll(
    '[data-automation-id="GoogleSignInButton"], [data-automation-id="signInContent"] button, [data-automation-id="signInContent"] a, [data-automation-id="signInContent"] [role="button"], [data-automation-id="auth_container"] button, [data-automation-id="auth_container"] a, [data-automation-id="auth_container"] [role="button"]',
  )].some(element => visible(element) &&
    /^(sign in|sign up|continue) with google$/i.test(element.getAttribute('aria-label') || text(element)));
  const identitySignInVisible = /^wd\d+-identity\.myworkday\.com$/i.test(location.hostname);
  const next = [...document.querySelectorAll('button, a, [role="button"]')].filter(element => {
    const label = element.getAttribute('aria-label') || text(element);
    return visible(element) && /^(next|next page|go to next page)$/i.test(label.trim());
  });
  if (next.length > 1) problems.push('Multiple next-page controls were found.');
  const nextElement = next[0];
  const hasNext = Boolean(nextElement && !nextElement.disabled &&
    nextElement.getAttribute('aria-disabled') !== 'true');
  const loading = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible);
  const pageIndicator = [...document.querySelectorAll('[aria-current="page"]')].map(text).join('|');
  return { applications: result, empty, passwordVisible, googleSignInVisible, identitySignInVisible, problems, hasNext, loading, pageIndicator };
}

export class SignInRequired extends Error {}

export function validatePage(snapshot) {
  if (snapshot.identitySignInVisible) {
    throw new SignInRequired('Workday identity sign-in is required. Complete sign-in interactively in the browser.');
  }
  if (snapshot.googleSignInVisible) {
    throw new SignInRequired('Google sign-in is required. Complete it interactively in the browser; Google passwords are never entered automatically.');
  }
  if (snapshot.passwordVisible) {
    throw new SignInRequired('Sign-in is required. Run "npm.cmd start -- login" or save credentials with "npm.cmd start -- credentials". Complete any MFA manually.');
  }
  if (snapshot.problems.length) {
    throw new Error(`Extraction failed: ${snapshot.problems.join(' ')}`);
  }
  if (!snapshot.applications.length && !snapshot.empty) {
    throw new Error('No recognizable application list or explicit empty state. The page may need login or an adapter update.');
  }
}

export function applicationKey(application) {
  if (application.applicationId) return `id:${application.applicationId}`;
  if (application.requisitionId) return `req:${application.requisitionId}`;
  if (application.url) return `url:${application.url}`;
  return `title:${application.title}`;
}
