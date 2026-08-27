/* What the C*rp*s — upload.
 *
 * Files never pass through the form as one POST. The browser slices each file
 * into parts and streams them to a Cloudflare Worker, which relays them into
 * an R2 multipart upload. That is what removes the size ceiling: a Worker
 * request body is capped, a multipart part is not the whole file.
 *
 * Flow:  POST /create  ->  PUT /part (xN per file)  ->  POST /complete
 */

const API = window.WTC_API || 'https://what-the-corpus.what-the-corpus-worker.workers.dev';

const PART = 32 * 1024 * 1024;              // 32 MB — R2 needs >=5 MB per part
const OK_EXT = ['wav', 'aif', 'aiff', 'flac'];
const MAX_FILE = 2 * 1024 * 1024 * 1024;    // 2 GB, well past any real submission
const MAX_FILES = 30;

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

const form = document.getElementById('form');
const status = document.getElementById('status');
const button = document.getElementById('go');

function say(html) { status.innerHTML = html; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const files = [...document.getElementById('files').files];
  const data = Object.fromEntries(new FormData(form).entries());

  // ---- validate before anything is sent ----
  const problems = [];
  if (!data.legalName?.trim()) problems.push('Your name is missing.');
  if (!data.creditName?.trim()) problems.push('Credit name is missing.');
  if (!/^\S+@\S+\.\S+$/.test(data.email || '')) problems.push('That email does not look right.');
  if (!data.describe?.trim()) problems.push('Please say what the sound is.');
  for (const c of ['c1', 'c2', 'c3', 'c4']) {
    if (!data[c]) { problems.push('All four rights boxes have to be ticked.'); break; }
  }
  if (!files.length) problems.push('No files selected.');
  if (files.length > MAX_FILES) problems.push(`That is more than ${MAX_FILES} files — email me instead.`);
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    if (!OK_EXT.includes(ext)) problems.push(`${f.name}: only WAV, AIFF and FLAC.`);
    if (f.size > MAX_FILE) problems.push(`${f.name}: over 2 GB.`);
    if (f.size === 0) problems.push(`${f.name}: file is empty.`);
  }

  const turnstile = form.querySelector('[name="cf-turnstile-response"]');
  if (turnstile && !turnstile.value) problems.push('Please complete the "not a robot" check.');

  if (problems.length) {
    say(`<div class="note"><p><strong>Not sent yet:</strong></p><ul>${
      problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`);
    status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  button.disabled = true;
  const total = files.reduce((a, f) => a + f.size, 0);
  say(`<p class="dim">Sending ${files.length} file${files.length > 1 ? 's' : ''}, ${mb(total)} in total. Keep this tab open.</p>`
    + files.map((f, i) => `<div class="file-row" id="row${i}">${esc(f.name)} — <span id="pct${i}">waiting</span>
        <div class="bar"><span id="bar${i}"></span></div></div>`).join(''));

  const setPct = (i, p, label) => {
    document.getElementById('bar' + i).style.width = p + '%';
    document.getElementById('pct' + i).textContent = label || p + '%';
  };

  try {
    // ---- 1. announce the submission, open one multipart upload per file ----
    const created = await api('POST', '/create', {
      meta: {
        legalName: data.legalName, creditName: data.creditName, email: data.email,
        location: data.location || '', describe: data.describe,
        reference: data.reference || '',
        fadeIn: data.fadeIn || '', notes: data.notes || '',
        wantsPatcher: !!data.wantsPatcher, wantsNotation: !!data.wantsNotation,
        augmented: !!data.augmented,
        agreed: true, userAgent: navigator.userAgent,
      },
      files: files.map((f) => ({ name: f.name, size: f.size, type: f.type || '' })),
      turnstile: turnstile ? turnstile.value : undefined,
    });

    // ---- 2. stream the parts ----
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const up = created.uploads[i];
      const parts = [];
      let sent = 0;

      for (let n = 1, off = 0; off < f.size; n++, off += PART) {
        const chunk = f.slice(off, Math.min(off + PART, f.size));
        const etag = await putPart(created.submissionId, up, n, chunk);
        parts.push({ partNumber: n, etag });
        sent += chunk.size;
        setPct(i, Math.round((sent / f.size) * 100));
      }

      await api('POST', '/complete-file', {
        submissionId: created.submissionId, token: created.token,
        fileId: up.fileId, uploadId: up.uploadId, key: up.key, parts,
      });
      setPct(i, 100, 'done');
      document.getElementById('row' + i).classList.add('ok');
    }

    // ---- 3. write the metadata alongside the audio ----
    await api('POST', '/complete', { submissionId: created.submissionId, token: created.token });

    say(`<div class="note">
      <p><strong>Sent. Thank you.</strong></p>
      <p>${files.length} file${files.length > 1 ? 's' : ''} arrived, ${mb(total)}. Your reference is
      <code>${esc(created.submissionId)}</code> — keep it if you like, though I have your email.</p>
      <p>I will write back. If you asked for notation, that comes with the reply.</p>
      </div>`);
    form.style.display = 'none';

  } catch (err) {
    button.disabled = false;
    say(`<div class="note">
      <p><strong>That did not go through.</strong> ${isNetworkError(err) ? BLOCKED_MSG : esc(err.message || err)}</p>
      <p>Nothing is lost — try Send again. If it keeps failing, email the files to
      <a href="mailto:okurtul@bgsu.edu">okurtul@bgsu.edu</a> and I will sort it out.</p>
      </div>`);
  }
});

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text().catch(() => r.status));
  return r.json();
}

async function putPart(submissionId, up, partNumber, blob) {
  const q = new URLSearchParams({
    submissionId, fileId: up.fileId, uploadId: up.uploadId, key: up.key,
    partNumber: String(partNumber),
  });
  // One retry: a dropped part on a long upload should not cost the whole file.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${API}/part?${q}`, { method: 'PUT', body: blob });
      if (!r.ok) throw new Error(await r.text().catch(() => r.status));
      return (await r.json()).etag;
    } catch (e) {
      if (attempt) throw e;
    }
  }
}
