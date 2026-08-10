# Amadeo's CRM — deploy guide

The reservation Worker now also runs the CRM (database + dashboard + map).
Everything lives on Cloudflare's free tier (~$0/month at this volume).

## One-time setup

From inside `worker/`:

### 1. Log in to Cloudflare
```
npx wrangler login
```

### 2. Create the database
```
npx wrangler d1 create afacs-crm
```
Copy the printed `database_id` into `wrangler.toml` (replace
`REPLACE_WITH_DATABASE_ID_FROM_wrangler_d1_create`).

### 3. Create the tables
```
npx wrangler d1 execute afacs-crm --remote --file=schema.sql
```

### 4. Set the secrets (you'll be prompted to paste each value)
```
npx wrangler secret put RESEND_API_KEY     # existing email key
npx wrangler secret put MAPBOX_TOKEN        # from mapbox.com (free) — geocoding + map
npx wrangler secret put ADMIN_PASSWORD      # the password Matt uses to log in
```

### 5. Deploy
```
npx wrangler deploy
```

## Using it

- **Dashboard:** `https://afacs-reservations.<account>.workers.dev/admin`
  (log in with ADMIN_PASSWORD). Add it to Matt's phone home screen.
- **Bookings** from the website save automatically and show up in the dashboard;
  Matt still gets the email too.
- **Map** plots each pickup; pick a date to see just that day's rides.

## Notes
- Existing bookings (before this) aren't in the DB — only new ones from now on.
- The Mapbox token is also injected into the dashboard for the map; use a
  Mapbox **public** token (optionally URL-restricted to the workers.dev domain).
- To back up the data anytime: `npx wrangler d1 export afacs-crm --remote --output=backup.sql`
