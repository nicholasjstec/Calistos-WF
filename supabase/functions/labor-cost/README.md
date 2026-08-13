# labor-cost

Read-only Edge Function for external automation to pull a single day's
labor cost. Not wired into the staff app itself — deploy it separately.

## Response

```
GET /labor-cost?date=2026-08-12
Authorization: Bearer <LABOR_READ_TOKEN>
```

```json
{ "date": "2026-08-12", "totalCost": 412.50 }
```

`totalCost` is gross wages + tips for every shift on that date. Hours come
from actual clocked time (`time_entries`) when it exists for that shift's
worker on that day, otherwise the scheduled shift length — matching what
the Payroll tab shows a manager for that day. No names, rates, or
per-shift detail are ever returned.

Calendar-day bucketing for clock-in/out times uses the `STORE_TZ` constant
at the top of `index.ts` — currently set to `America/New_York`. Update it
there if the store's timezone changes.

## Deploy

This repo doesn't include the rest of a `supabase/` project (no
`config.toml`), so link to the existing project first if you haven't:

```
supabase login
supabase link --project-ref <your-project-ref>
```

Then deploy just this function:

```
supabase functions deploy labor-cost
```

## Set the auth token

Generate a random token and store it as a secret — this is a standalone
credential scoped to this one endpoint, not tied to any user login or the
app's existing anon/service role keys:

```
supabase secrets set LABOR_READ_TOKEN=$(openssl rand -hex 32)
```

To see the value you just set (Supabase won't display secrets again after
this), run `openssl rand -hex 32` yourself first, note it down, then pass
that exact value to `secrets set`.

The deployed URL will be:

```
https://<project-ref>.functions.supabase.co/labor-cost
```

## Test

```
curl "https://<project-ref>.functions.supabase.co/labor-cost?date=2026-08-12" \
  -H "Authorization: Bearer <token>"
```
