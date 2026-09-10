# Final URL Selection + L2 SEO Scope (read-only report, nothing changed)

Tested HEAD: `189455b6b8ddcc1e229b780ab1ac41ec598a9fd6` (latest remote/main; after the
approved mobile-overflow fix at `3aa3c1c`). Working tree clean. No code, data, settings,
Airtable, Supabase, git, migration, or deployment changes were made for this report.

## 1. Subdomain availability — CANNOT be verified pre-publish

There is no platform tool that checks `*.lovable.app` subdomain availability before
publishing. The available checks are:

- `project_urls--get_urls` → returns only THIS project's preview/published/custom URLs.
  Result: `preview_url` = `https://id-preview--e9ce5ab4-...lovable.app`,
  `published_url` = **null**, `inactive_custom_domains` = none.
- `registrar_domain--search_domains` → checks real-TLD custom domain registration
  (.com, .io, …), NOT `*.lovable.app` subdomains. Not applicable here.

The `*.lovable.app` subdomain slug is assigned/reserved at first **publish** time (via
the publish dialog / `preview_ui--publish` `slug` parameter). Whether a specific slug is
already taken by another Lovable project can only be confirmed by attempting to publish
with that slug — which the user has forbidden in this step.

**Verdict per candidate:**

| # | Candidate subdomain | Availability status |
|---|---------------------|---------------------|
| 1 | `almustatil.lovable.app` | **Cannot be checked pre-publish** |
| 2 | `almustatil-alakhdar.lovable.app` | **Cannot be checked pre-publish** |

Both are valid slug shapes (lowercase, hyphenated). At publish time, pass the desired
slug to `preview_ui--publish`; if it is already claimed by another project, the publish
step will report the conflict and we can fall back to the other candidate or a new one.

## 2. Current publication status

- **Not published.** `published_url` is `null`.
- No custom domains connected (`inactive_custom_domains`: none).
- The only live host is the draft preview: `https://id-preview--e9ce5ab4-...lovable.app`.
- Nothing was published or deployed during this report.

## 3. Current SEO state in the codebase (as found)

- 11 route files define `head()` meta: `__root.tsx`, `index.tsx`, `store.tsx`,
  `compare.tsx`, `contact.tsx`, `leaderboard.tsx`, `upcoming-games.tsx`, `records.tsx`,
  `rewards.tsx`, `players.$playerId.tsx`, `players.index.tsx`.
- Each has a unique `<title>`, meta description, `og:title`, `og:description`.
- `__root.tsx` sets `og:type=website` and `twitter:card=summary_large_image` globally.
- **No `canonical` link** exists on any route (`rg canonical` → 0 hits).
- **No `og:url`** on any route (`rg og:url` → 0 hits).
- **No `og:image` / `twitter:image`** on any route. The only hero/brand image is the
  logo, a **bundled relative asset** (`/__l5e/assets-v1/.../logo.png`, not an absolute
  https URL). Per metadata rules, a relative/bundled image must NOT be tagged, so both
  are correctly omitted today.
- `public/robots.txt` exists and allows all crawlers, but has **no `Sitemap:` directive**.
- **No sitemap route** exists (`src/routes/sitemap.xml.*` absent).
- No shared base-URL / `SITE_URL` constant exists anywhere in `src/`.

## 4. Exact minimal L2 file scope (to implement AFTER the final URL is chosen)

Scope is limited to URL-dependent launch metadata. Two parts: (A) per-route absolute
metadata, (B) robots + sitemap. Part A is required; Part B is recommended.

### A. Canonical + og:url (required) — 11 route files + 1 new config

Add a single source of truth for the final origin, then reference it from each `head()`.

1. **New file `src/lib/site-url.ts`** (or extend `src/data/site.ts`)
   - Export `const SITE_URL = "https://<final-subdomain-or-custom-domain>"` (set once
     the URL is chosen; single place to update later if the domain changes).
   - Export a tiny helper `canonicalFor(path: string)` returning `${SITE_URL}${path}`
     and an `ogUrlFor(path)` alias, so no route hardcodes the host.

2. **`src/routes/__root.tsx`** — add to `head().meta`:
   - `{ property: "og:url", content: SITE_URL }` (root/canonical home URL).
   - Do NOT add `canonical` to `__root` (root has no path of its own); canonicals belong
     on leaf routes.

