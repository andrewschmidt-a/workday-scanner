# Workday status tracker

Local, read-only tracker for multiple Workday candidate dashboards.
Built-in sites are [3M](https://3m.wd1.myworkdayjobs.com/en-US/Search/userHome)
(`3m`) and [Wells Fargo](https://wd1.myworkdaysite.com/en-US/recruiting/wf/WellsFargoJobs/userHome)
(`wells-fargo`). Each password-based site has separate login credentials and browser sessions.
Sites using your normal Edge profile can instead import through the local collector extension.
Application statuses are stored and reported exactly as displayed, with only surrounding whitespace removed.
There are no normalized statuses, rejection guesses, or automatic application actions.

## Requirements and setup

- Windows and Node.js 24 or newer.
- Your own authorized candidate accounts for the sites you check.

```powershell
npm.cmd install
npm.cmd run setup
npm.cmd start -- login
npm.cmd start -- check
npm.cmd start -- report
npm.cmd start -- history --json
```

During login, enter credentials directly into the browser, complete MFA, and navigate to
My Applications before pressing Enter in the terminal. Interactive login stores only
the browser session. The tool does not bypass MFA/CAPTCHA.
Use `check --headed` to see the browser if a check fails.

## Automatic login

Save credentials locally once, then let checks reuse the session or sign in when needed:

```powershell
npm.cmd start -- credentials
npm.cmd start -- check
```

The credentials command prompts for your email and a **hidden password**, encrypts both
with Windows DPAPI, and removes only that site's previous browser session. Do not put credentials in
command arguments, environment variables, source files, or chat. Save a newly rotated
password if an old password has been exposed. This command does not verify the credentials;
the next check makes the login attempt.

`npm.cmd start -- login --auto` explicitly starts a fresh, visible login with saved
credentials. `check` prefers an existing session and submits credentials only when login
is needed. The adapter opens Sign In if needed and fills the email/password form. It allows
only one credential POST to the selected site's login endpoint per run. If the first click generates
no credential request, it confirms the visible Sign In control once more after one
second. A request guard blocks any late duplicate; rejected credentials are never
resubmitted automatically. MFA/CAPTCHA checks still apply before confirmation.
It blurs the password field first so Workday commits the entered value
before the click. It targets the accessible Sign In control, including 3M's visible control
over an aria-hidden submit button. Form-action failures identify the failed step without including raw
Playwright call logs, which can contain passwords. Progress messages go to stderr so
JSON reports on stdout remain machine-readable. Expected login redirects are handled
without treating a temporary browser execution-context change as a sign-in failure.

MFA, CAPTCHA, password updates, unfamiliar forms, and unrecognized dashboards stop
unattended login. Run `npm.cmd start -- check --headed` in a terminal to complete these
steps manually. Automatic password entry is restricted to the configured HTTPS Workday
origin and tenant path, even when additional navigation hosts are allowed. External identity-provider
login remains interactive.

Login navigation is restricted to the configured portal host. If your account redirects to
an identity provider, verify its exact hostname and add `--allow-host verified.example.com`
to both login and subsequent checks. Do not approve unfamiliar hosts. This restriction
applies to document navigation, not the portal's static resources or API requests.

`login` also records an initial application snapshot. `check` reuses and refreshes the
encrypted session. `report` reads local data without contacting Workday and clearly
separates the latest check outcome from the last successful snapshot. `history` retains
every successful observation. Add `--json` for machine-readable output; use `--json` on
`check` to include exact old/new status text for changes.

## Multiple sites

Your existing 3M credentials, session, and history continue to work unchanged.
Configure Wells Fargo separately; credentials are never copied between employers:

```powershell
npm.cmd start -- sites
npm.cmd start -- credentials --site wells-fargo
npm.cmd start -- login --auto --site wells-fargo
npm.cmd start -- check --all
npm.cmd start -- report
npm.cmd start -- report --json
npm.cmd start -- history --all --json
```

**`report` includes all configured sites by default**, including sites not yet checked.
`report --all` is an explicit equivalent. Other commands without `--site` or `--all`
still target **3M** for backwards compatibility.
Use `--site wells-fargo` on `credentials`, `login`, `check`, `report`, `history`, or
`logout` to target only Wells Fargo. `check --site wells-fargo --headed` shows its browser.
`--all` is available only for `check`, `report`, and `history`; it cannot share credentials
or perform bulk login/logout. `--site` and `--all` are mutually exclusive.

Batch checks run sequentially in independent browser contexts. A site failure is recorded
and does not prevent later sites from being checked; the command exits nonzero if any
site failed. Combined reports identify each employer and retain each site's last
successful snapshot alongside its most recent check outcome. An unchecked site is
reported as unchecked, not as having no applications. Combined JSON uses a `sites` array;
single-site JSON selected with `--site` retains its original shape. Consequently,
`report --json` now returns the combined `sites` array; use `report --site 3m --json`
for the original single-site JSON shape.

To register another employer, add a `sites.json` file in `WORKDAY_TRACKER_HOME`
(or `.workday-tracker`) containing an array of additional sites:

```json
[
  {
    "id": "example",
    "name": "Example Employer",
    "url": "https://example.wd1.myworkdayjobs.com/en-US/Careers/userHome"
  }
]
```

Use the employer's actual HTTPS Workday `userHome` URL. IDs must be unique lowercase
letters/numbers/hyphens and cannot override built-in IDs. URLs cannot contain credentials,
query parameters, or fragments. Fields are `id`, `name`, `url`, optional
`auth` (`password`, the default, or `google`), and optional `collection`
(`playwright`, the default, or `browser`).
For password-based automated sites, use `credentials --site example` to save separate encrypted credentials.
Additional employer layouts may need an adapter update; registering a URL alone does not
guarantee its page structure is supported.

## Normal Edge collection (recommended for Google OAuth)

For an account that signs in through Google, such as the configured CVS Health account,
use your normal Edge profile with the collector extension. Google may reject browsers
controlled by automation; this approach does not control Google's pages or bypass sign-in.
Set `"auth": "google"` and `"collection": "browser"` on the site's entry:

```json
{
  "id": "cvs-health",
  "name": "CVS Health",
  "url": "https://cvshealth.wd1.myworkdayjobs.com/en-US/CVS_Health_Careers/userHome",
  "auth": "google",
  "collection": "browser"
}
```

Keep the entry inside the `sites.json` array alongside any other additional sites.
Do **not** run the credentials command for this site; no Google password is collected.

```powershell
npm.cmd run extension:build
npm.cmd start -- bridge --open-edge --site cvs-health
```

1. In your normal Edge profile, open `edge://extensions`, enable **Developer mode**,
   select **Load unpacked**, and choose this project's `browser-extension` directory.
   The bridge prints its absolute path. Respect any organization extension-installation restrictions.
2. Open the **Workday Status Collector** toolbar extension. Copy the pairing token
   from the bridge terminal into its password field and select **Save pairing**.
   The default port is 8765; use `bridge --port NUMBER` and the same extension port if needed.
3. Open CVS's Workday dashboard. Once paired, the extension automatically opens a
   recognizable Workday Sign In entry if necessary and clicks **Sign in with Google**.
   Complete any Google account selection, login, and MFA yourself, then return to **My Applications**.
   Hourly collection is enabled by default after pairing. You can also select
   **Collect all now** or **Collect this dashboard** for an immediate refresh.
4. Run `npm.cmd start -- report` in another terminal. Imported statuses and changes
   use the same SQLite history as password-based checks, with employer text unchanged.

Keep the bridge terminal open while collecting; press Ctrl+C to stop it. A new bridge
process prints a new token, which must be paired again. Never share the token or put it
in a URL. `login --site cvs-health` simply opens normal Edge; `--auto` does not automate Google.
Edge uses its normal profile selection; install the extension and sign in in the same profile.
The tracker never copies, locks, or launches automation against your personal profile.

After updating the extension files, select its **Reload** button at `edge://extensions`,
then reload the Workday page. Existing pairing is retained unless the bridge restarts.
For password login (0.4.0), restart the bridge with `--allow-password-login` and save its new pairing token.
Approve Edge's added **alarms** permission if prompted.
The popup shows its version and a live bridge/current-tab connection check at the top.
Its **Sign-in / collection notice** updates while the popup is open. If nothing happens,
open it on the employer's Workday tab: it distinguishes missing pairing, an unreachable
bridge, an unregistered page, and a previous automatic sign-in attempt. Opening the popup
also rechecks the current tab; extension startup rechecks already-open Workday tabs.
Automatic Google entry applies only to registered sites with both `auth: "google"` and
`collection: "browser"`, on the exact dashboard or its sibling `/login` route.
Google entry waits up to 30 seconds for Workday's controls to render and never submits a Google password.
Cookie/consent choices remain yours. If Edge blocks a sign-in popup, handle its permission
or click Workday's Google button manually; the extension does not bypass popup restrictions.
It attempts Google entry once per tab/site until it recognizes a signed-in dashboard.
The attempt marker survives extension-worker restarts and page reloads, avoiding login loops.
After an unsuccessful attempt, use the Google button manually or open the dashboard in a new tab.

### Automatic Workday password login in Edge

The extension can also sign in to registered password-based sites, including 3M and
Wells Fargo, using the separate credentials already encrypted by the CLI:

```powershell
npm.cmd start -- credentials --site 3m
npm.cmd start -- credentials --site wells-fargo
npm.cmd start -- bridge --allow-password-login
```

Skip credential prompts for sites already configured. Reload extension **0.4.0** and save
the restarted bridge's new pairing token. Password login runs when a registered dashboard
or its sibling login page needs sign-in, including during hourly collection.
Without this flag, the bridge never releases passwords and Edge sign-in remains manual.

Credentials are decrypted only for the matching registered password portal, delivered over
the authenticated loopback connection, and used temporarily to fill its Workday form.
They are never saved in extension storage, reports, or logs. Playwright sessions are not copied.
**With this option enabled, the pairing token grants access to saved Workday passwords,
not just application imports.** Protect it and stop the bridge to revoke it.

Only one credential POST is permitted per automatic attempt. A second UI click is allowed
only if the first sent no request. A non-secret attempt revision survives browser restarts:
rejected or incomplete login is not retried on later hourly checks until you update that site's
saved credentials or the extension recognizes a manually signed-in dashboard.
MFA, CAPTCHA, password updates, unfamiliar forms, and external identity providers require
manual attention. Google passwords are never requested or filled. Interacting with the
login controls manually stops automatic submission and restores normal form behavior.

## Hourly collection

The extension collects **all configured sites**, including 3M, Wells Fargo, CVS, and
Thomson Reuters, every **60 minutes** while Edge and the bridge are running.
It runs an initial batch when the hourly alarm is first created, then maintains the
hourly cadence across background-worker restarts. The popup shows the next check,
last batch, and per-site errors. Uncheck **Collect all sites every hour** to pause;
an already-running batch finishes. **Collect all now** also works while paused.

Each check refreshes an existing dashboard or opens a missing dashboard in an inactive
tab without taking focus. Other job/application tabs are not repurposed. Login forms
are not refreshed, and a collector tab waiting at Google/another page is retained
rather than opening duplicate tabs each hour. Keep the dashboard tabs open during collection.
All sites use their **normal Edge sessions** for this schedule. Password-based sites
can sign in using saved per-site credentials when bridge password login is explicitly
enabled; otherwise sign in once manually in Edge. Use the same candidate accounts as
the tracker data directory.

Google entry remains automatic where configured, but Google passwords, account selection,
MFA, consent, and CAPTCHA remain manual. Sites needing attention are marked
`needs_user_action`; other failures are recorded explicitly. Other sites continue,
and reports retain the last successful snapshot rather than treating stale data as
a fresh success. Failure to contact the bridge is shown in the popup and cannot be
written to the offline database. Completed snapshots still preserve employer status text exactly.

Closing Edge or the bridge, computer sleep, browser throttling, and organization
policies can delay or prevent a scheduled check. Browser alarms are best-effort, not
an always-on Windows service; missed hours are not replayed in a burst.

The extension reads registered Workday dashboards and their sign-in controls, and follows Next controls.
It has Workday host permissions, scripting/storage/alarms permissions, and loopback access;
it has **no cookie permission or Google/identity-provider host access**. Collection sends only
application fields, not page HTML or browser sessions. Opt-in password login separately
receives credentials from the bridge and enters them only in the registered Workday form. Its pairing token
is stored in extension-local storage. The bridge binds only to `127.0.0.1`, requires the
token for data access, and rejects website origins. Local programs with the token can
import data and, when explicitly enabled, retrieve saved Workday credentials;
it is not protection against a compromised local machine.

CLI `check` and `check --all` still record
`needs_user_action` for them and exit nonzero, while retaining the last successful import
and continuing other sites. They never present stale data as a fresh successful check.
The Edge hourly scheduler is separate from these CLI checks. `logout` removes tracker-managed secrets only; sign
out in Edge separately and remove extension pairing in Edge's extension settings if needed.

For Google sites left on `collection: "playwright"`, the older interactive browser flow
remains available where the provider allows it. It allows only the configured portal,
`accounts.google.com`, and that portal shard's exact Workday identity broker (for CVS,
`wd1-identity.myworkday.com`), plus explicitly approved hosts. It never enters Google
passwords automatically and saves only Workday cookies/origin storage after a successful
read. If Google rejects the automated browser, use normal Edge collection rather than
trying to bypass its policy.

## Storage and privacy

Data is in `.workday-tracker` by default. Windows DPAPI encrypts browser session material
and optionally saved login credentials for your Windows account. These grant account access; protect your Windows
account and do not share the data directory. Application history is **unencrypted SQLite**
and contains job titles, URLs, and status text. Passwords are stored only in the optional
encrypted credential file, not in application history or logs. No screenshots or page HTML
are recorded.

3M's existing secret files remain in the data-directory root. Other sites' encrypted
credentials and sessions are stored in `sites\<site-id>` (Playwright Google sites store only their
Workday session; browser-managed sites save no browser session, and Google sites save no password).
Browser-managed password sites can save separate DPAPI credentials for opt-in Edge login. New secret files are bound to
the full portal URL, so employers sharing a Workday hostname cannot exchange credentials
or sessions. The root SQLite database keeps history isolated by site ID.

Use a different data directory for different account collections. Do not mix two candidate
accounts for the same employer in one directory:

```powershell
$env:WORKDAY_TRACKER_HOME = "$env:LOCALAPPDATA\workday-tracker\3m-personal"
npm.cmd start -- login
```

`npm.cmd start -- logout --site wells-fargo` deletes only Wells Fargo's local session and
saved credentials, but not history or other sites' credentials, and does not revoke the
server session. Use the portal itself for server-side sign-out. History can be removed
by deleting the specific `applications.sqlite` file while the tool is stopped.

## Extraction behavior and limits

The adapter recognizes application tables with Job Title/Position and Application
Status/My Application Status/Status headings, including 3M's Job Req column and
row-header job titles, and Workday application cards with explicit title/status
automation identifiers. It follows visible Next controls, rejects ambiguous application
identities and repeated pages, and saves only after collection completes. Unrecognized
markup is an error, never a successful empty result. Missing applications are not
interpreted as rejections or withdrawals.

Identity preference is application ID, requisition ID, job URL, then exact job title.
When a previously URL-keyed application gains a requisition ID, its existing key is
retained if the URL matches uniquely and the requisition ID does not conflict. This
preserves status history while enriching the current record; older observations are
not rewritten.
An employer changing these identifiers can make an application appear new rather than
produce a status-change event. Duplicate identities cause an explicit error.

This is a shared adapter, not a claim that all Workday layouts are supported.
Its DOM behavior is tested with local fixtures. 3M has been exercised against an
authorized account; Wells Fargo's public sign-in form has been inspected, but a full
Wells Fargo check still requires that site's separate credentials. If a live layout differs, update the adapter using
redacted markup without sharing credentials, cookies, or personal application data.

The CLI is on-demand; the Edge extension provides hourly collection. There are no email notifications, dashboard server,
automatic retries, or concurrent checking. Do not run checks concurrently against the
same data directory. For occasional scheduled use, run `check` from Windows Task
Scheduler under the same Windows account, with an absolute `WORKDAY_TRACKER_HOME`;
use a conservative interval and disable overlapping runs. Avoid adding a second schedule
on top of the Edge hourly collection. Authentication challenges require manual attention.
Respect employer terms and access restrictions.

## Tests

```powershell
npm.cmd test
```

Tests use local login/application browser fixtures, an isolated temporary-profile extension,
loopback import authorization, hidden-password input simulation, temporary SQLite databases, and Windows encryption
round-trips. They do not log in to Workday or require your credentials.
