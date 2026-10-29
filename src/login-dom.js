// These helpers are serialized into the browser; keep them independent of imports.
export function credentialPageMatches(value, portalUrl) {
  try {
    const current = new URL(value);
    const expected = new URL(portalUrl);
    return current.protocol === 'https:' && current.origin === expected.origin &&
      [expected.pathname, new URL('login', expected).pathname].includes(current.pathname) &&
      !current.username && !current.password;
  } catch {
    return false;
  }
}

export function hasLoginChallenge() {
  const text = document.body?.innerText || '';
  const visible = element => element.getClientRects().length > 0;
  return /enter (?:the |your )?(?:verification|security|authentication|one.time) code|verify your identity|multi.factor authentication|complete the captcha|password (?:has )?expired/i.test(text) ||
    [...document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], input[autocomplete="one-time-code"]')].some(visible);
}

export function passwordLoginRejected() {
  return [...document.querySelectorAll('[role="alert"],[data-automation-id="errorMessage"]')]
    .some(element => element.getClientRects().length &&
      /incorrect|invalid|unable to sign in|account.*locked|try again/i.test(element.innerText || ''));
}

export function passwordFormStep(portalUrl, action = 'probe', credentials) {
  const expected = new URL(portalUrl);
  if (location.origin !== expected.origin ||
      ![expected.pathname, new URL('login', expected).pathname].includes(location.pathname)) {
    throw new Error('Password entry is restricted to the registered HTTPS Workday portal.');
  }
  const visible = element => element.getClientRects().length &&
    !element.closest('[aria-hidden="true"]') && getComputedStyle(element).visibility === 'visible';
  const label = element => (element.getAttribute('aria-label') ||
    (element.matches('input[type="submit"]') ? element.value : element.innerText) || '').trim().replace(/\s+/g, ' ');
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
  if (passwords.length > 1 || passwords.some(input => input.autocomplete === 'new-password')) {
    return { state: 'manual', message: 'Ambiguous password or account-creation form. Sign in manually; credentials were not entered.' };
  }
  if (!passwords.length) {
    const entries = [...document.querySelectorAll('button,a,[role="button"]')].filter(element =>
      visible(element) && /^sign in$/i.test(label(element)) && !element.closest('form'));
    if (entries.length > 1) return { state: 'manual', message: 'Multiple Workday Sign In controls were found. Open sign-in manually.' };
    if (!entries.length) return { state: 'waiting' };
    if (action !== 'open') return { state: 'entry' };
    entries[0].click();
    return { state: 'opened' };
  }
  const password = passwords[0];
  const scope = password.closest('form') || password.closest('[role="dialog"]') || document.body;
  const usernames = [...scope.querySelectorAll('input')].filter(input => visible(input) &&
    ['text', 'email'].includes(input.type) && (
    input.matches('[data-automation-id="email"],[type="email"],[autocomplete="username"],[name="username"],[name="email"]') ||
    /^(email|email address|username|user name)$/i.test(input.getAttribute('aria-label') ||
      [...input.labels || []].map(label => label.innerText).join(' ').trim())
  ));
  const buttons = [...scope.querySelectorAll('button,[role="button"],input[type="submit"]')].filter(element =>
    visible(element) && /^sign in$/i.test(label(element)));
  if (usernames.length !== 1 || buttons.length !== 1 ||
      password.disabled || password.readOnly || usernames[0].disabled || usernames[0].readOnly) {
    return { state: 'manual', message: 'Could not identify one editable email/password form and one Sign In control. Sign in manually.' };
  }
  const submit = buttons[0];
  const form = password.closest('form');
  for (const [element, attribute] of [[form, 'action'], [submit, 'formaction']]) {
    if (!element?.hasAttribute(attribute)) continue;
    const target = new URL(element.getAttribute(attribute), location.href);
    if (target.origin !== expected.origin || !target.pathname.startsWith(new URL('.', expected).pathname)) {
      return { state: 'manual', message: 'The password form targets another portal. Credentials were not entered.' };
    }
  }
  if (action === 'fill') {
    if (credentials?.portalUrl !== expected.href || credentials.origin !== expected.origin ||
        typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
      throw new Error('Credentials do not belong to this Workday portal.');
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [input, value] of [[usernames[0], credentials.username], [password, credentials.password]]) {
      input.focus();
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
    }
    return { state: 'filled' };
  }
  if (action !== 'submit') return { state: 'form' };
  if (submit.disabled || submit.getAttribute('aria-disabled') === 'true') return { state: 'waiting' };
  submit.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = submit.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (!hit || !submit.contains(hit)) return { state: 'manual', message: 'Another control covers Sign In. Handle the dialog manually; no login retry was made.' };
  submit.click();
  return { state: 'submitted' };
}

