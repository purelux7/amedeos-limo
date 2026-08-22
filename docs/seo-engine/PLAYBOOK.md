# The 3AM Shift — Amedeo's Organic Growth Engine Playbook

Standing instructions for the nightly autonomous SEO/AEO session on
allfloridaairportscarservice.com. Read this whole file before doing anything.
The mission: make Amedeo's the page Google ranks and the answer AI apps cite
for Florida airport car service queries — one shippable improvement a night.

Adapted from PureLux's proven "2AM Shift" (`purelux7/growth-program`), rebuilt
for this repo's stack: plain static HTML on GitHub Pages, no CMS, no build
step, no Docker. Simpler deploy, same discipline.

## Non-negotiable rules

1. **Claims accuracy first.** This is a licensed-for-hire transportation
   business, not a marketing sandbox — inaccurate license/insurance/policy
   claims are a real legal exposure for Matt, not just a compliance nit.
   Never state a license number, insurance carrier, specific guarantee, or
   policy detail that isn't already published on the site (`terms.html`,
   `privacy.html`, `index.html`). If a page needs a fact that isn't already
   on the site, write the page around what's verifiable and leave a
   `<!-- NEEDS OPERATOR INPUT: ... -->` comment instead of inventing it.
2. **Voice.** Sterile-luxury: graphite/platinum/antique-gold, Cormorant
   Garamond for headings, Inter for body, hairline borders, no emoji, no
   hype, no exclamation points. Match `index.html`'s current look exactly —
   don't reintroduce the earlier navy/cartoon styling.
3. **Never touch booking, payment, or Worker code.** That means `book.html`'s
   form logic, `script.js`'s booking widget, and anything under `worker/`.
   Content pages, metadata, schema, and internal links only. If a task would
   require touching those, skip it and log why.
4. **One night = one scoped unit of work.** Ship it fully (committed, pushed,
   verified live) or don't ship it at all. Never leave `main` broken.
5. **Verify live, always.** After pushing: curl the new/changed URL(s) for
   200 + a content marker. GitHub Pages usually publishes within ~1-2
   minutes — if a curl check fails immediately, wait and recheck before
   assuming failure.
6. **A parallel Claude session may also be working this repo.** Before you
   start, `git fetch && git log origin/main -1` — if someone else has pushed
   since your last run, `git pull --ff-only` first.

## Deploy procedure

This repo has no build step and no CI. Publishing IS the deploy:

```
git add <files>
git commit -m "..."
git push origin main
```

GitHub Pages serves straight from `main`, live within ~1-2 minutes. No PR,
no SSH, no Docker, no revalidate endpoint — that's PureLux's stack, not
this one.

If a task touches `sitemap.xml` (it usually will — every new page must be
added), update it in the same commit as the page itself, never as a
follow-up.

## Known traps

- `script.js` and `styles.css` are cache-busted with a `?v=N` query string in
  `index.html` (`<script src="script.js?v=14">`). If you ever touch either
  file (you shouldn't need to for content work), bump `N` in the same
  commit or browsers will serve the stale cached version.
- There are **two separate, independent booking-flow implementations**:
  `script.js` (used by a booking widget embedded in `index.html`) and an
  inline `<script>` at the bottom of `book.html` itself. They are not
  shared code. This is a trap for booking-logic work, not content work — but
  know it exists before you assume editing one touches the other.
- JSON-LD blocks are plain `<script type="application/ld+json">` in each
  page's `<head>` — no hydration timing issues like PureLux's Next.js setup,
  but keep JSON valid (a page will still render with broken JSON-LD, so
  validate it explicitly, e.g. `python3 -c "import json,re; ..."` or paste
  into Google's Rich Results Test — a syntax error won't show up as a build
  failure here the way it would in a framework).
- New pages need the **full head boilerplate by hand**: title, meta
  description, canonical, OG tags, Twitter tags, `Organization` +
  `BreadcrumbList` JSON-LD at minimum — there's no shared layout template.
  Copy the pattern from `privacy.html` or `terms.html`'s `<head>`.

## Nightly structure (60–90 min of work, then stop)

1. **Health check** (5 min): run `bash seo-health-check.sh` from the repo
   root; fix any regression FIRST — a broken site outranks all content work.
2. **Ship the top queue item**: open `docs/seo-engine/QUEUE.md`, take the top
   unchecked task, do it fully — page + schema + sitemap entry + internal
   links — then commit, push, verify live.
3. **Log the shift**: append one entry to `docs/seo-engine/SHIFT_LOG.md`
   (date, what shipped, URL(s), anything skipped and why). Check the task
   off in `QUEUE.md` with the date. Commit both with the work.
4. **Refill the queue** when it drops below 5 open items — add tasks
   consistent with the strategy below. Never add a task that violates the
   rules above.

## Strategy notes (why the queue looks like it does)

- **Per-airport guides** (`/guides/pbi`, `/guides/fll`, etc.) answer the
  actual question a traveler has: "where do I get picked up at [this
  specific airport]?" Each one needs genuinely distinct operational
  content — terminal/curbside layout, typical drive time from Stuart,
  what to do if a flight is delayed — not a city-name mad-lib. **This is
  the one place the "no geo-doorway pages" rule needs judgment, not a
  blanket ban**: six real airports with six genuinely different arrival
  experiences is legitimate; the banned pattern is the same paragraph
  repeated fifty times with only a place name swapped.
- **FAQ page** with `FAQPage` schema — this is the AEO citation magnet.
  Definition-first answers; AI answer engines quote the first clean
  sentence, so open every answer with the direct answer, then elaborate.
- **Comparison content** ("private car vs. rideshare vs. shuttle") catches
  high-intent "X vs Y" searches and is genuinely useful, not just SEO
  bait — write it honestly, including where a rideshare is the better
  choice.
- **NO geo-doorway pages** beyond the six real service airports above — no
  "car service in [50 Florida towns]" spam.
- **NO content subdomain** — everything lives on
  allfloridaairportscarservice.com, under `/guides/`, never `guides.*`.
- **Internal-link mesh**: every new page links to 2+ existing pages and gets
  linked from at least 1 existing page (start from `index.html`'s nav/footer
  once `/guides/` exists).
