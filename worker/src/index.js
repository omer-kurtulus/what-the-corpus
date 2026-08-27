/**
 * What the C*rp*s — upload endpoint.
 *
 * Audio does not pass through this Worker as one body. The browser slices each
 * file and sends parts; each part is relayed straight into an R2 multipart
 * upload. A Worker request body is capped; a single part is not the whole file,
 * so there is no practical ceiling on submission size.
 *
 *   POST /create         open one multipart upload per file, mint a token
 *   PUT  /part           relay one part into R2, return its etag
 *   POST /complete-file  finish one file
 *   POST /complete       write the metadata JSON beside the audio
 *
 * The token is an HMAC over the submission id. It stops a passer-by from
 * writing parts into somebody else's submission, and it is why /part itself
 * does not need to re-run the Turnstile check on every chunk.
 */

const OK_EXT = ['wav', 'aif', 'aiff', 'flac'];
const MAX_FILE = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 30;
const MAX_TOTAL = 4 * 1024 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || '*'),
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /':             return json({ ok: true, service: 'what-the-corpus' }, 200, cors);
        case 'POST /register':    return await register(request, env, cors);
        case 'POST /create':      return await create(request, env, cors);
        case 'PUT /part':         return await part(request, env, url, cors);
        case 'POST /complete-file': return await completeFile(request, env, cors);
        case 'POST /complete':    return await complete(request, env, cors);
        default:                  return text('Not found', 404, cors);
      }
    } catch (err) {
      // Never leak internals to the page; the message shown to a contributor
      // is deliberately vague and the detail goes to the Worker log.
      console.error(err && err.stack ? err.stack : String(err));
      return text('Upload failed on the server. Please try again.', 500, cors);
    }
  },
};

/* ------------------------------------------------------------------ routes */

/** Stage one: someone says what they have, before any file exists. */
async function register(request, env, cors) {
  const b = await request.json();
  if (!nonEmpty(b.name) || !nonEmpty(b.have)) return text('Missing required fields.', 400, cors);
  if (!/^\S+@\S+\.\S+$/.test(String(b.email || ''))) return text('Invalid email.', 400, cors);
  if (String(b.have).length > 5000 || String(b.tryout || '').length > 5000) {
    return text('That is longer than the form expects.', 400, cors);
  }
  if (!(await turnstileOk(b.turnstile, request, env))) {
    return text('The "not a robot" check did not pass. Please try again.', 400, cors);
  }

  const id = `${stamp()}-${slug(b.name)}-${rand(4)}`;
  const record = {
    name: b.name, email: b.email, location: b.location || '',
    have: b.have, tryout: b.tryout || '',
    wantsNotation: !!b.wantsNotation, augmented: !!b.augmented, wantsPatcher: !!b.wantsPatcher,
    received: new Date().toISOString(),
  };
  await env.BUCKET.put(`interest/${id}.json`, JSON.stringify(record, null, 2),
    { httpMetadata: { contentType: 'application/json' } });

  if (env.NOTIFY_WEBHOOK) {
    try {
      await fetch(env.NOTIFY_WEBHOOK, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `Wants to take part: ${record.name} <${record.email}>`
              + `${record.augmented ? ' [AUGMENTED]' : ''}${record.wantsNotation ? ' [notation]' : ''}`
              + `\n${record.have.slice(0, 400)}`,
        }),
      });
    } catch (e) { console.error('notify failed', e); }
  }
  return json({ ok: true, id }, 200, cors);
}

async function create(request, env, cors) {
  const body = await request.json();
  const meta = body.meta || {};
  const files = Array.isArray(body.files) ? body.files : [];

  if (!nonEmpty(meta.legalName) || !nonEmpty(meta.creditName) || !nonEmpty(meta.describe)) {
    return text('Missing required fields.', 400, cors);
  }
  if (!/^\S+@\S+\.\S+$/.test(String(meta.email || ''))) return text('Invalid email.', 400, cors);
  if (meta.agreed !== true) return text('The licence must be accepted.', 400, cors);
  if (!files.length) return text('No files listed.', 400, cors);
  if (files.length > MAX_FILES) return text(`At most ${MAX_FILES} files.`, 400, cors);

  let total = 0;
  for (const f of files) {
    const size = Number(f.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE) return text('Bad file size.', 400, cors);
    if (!OK_EXT.includes(String(f.name).split('.').pop().toLowerCase())) {
      return text('Only WAV, AIFF and FLAC.', 400, cors);
    }
    total += size;
  }
  if (total > MAX_TOTAL) return text('That submission is very large — please email me instead.', 400, cors);

  if (!(await turnstileOk(body.turnstile, request, env))) {
    return text('The "not a robot" check did not pass. Please try again.', 400, cors);
  }

  const submissionId = `${stamp()}-${slug(meta.creditName)}-${rand(4)}`;
  const uploads = [];
  for (let i = 0; i < files.length; i++) {
    const key = `submissions/${submissionId}/audio/${String(i + 1).padStart(2, '0')}-${safeName(files[i].name)}`;
    const mp = await env.BUCKET.createMultipartUpload(key);
    uploads.push({ fileId: String(i), key, uploadId: mp.uploadId });
  }

  // Held until /complete so the metadata is written only once every file is in.
  await env.BUCKET.put(
    `submissions/${submissionId}/pending.json`,
    JSON.stringify({ meta, files, received: new Date().toISOString() }, null, 2),
    { httpMetadata: { contentType: 'application/json' } },
  );

  return json({ submissionId, token: await sign(submissionId, env), uploads }, 200, cors);
}