export function passwordRequestGuard(portalUrl, action = 'state') {
  const expected = new URL(portalUrl);
  if (location.origin !== expected.origin ||
      ![expected.pathname, new URL('login', expected).pathname].includes(location.pathname)) {
    throw new Error('The tab left the registered Workday portal.');
  }
  const key = Symbol.for('workday-status-tracker.password-request-guard');
  if (action === 'restore') {
    window[key]?.restore();
    return { active: false, requests: 0 };
  }
  if (action !== 'install') return { active: Boolean(window[key]), requests: window[key]?.requests || 0 };
  window[key]?.restore();
  const endpoint = new URL('login', expected);
  const state = { requests: 0 };
  const matches = (url, method) => {
    const target = new URL(url, location.href);
    return String(method).toUpperCase() === 'POST' &&
      target.origin === endpoint.origin && target.pathname === endpoint.pathname;
  };
  const permit = () => {
    if (state.requests) return false;
    state.requests++;
    return true;
  };
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSubmit = HTMLFormElement.prototype.submit;
  const requests = new WeakMap();
  function guardedFetch(input, init) {
    const url = input instanceof Request ? input.url : input;
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    if (matches(url, method) && !permit()) return Promise.reject(new Error('Duplicate automatic Workday sign-in request blocked.'));
    return originalFetch.apply(this, arguments);
  }
  function guardedOpen(method, url) {
    requests.set(this, { method, url });
    return originalOpen.apply(this, arguments);
  }
  function guardedSend() {
    const request = requests.get(this);
    if (request && matches(request.url, request.method) && !permit()) {
      throw new DOMException('Duplicate automatic Workday sign-in request blocked.', 'InvalidStateError');
    }
    return originalSend.apply(this, arguments);
  }
  function guardedSubmit() {
    if (matches(this.action, this.method) && !permit()) return;
    return originalSubmit.apply(this, arguments);
  }
  function onSubmit(event) {
    if (!event.defaultPrevented && matches(event.target.action, event.target.method) && !permit()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  function manualInput(event) {
    if (event.isTrusted && event.target instanceof Element &&
        event.target.closest('input,button,[role="button"],a')) state.restore();
  }
  state.restore = () => {
    if (window.fetch === guardedFetch) window.fetch = originalFetch;
    if (XMLHttpRequest.prototype.open === guardedOpen) XMLHttpRequest.prototype.open = originalOpen;
    if (XMLHttpRequest.prototype.send === guardedSend) XMLHttpRequest.prototype.send = originalSend;
    if (HTMLFormElement.prototype.submit === guardedSubmit) HTMLFormElement.prototype.submit = originalSubmit;
    document.removeEventListener('submit', onSubmit);
    document.removeEventListener('pointerdown', manualInput, true);
    document.removeEventListener('keydown', manualInput, true);
    if (window[key] === state) delete window[key];
  };
  window.fetch = guardedFetch;
  XMLHttpRequest.prototype.open = guardedOpen;
  XMLHttpRequest.prototype.send = guardedSend;
  HTMLFormElement.prototype.submit = guardedSubmit;
  document.addEventListener('submit', onSubmit);
  document.addEventListener('pointerdown', manualInput, true);
  document.addEventListener('keydown', manualInput, true);
  window[key] = state;
  return { active: true, requests: 0 };
}
