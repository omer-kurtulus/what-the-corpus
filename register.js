/* What the C*rp*s — "Take part". No files here, so one small POST is enough. */

const API = window.WTC_API || 'https://what-the-corpus.what-the-corpus-worker.workers.dev';

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
      <p><strong>That did not go through.</strong> ${esc(err.message || err)}</p>
      <p>Email me instead and it amounts to the same thing:
      <a href="mailto:okurtul@bgsu.edu">okurtul@bgsu.edu</a></p>
      </div>`;
  }
});
