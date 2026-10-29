import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { chromium } from 'playwright';
import { automaticLogin, AuthenticationNeedsUserAction } from '../src/auth.js';
import { promptPassword } from '../src/prompt.js';
import { evaluatePage } from '../src/page.js';

const portalUrl = 'https://3m.wd1.myworkdayjobs.com/en-US/Search/userHome';
const credentials = {
  username: 'candidate@example.invalid',
  password: 'Synthetic testing password!',
  origin: new URL(portalUrl).origin,
};
const form = `<form onsubmit="return false">
  <label>Email Address<input data-automation-id="email" type="email"></label>
  <label>Password<input type="password"></label>
  <button data-automation-id="signInSubmitButton">Sign In</button>
</form>`;
const dashboard = `<table><thead><tr><th>Job Title</th><th>Application Status</th></tr></thead>
  <tbody><tr><td>Engineer</td><td>In Process - Exact Employer Wording</td></tr></tbody></table>`;

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function withPage(html, action, url = portalUrl) {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(url);
    return await action(page);
  } finally {
    await page.close();
  }
}

test('automatic login fills and submits credentials once, then reaches dashboard', async () => {
  await withPage(form, async page => {
    await page.locator('form').evaluate((element, nextPage) => {
      window.submissions = [];
      element.onsubmit = event => {
        event.preventDefault();
        window.submissions.push({
          username: element.querySelector('input[type="email"]').value,
          password: element.querySelector('input[type="password"]').value,
        });
        document.body.innerHTML = nextPage;
      };
    }, dashboard);
    await automaticLogin(page, { portalUrl, credentials });
    assert.deepEqual(await page.evaluate(() => window.submissions), [{
      username: credentials.username, password: credentials.password,
    }]);
  });
});

test('a valid session does not submit credentials again', async () => {
  await withPage(dashboard, async page => {
    await automaticLogin(page, { portalUrl, credentials, timeout: 1_000 });
    assert.equal(await page.locator('input').count(), 0);
  });
});

test('password state is committed before the Sign In pointer action', async () => {
  await withPage(form, async page => {
    await page.locator('form').evaluate((element, nextPage) => {
      const password = element.querySelector('input[type="password"]');
      const button = element.querySelector('button');
      let committed = false;
      let committedBeforePointerDown = false;
      window.submissions = 0;
      password.onblur = () => { committed = true; };
      button.onpointerdown = () => { committedBeforePointerDown = committed; };
      element.onsubmit = event => {
        event.preventDefault();
        if (!committedBeforePointerDown) return;
        window.submissions++;
        document.body.innerHTML = nextPage;
      };
    }, dashboard);
    await automaticLogin(page, { portalUrl, credentials, timeout: 3_000 });
    assert.equal(await page.evaluate(() => window.submissions), 1);
  });
});

