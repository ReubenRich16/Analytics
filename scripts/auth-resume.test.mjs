// Staying signed in — the paths that decide whether the dashboard resumes or strands you.
//
// The bug this exists for: a partner on a supervised (child) Google account was being
// logged out "for no apparent reason". Four things lined up, and the last two meant there
// was no way back:
//
//   1. The resume gate required the saved token to carry the Client ID that issued it.
//      Tokens saved before that field existed carry nothing, so EVERY already-working
//      session was discarded on first load and pushed through a silent re-auth.
//   2. Silent re-auth is the one thing a supervised account (or a browser blocking
//      third-party cookies) refuses.
//   3. error_callback was guarded on `bootstrapped`, so before the first successful load
//      it reported nothing at all — the status sat on "signing in…" forever.
//   4. The "tap to reconnect" banner retried SILENTLY, which is what had just been refused.
//      Tapping it could never work.
//
// Run: node scripts/auth-resume.test.mjs
import fs from 'fs';
const src = fs.readFileSync(new URL('../yt-dashboard/index.html', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, x); } };

// lift the resume gate out of the page and run it as a function of its inputs
const gate = (() => {
  const i = src.indexOf('const fieldCid = ');
  const seg = src.slice(i, src.indexOf('if (haveValidTok)', i));
  const body = seg.replace("const fieldCid = $('clientId').value.trim();", 'const fieldCid = FIELD;');
  return new Function('savedTok', 'FIELD', 'looksLikeClientId',
    body + '\nreturn haveValidTok;');
})();
const REAL = '1234-abc.apps.googleusercontent.com';
const OTHER = '9999-zzz.apps.googleusercontent.com';
const looks = v => /\.apps\.googleusercontent\.com$/.test(String(v || ''));
const live = e => Date.now() + e;

console.log('\nresuming a saved session');
{
  check('a fresh token from this client resumes',
    !!gate({ t: 'x', e: live(50 * 60e3), c: REAL }, REAL, looks));

  /* The regression. A token saved before the `c` field existed has no issuer recorded;
     discarding it forces a silent re-auth, which is the step that fails on the accounts
     this whole fix is about. */
  check('a legacy token with no issuer recorded still resumes',
    !!gate({ t: 'x', e: live(50 * 60e3) }, REAL, looks),
    'every pre-existing session would be logged out on first load');

  check('but a token from a DIFFERENT client is still refused',
    !gate({ t: 'x', e: live(50 * 60e3), c: OTHER }, REAL, looks));

  check('an expired token is refused', !gate({ t: 'x', e: live(-1), c: REAL }, REAL, looks));
  check('one about to expire is refused', !gate({ t: 'x', e: live(30e3), c: REAL }, REAL, looks));
  check('no token at all is refused', !gate(null, REAL, looks));
  check('a junk Client ID in the field is refused',
    !gate({ t: 'x', e: live(50 * 60e3), c: REAL }, 'paste-your-id-here', looks));
}

console.log('\nwhen Google refuses to sign in without showing UI');
{
  const cb = src.slice(src.indexOf('error_callback:'), src.indexOf('error_callback:') + 1100);
  check('the failure is reported even before the first successful load',
    !/error_callback[\s\S]{0,120}if \(bootstrapped\) \{[\s\S]{0,80}\}\s*\n\s*\}/.test(cb) &&
    /else \{[\s\S]{0,400}showError/.test(cb),
    'a boot-time refusal is silent again');
  check('and it says what kind of account this happens on',
    /supervised or child account/.test(cb));
  check('the status does not stay stuck on "signing in…"',
    /setStatus\('sign-in needed'\)/.test(cb));
  check('the token is cleared either way, so the banner guard passes',
    /error_callback: \(\) => \{\s*\n\s*accessToken = null;/.test(src));
}

console.log('\nrecovery has to be able to succeed');
{
  const banner = src.slice(src.indexOf("$('errorBox').addEventListener"), src.indexOf("$('errorBox').addEventListener") + 700);
  check('a silent refusal is remembered', /let silentRefused = false;/.test(src));
  check('it is raised when Google declines without UI',
    (src.match(/silentRefused = true/g) || []).length >= 2,
    (src.match(/silentRefused = true/g) || []).length + ' places');
  check('and cleared on a successful token', /silentRefused = false;\s*\n\s*saveToken/.test(src));

  /* The heart of it: after a silent refusal, retrying silently is a no-op. */
  check('tapping the banner escalates to the account chooser once silent has failed',
    /if \(silentRefused\) initAuth\('select_account'\)/.test(banner), banner.slice(0, 200));
  check('and still uses the quiet path when nothing has been refused',
    /else tokenClient\.requestAccessToken\(\{ prompt: '' \}\)/.test(banner));
  check('the banner no longer ONLY ever requests silently',
    !/addEventListener\('click', \(\) => \{\s*\n\s*if \(tokenClient\) \{ clearError\(\); setStatus\('reconnecting…'\); tokenClient\.requestAccessToken\(\{ prompt: '' \}\); \}/.test(src));
}

console.log('\nthe surrounding machinery still holds');
{
  check('a returning tab renews an expired token rather than polling on it',
    /if \(accessToken && tokenExp - Date\.now\(\) <= 0\) \{ setStatus\('reconnecting…'\); renewToken\(\); return; \}/.test(src));
  check('renewal is scheduled ahead of expiry', /tokenExp - Date\.now\(\) - 5 \* 60 \* 1000/.test(src));
  check('the saved token records its issuer for future loads', /c: tokenClientId/.test(src));
  check('rebinding to a different Client ID drops the old credential',
    /if \(tokenClient\) \{\s*\n\s*accessToken = null; tokenExp = 0;[\s\S]{0,120}removeItem\('cc_tok'\)/.test(src));
  check('the export never carries the session token', /k !== 'cc_tok'/.test(src));
}

console.log('\n' + (fail ? '✗ ' + fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);
