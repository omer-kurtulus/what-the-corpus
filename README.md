# What the C*rp*s

Open call for an album built from contributed recordings, played through
Somax2 (IRCAM). Deadline 30 November 2026; the record comes out on Bandcamp in
February 2027 with every contributor named.

Live at <https://omerkurtulus.com/what-the-corpus/>

This is a standalone site. It is deliberately not part of the portfolio site
at `omerkurtulus.com` — no shared nav, no shared design, no cross-links.

## What is here

```
index.html         About — the project, what a corpus is, what Somax2 does
record.html        Record — the recording brief
take-part.html     Take part — stage one: say what you have, get a brief back
upload.html        Send files — stage two: the chunked uploader
rights.html        Rights — the licence in plain language
contributors.html  Contributors — the list
style.css          Black and white, no framework
register.js        Take-part form
upload.js          Chunked upload client
worker/            Cloudflare Worker + R2 (see below)
```

Plain HTML. No build step, no dependencies, no Jekyll (`.nojekyll` is there so
GitHub Pages serves the files as they are). Edit and push.

## The two-stage flow

Contributors are pushed towards **Take part** first: they say what they have, and
Ömer replies with a corpus map and, if wanted, a page of notation written for
them. **Send files** stays open to anyone — someone with a recording already made
should not be blocked — but it is framed as step two and carries a box pointing
back.

## Uploads

GitHub Pages is static and cannot receive files, so uploads go to a Cloudflare
Worker backed by R2.

Audio never crosses the Worker as one body. The browser slices each file into
32 MB parts and the Worker relays each part into an R2 multipart upload. A
Worker request body is capped; a single part is not the whole file, so there is
no practical ceiling on submission size.

```
POST /register       stage one — no files
POST /create         open one multipart upload per file, mint an HMAC token
PUT  /part           relay one part, return its etag
POST /complete-file  finish one file
POST /complete       write submission.json beside the audio
```

In the bucket:

```
interest/<id>.json                     someone who wants to take part
submissions/<id>/audio/01-name.wav     the files
submissions/<id>/submission.json       metadata, written once every file lands
```

The Worker is live at
`https://upload.omerkurtulus.com` and the Turnstile
widget (`0x4AAAAAAEdqkpdzjcOvmb8K`, managed mode, locked to
`omerkurtulus.com`) is wired into both forms.

Verified end to end on 27 August 2026: a 90 MB WAV went up in three parts and
came back out of R2 with a matching SHA-256.

### Redeploying the Worker

```bash
cd worker
npm install
npx wrangler deploy
```

`wrangler login` must be run in a real terminal, not through an agent — the
OAuth flow needs a TTY to open the browser and hold the callback open.

`SIGNING_SECRET` and `TURNSTILE_SECRET` are already set. One optional secret is
not:

- `NOTIFY_WEBHOOK` — a Slack or Discord webhook. Without it, nothing tells you a
  submission arrived; you have to look in the bucket.

To test the upload path without a browser, swap in Cloudflare's always-passing
Turnstile secret (`1x0000000000000000000000000000000AA`), run the test, then put
the real one back — `wrangler turnstile widget get <sitekey> --json` returns it.

`ALLOWED_ORIGINS` in `wrangler.toml` must list the site's origin or the browser
will block the request.

## Adding a contributor

Edit `contributors.html` and add one `<li>`:

```html
<li><b>Credit Name</b> <span>Lisbon — bowed zither, paper</span></li>
```

Remove the `id="empty"` placeholder line once the first one is in.

## Contributed audio

Lives in R2, never in this repo. GitHub rejects files over 100 MB and a corpus
runs to gigabytes.