3. **Each of the 10 leaf route files** — add two entries to `head().meta`:
   - `{ name: "canonical", content: canonicalFor("/<route-path>") }` — wait: TanStack
     uses `links` for canonical, not `meta`. Correct form:
     - In `head().links`: `{ rel: "canonical", href: canonicalFor("/<path>") }`
     - In `head().meta`: `{ property: "og:url", content: canonicalFor("/<path>") }`
   - For `players.$playerId.tsx` (dynamic), use the loader's player id/slug so each
     profile gets its own canonical/og:url.

Leaf files + paths:
- `index.tsx` → `/`
- `upcoming-games.tsx` → `/upcoming-games`
- `players.index.tsx` → `/players`
- `players.$playerId.tsx` → `/players/<id>` (dynamic, per-record)
- `compare.tsx` → `/compare`
- `leaderboard.tsx` → `/leaderboard`
- `records.tsx` → `/records`
- `store.tsx` → `/store`
- `rewards.tsx` → `/rewards`
- `contact.tsx` → `/contact`

Each change is mechanical: import the helper, add one `links` entry + one `meta` entry.
No titles, descriptions, styling, logic, data, or cache behavior changes.

### og:image / twitter:image — NO change needed

The only cover image is the bundled relative logo. Per metadata rules, relative/bundled
images are omitted. If the user later supplies an absolute https social preview image
(hosted on the custom domain), only `index.tsx` (and optionally `__root`) would gain
`og:image`/`twitter:image` pointing at that absolute URL. Not required for launch.

### B. robots.txt + sitemap (recommended, URL-dependent)

4. **`public/robots.txt`** — append one line:
   `Sitemap: https://<final-url>/sitemap.xml`
   (Keep existing allow rules unchanged.)

5. **New file `src/routes/sitemap.xml.ts`** (TanStack server route)
   - Generate `<?xml ...?><urlset>` with one `<url>` per static route (the 10 leaf paths
     above) plus one `<url>` per visible player profile (`/players/<id>`), using
     `SITE_URL` for absolute `loc`. Read the player roster via the existing players
     query/cache (read-only). Set `Content-Type: application/xml`.
   - This is optional for launch but standard for L2 SEO; it is the only new
     runtime file in the scope.

### Summary of files L2 would touch

| File | Change |
|------|--------|
| `src/lib/site-url.ts` (NEW) | `SITE_URL` constant + `canonicalFor` helper |
| `src/routes/__root.tsx` | add `og:url` (home) |
| `src/routes/index.tsx` | add canonical link + `og:url` |
| `src/routes/upcoming-games.tsx` | add canonical link + `og:url` |
| `src/routes/players.index.tsx` | add canonical link + `og:url` |
| `src/routes/players.$playerId.tsx` | add canonical link + `og:url` (dynamic) |
| `src/routes/compare.tsx` | add canonical link + `og:url` |
| `src/routes/leaderboard.tsx` | add canonical link + `og:url` |
| `src/routes/records.tsx` | add canonical link + `og:url` |
| `src/routes/store.tsx` | add canonical link + `og:url` |
| `src/routes/rewards.tsx` | add canonical link + `og:url` |
| `src/routes/contact.tsx` | add canonical link + `og:url` |
| `public/robots.txt` | append `Sitemap:` line |
| `src/routes/sitemap.xml.ts` (NEW, optional) | dynamic sitemap using `SITE_URL` |

No other production files. No data, cache, Airtable, H2, UI, dependency, or business
logic changes. The single `SITE_URL` constant means a future custom-domain swap is a
one-line change.

## 5. Confirmation

No code, data, plan-irrelevant files, migrations, Airtable records, Supabase state,
git state, project settings, subdomains, publications, or deployments were changed
during this report. This document (`.lovable/plan.md`) is the only file written.

## Next step

Choose the final URL. Two options:

1. **Pick a `*.lovable.app` slug** — at the publish step, pass `almustatil` or
   `almustatil-alakhdar` as the slug; the publish result confirms whether it was free.
   Then implement Part A (and optionally B) above with that `SITE_URL`.
2. **Connect a custom domain** (e.g. `almustatilalakhdar.com`) — publish to the
   Lovable slug first, then connect the custom domain in Project Settings → Domains,
   and set `SITE_URL` to the custom domain once it is Active/Primary.

Either way, recommend implementing L2 SEO (Part A) immediately after the URL is fixed,
before going fully live.