test('a non-submitting first click is confirmed without retrying credentials', async () => {
  await withPage(form, async page => {
    let credentialRequests = 0;
    await page.route('**/login', route => {
      credentialRequests++;
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    await page.locator('form').evaluate((element, nextPage) => {
      window.clicks = 0;
      element.onsubmit = async event => {
        event.preventDefault();
        window.clicks++;
        if (window.clicks === 1) return;
        const response = await fetch('login', { method: 'POST', body: 'synthetic-fixture' });
        if (response.ok) document.body.innerHTML = nextPage;
      };
    }, dashboard);
    await automaticLogin(page, { portalUrl, credentials, timeout: 5_000 });
    assert.equal(await page.evaluate(() => window.clicks), 2);
    assert.equal(credentialRequests, 1);
  });
});

test('a late initial credential request cannot cause duplicate submissions', async () => {
  await withPage(form, async page => {
    let credentialRequests = 0;
    const progress = [];
    await page.route('**/login', route => {
      credentialRequests++;
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    await page.locator('form').evaluate((element, nextPage) => {
      window.clicks = 0;
      const send = async () => {
        try {
          const response = await fetch('login', { method: 'POST', body: 'synthetic-fixture' });
          if (response.ok) document.body.innerHTML = nextPage;
        } catch {
          window.duplicateBlocked = true;
        }
      };
      element.onsubmit = event => {
        event.preventDefault();
        window.clicks++;
        if (window.clicks === 1) setTimeout(send, 1_500);
        else void send();
      };
    }, dashboard);
    await automaticLogin(page, { portalUrl, credentials, timeout: 5_000, onProgress: message => progress.push(message) });
    await page.waitForTimeout(800);
    assert.equal(credentialRequests, 1);
    assert.equal(await page.evaluate(() => window.duplicateBlocked), true);
    assert.ok(progress.some(message => message.includes('Blocked a duplicate')));
  });
});

test('a credential request already in flight is never confirmed again', async () => {
  await withPage(form, async page => {
    let credentialRequests = 0;
    await page.route('**/login', async route => {
      credentialRequests++;
      await new Promise(resolve => setTimeout(resolve, 1_500));
      await route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    await page.locator('form').evaluate((element, nextPage) => {
      window.clicks = 0;
      element.onsubmit = async event => {
        event.preventDefault();
        window.clicks++;
        const response = await fetch('login', { method: 'POST', body: 'synthetic-fixture' });
        if (response.ok) document.body.innerHTML = nextPage;
      };
    }, dashboard);
    await automaticLogin(page, { portalUrl, credentials, timeout: 5_000 });
    assert.equal(await page.evaluate(() => window.clicks), 1);
    assert.equal(credentialRequests, 1);
  });
});

test('a normal login redirect reaches the application dashboard', async () => {
  await withPage(form, async page => {
    await page.route('**/candidate-home', route => route.fulfill({
      contentType: 'text/html', body: dashboard,
    }));
    await page.locator('form').evaluate(element => {
      element.onsubmit = event => {
        event.preventDefault();
        location.href = '/en-US/Search/candidate-home';
      };
    });
    await automaticLogin(page, { portalUrl, credentials });
    assert.match(page.url(), /candidate-home$/);
  });
});

test('page reads recover from navigation without resubmitting credentials', async () => {
  let reads = 0;
  let waits = 0;
  const page = {
    async evaluate() {
      reads++;
      if (reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation');
      return 'new page';
    },
    isClosed() { return false; },
    async waitForLoadState() { waits++; },
  };
  assert.equal(await evaluatePage(page, () => {}), 'new page');
  assert.equal(reads, 2);
  assert.equal(waits, 1);
  await assert.rejects(evaluatePage({
    ...page,
    async evaluate() { throw new Error('Unexpected extraction error'); },
  }, () => {}), /Unexpected extraction error/);
});

test('3M accessible Sign In overlay is clicked instead of the covered aria-hidden submit button', async () => {
  await withPage(`<form onsubmit="return false">
    <label>Email Address<input data-automation-id="email" type="text"></label>
    <label>Password<input type="password"></label>
    <div style="position:relative;width:200px;height:40px">
      <button aria-hidden="true" tabindex="-2" data-automation-id="signInSubmitButton"
        style="position:absolute;inset:0">Sign In</button>
      <div role="button" aria-label="Sign In" tabindex="0" data-automation-id="click_filter"
        style="position:absolute;inset:0"></div>
    </div>
  </form>`, async page => {
    await page.locator('[data-automation-id="click_filter"]').evaluate((button, nextPage) => {
      window.submissions = [];
      button.onclick = () => {
        window.submissions.push({
          username: document.querySelector('[data-automation-id="email"]').value,
          password: document.querySelector('input[type="password"]').value,
        });
        document.body.innerHTML = nextPage;
      };
    }, dashboard);
    await automaticLogin(page, { portalUrl, credentials });
    assert.deepEqual(await page.evaluate(() => window.submissions), [{
      username: credentials.username, password: credentials.password,
    }]);
  });
});

test('form action diagnostics identify the failed step without leaking credentials', async () => {
  await withPage(form, async page => {
    const originalLocator = page.locator.bind(page);
    page.locator = (...args) => {
      const locator = originalLocator(...args);
      if (args[0] === 'input[type="password"]:visible') {
        locator.fill = async () => {
          const error = new Error(`Call log: fill("${credentials.password}") control is not editable`);
          error.name = 'TimeoutError';
          throw error;
        };
      }
      return locator;
    };
    await assert.rejects(automaticLogin(page, { portalUrl, credentials }), error => {
      assert.match(error.message, /entering the password/);
      assert.match(error.message, /not editable/);
      assert.equal(error.message.includes(credentials.password), false);
      assert.equal(error.message.includes(credentials.username), false);
      return true;
    });
  });
});

test('the Sign In entry control can open the login form', async () => {
  await withPage('<button data-automation-id="signInLink">Sign In</button>', async page => {
    await page.locator('button').evaluate((button, markup) => {
      button.onclick = () => {
        document.body.innerHTML = markup;
        document.querySelector('form').onsubmit = event => {
          event.preventDefault();
          document.body.innerHTML = '<p>You have no applications</p>';
        };
      };
    }, form);
    await automaticLogin(page, { portalUrl, credentials });
    assert.equal(await page.locator('form').count(), 0);
  });
});

test('rejected credentials are not automatically retried', async () => {
  await withPage(form, async page => {
    await page.locator('form').evaluate(element => {
      window.submissions = 0;
      element.onsubmit = event => {
        event.preventDefault();
        window.submissions++;
        const alert = document.createElement('p');
        alert.setAttribute('role', 'alert');
        alert.textContent = 'Invalid email or password';
        element.append(alert);
      };
    });
    await assert.rejects(automaticLogin(page, { portalUrl, credentials }), /Sign-in was rejected/);
    assert.equal(await page.evaluate(() => window.submissions), 1);
  });
});

test('MFA requires user action and does not submit a second time', async () => {
  await withPage(form, async page => {
    await page.locator('form').evaluate(element => {
      window.submissions = 0;
      element.onsubmit = event => {
        event.preventDefault();
        window.submissions++;
        document.body.innerHTML = '<label>Enter your verification code<input autocomplete="one-time-code"></label>';
      };
    });
    await assert.rejects(automaticLogin(page, { portalUrl, credentials }), AuthenticationNeedsUserAction);
    assert.equal(await page.evaluate(() => window.submissions), 1);
  });
});

test('passwords are not entered on a different origin, including external identity providers', async () => {
  await withPage(form, async page => {
    await assert.rejects(automaticLogin(page, { portalUrl, credentials }), /restricted to the configured/);
    assert.equal(await page.locator('input[type="password"]').inputValue(), '');
  }, 'https://external-idp.invalid');
});

test('Wells Fargo uses its own credentials and tenant-specific login endpoint', async () => {
  const url = 'https://wd1.myworkdaysite.com/en-US/recruiting/wf/WellsFargoJobs/userHome';
  const account = {
    username: 'wf-candidate@example.invalid',
    password: 'Wells Fargo synthetic password!',
    origin: new URL(url).origin,
    portalUrl: url,
  };
  await withPage(form, async page => {
    let submissions = 0;
    await page.route('**/WellsFargoJobs/login', route => {
      submissions++;
      return route.fulfill({ contentType: 'application/json', body: '{}' });
    });
    await page.locator('form').evaluate((element, nextPage) => {
      window.clicks = 0;
      window.entered = null;
      element.onsubmit = async event => {
        event.preventDefault();
        window.clicks++;
        if (window.clicks === 1) return;
        window.entered = {
          username: element.querySelector('input[type="email"]').value,
          password: element.querySelector('input[type="password"]').value,
        };
        const response = await fetch('login', { method: 'POST', body: 'synthetic-fixture' });
        if (response.ok) document.body.innerHTML = nextPage;
      };
    }, dashboard);
    await automaticLogin(page, { portalUrl: url, credentials: account, siteId: 'wells-fargo' });
    assert.equal(submissions, 1);
    assert.deepEqual(await page.evaluate(() => window.entered), {
      username: account.username, password: account.password,
    });
  }, url);
});

test('automatic fill rejects another employer path on the same Workday host', async () => {
  const url = 'https://wd1.myworkdaysite.com/en-US/recruiting/wf/WellsFargoJobs/userHome';
  await withPage(form, async page => {
    await assert.rejects(automaticLogin(page, {
      portalUrl: url,
      credentials: { ...credentials, origin: new URL(url).origin, portalUrl: url },
    }), /restricted to the configured/);
    assert.equal(await page.locator('input[type="password"]').inputValue(), '');
  }, 'https://wd1.myworkdaysite.com/en-US/recruiting/other/Careers/login');
});

test('an ambiguous form does not receive a saved password', async () => {
  await withPage(form + '<label>Other account<input type="email"></label>', async page => {
    await assert.rejects(automaticLogin(page, { portalUrl, credentials }), /exactly one email field/);
    assert.equal(await page.locator('input[type="password"]').inputValue(), '');
  });
});

test('unknown login pages fail explicitly after a bounded wait', async () => {
  await withPage('<h1>Unsupported sign-in</h1>', async page => {
    await assert.rejects(automaticLogin(page, { portalUrl, credentials, timeout: 200 }),
      /did not reach a recognizable/);
  });
});

function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  output.isTTY = true;
  return { input, output, text: () => chunks.join('') };
}

test('local password input is hidden and preserves significant whitespace', async () => {
  const terminal = fakeTerminal();
  try {
    const pending = promptPassword(terminal);
    terminal.input.write(' synthetic secret! \r');
    assert.equal(await pending, ' synthetic secret! ');
    assert.equal(terminal.text().includes('synthetic secret'), false);
  } finally {
    terminal.input.destroy();
    terminal.output.destroy();
  }
});

test('password entry can be cancelled without saving or echoing input', async () => {
  const terminal = fakeTerminal();
  try {
    const pending = promptPassword(terminal);
    terminal.input.write('secret\x03');
    await assert.rejects(pending, /cancelled/);
    assert.equal(terminal.text().includes('secret'), false);
  } finally {
    terminal.input.destroy();
    terminal.output.destroy();
  }
});

test('password entry refuses noninteractive input', async () => {
  await assert.rejects(promptPassword({ input: { isTTY: false }, output: { isTTY: false } }),
    /interactive terminal/);
});