async function part(request, env, url, cors) {
  const q = (k) => url.searchParams.get(k) || '';
  const key = q('key');
  const partNumber = Number(q('partNumber'));

  if (!keyBelongsTo(key, q('submissionId'))) return text('Bad key.', 400, cors);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return text('Bad part number.', 400, cors);
  }
  if (!request.body) return text('Empty part.', 400, cors);

  const mp = env.BUCKET.resumeMultipartUpload(key, q('uploadId'));
  const uploaded = await mp.uploadPart(partNumber, request.body);
  return json({ etag: uploaded.etag }, 200, cors);
}

async function completeFile(request, env, cors) {
  const b = await request.json();
  if (!(await verify(b.submissionId, b.token, env))) return text('Bad token.', 403, cors);
  if (!keyBelongsTo(b.key, b.submissionId)) return text('Bad key.', 400, cors);

  const parts = (b.parts || []).map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }));
  if (!parts.length) return text('No parts.', 400, cors);

  const mp = env.BUCKET.resumeMultipartUpload(b.key, b.uploadId);
  await mp.complete(parts);
  return json({ ok: true }, 200, cors);
}

async function complete(request, env, cors) {
  const b = await request.json();
  if (!(await verify(b.submissionId, b.token, env))) return text('Bad token.', 403, cors);

  const pending = await env.BUCKET.get(`submissions/${b.submissionId}/pending.json`);
  if (!pending) return text('Unknown submission.', 404, cors);
  const data = JSON.parse(await pending.text());

  const listed = await env.BUCKET.list({ prefix: `submissions/${b.submissionId}/audio/` });
  data.stored = listed.objects.map((o) => ({ key: o.key, size: o.size }));
  data.completed = new Date().toISOString();

  await env.BUCKET.put(
    `submissions/${b.submissionId}/submission.json`,
    JSON.stringify(data, null, 2),
    { httpMetadata: { contentType: 'application/json' } },
  );
  await env.BUCKET.delete(`submissions/${b.submissionId}/pending.json`);

  if (env.NOTIFY_WEBHOOK) {
    // Best effort: a failed notification must not fail the contributor's upload.
    try {
      await fetch(env.NOTIFY_WEBHOOK, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `New submission: ${data.meta.creditName} — ${data.stored.length} file(s)\n${b.submissionId}`,
        }),
      });
    } catch (e) { console.error('notify failed', e); }
  }

  return json({ ok: true, files: data.stored.length }, 200, cors);
}

/* ------------------------------------------------------------------ helpers */

const enc = new TextEncoder();

async function hmacKey(env) {
  return crypto.subtle.importKey('raw', enc.encode(env.SIGNING_SECRET || 'dev-only-secret'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(id, env) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(id));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verify(id, token, env) {
  if (!id || !token) return false;
  const expected = await sign(id, env);
  if (expected.length !== token.length) return false;
  let diff = 0;                                  // constant time
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

async function turnstileOk(token, request, env) {
  if (!env.TURNSTILE_SECRET) return true;        // not configured yet
  if (!token) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body: form });
  const out = await r.json();
  return out.success === true;
}

/** A key must sit inside the submission it claims — otherwise /part is a
 *  write primitive into any object in the bucket. */
function keyBelongsTo(key, submissionId) {
  return typeof key === 'string'
    && /^[0-9]{8}-[0-9]{6}-[a-z0-9-]{1,40}-[a-z0-9]{4}$/.test(String(submissionId))
    && key.startsWith(`submissions/${submissionId}/audio/`)
    && !key.includes('..');
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const rand = (n) => [...crypto.getRandomValues(new Uint8Array(n))]
  .map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'anon';
const safeName = (s) => String(s).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(-120);

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-`
       + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const json = (o, s, h) => new Response(JSON.stringify(o), { status: s, headers: { ...h, 'content-type': 'application/json' } });
const text = (t, s, h) => new Response(t, { status: s, headers: { ...h, 'content-type': 'text/plain; charset=utf-8' } });
