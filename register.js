/* What the C*rp*s — "Take part". No files here, so one small POST is enough. */

const API = window.WTC_API || 'https://what-the-corpus.what-the-corpus-worker.workers.dev';

/* A blocked request throws a bare TypeError("Failed to fetch") with no detail,
 * which is indistinguishable from the server being down. Ad blockers do block
 * *.workers.dev, so we probe once on load and warn before anyone fills the form
 * in — and translate the opaque throw into something actionable. */
const BLOCKED_MSG =
  'The upload service could not be reached. This is almost always an ad blocker or '
  + 'privacy extension blocking workers.dev — try pausing it for this page, or use a '
  + 'different browser. If that fails, email me and it amounts to the same thing.';

function isNetworkError(err) {
  return err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(err && err.message));
}

(async function probe() {
  try {
    const r = await fetch(API + '/', { method: 'GET' });
    if (!r.ok) throw new Error(r.status);
  } catch (err) {
    const el = document.createElement('div');
    el.className = 'note';
    el.innerHTML = '<p><strong>Heads up.</strong> ' + BLOCKED_MSG
      + ' <a href="mailto:okurtul@bgsu.edu">okurtul@bgsu.edu</a></p>';
    const form = document.querySelector('form.submit');
    if (form) form.parentNode.insertBefore(el, form);
  }
})();

const form = document.getElementById('reg');
const status = document.getElementById('regStatus');
const button = document.getElementById('regGo');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(form).entries());

  const problems = [];
  if (!d.name?.trim()) problems.push('Your name is missing.');
  if (!/^\S+@\S+\.\S+$/.test(d.email || '')) problems.push('That email does not look right.');
  if (!d.have?.trim()) problems.push('Tell me what you have, even roughly.');

  const turnstile = form.querySelector('[name="cf-turnstile-response"]');
  if (turnstile && !turnstile.value) problems.push('Please complete the "not a robot" check.');

  if (problems.length) {
    status.innerHTML = `<div class="note"><p><strong>Not sent yet:</strong></p><ul>${
      problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
    return;
  }

  button.disabled = true;
  status.innerHTML = '<p class="dim">Sending…</p>';

  try {
    const r = await fetch(API + '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: d.name, email: d.email, location: d.location || '',
        have: d.have, tryout: d.tryout || '',
        wantsNotation: !!d.wantsNotation, augmented: !!d.augmented,
        wantsPatcher: !!d.wantsPatcher,
        turnstile: turnstile ? turnstile.value : undefined,
      }),
    });
    if (!r.ok) throw new Error(await r.text().catch(() => r.status));

    status.innerHTML = `<div class="note">
      <p><strong>Got it. Thank you.</strong></p>
      <p>I will write back to <code>${esc(d.email)}</code>, usually within a few days, with where the
      corpus is thin and what might be worth trying${d.wantsNotation ? ', and a page of notation' : ''}.</p>
      <p>No rush at your end — the deadline is 30 November 2026.</p>
      </div>`;
    form.style.display = 'none';
  } catch (err) {
    button.disabled = false;
    status.innerHTML = `<div class="note">
      <p><strong>That did not go through.</strong> ${isNetworkError(err) ? BLOCKED_MSG : esc(err.message || err)}</p>
      <p>Email me instead and it amounts to the same thing:
      <a href="mailto:okurtul@bgsu.edu">okurtul@bgsu.edu</a></p>
      </div>`;
  }
});
