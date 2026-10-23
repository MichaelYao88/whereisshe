# WhereIsShe setup

The live site already talks to Supabase project `xhaduveumhtikwoekxdi` with the publishable key in `app.js`. Do not put the service-role key in the site.

## Community compare (“How did everyone do?”)

Results read one public row from `community_snapshots` for that puzzle and day. Finished **daily** games (not archive, not preview) insert a row into `community_play_events` through `submit_community_play`. A failed insert does not block the game.

A snapshot is approximate. It is overwritten about every 12 hours.

- Under 40 real finishes for that day, the row is a deterministic stand-in (dozens to low hundreds of players, scores piled in the middle) with any real finishes blended in. `seeded` stays true.
- At 40 or more real finishes, the row is only those finishes and `seeded` becomes false.
- The same stand-in formula lives in `communitySeed()` in `app.js`. The results card uses it only when the snapshot row cannot be read, so the card is not blank before this migration has been applied. Once the row exists, the database wins.

### 1. Run the migration

In the Supabase Dashboard → SQL Editor, paste and run:

`supabase/migrations/20261023120000_community_snapshots.sql`

Or, with the CLI logged into this project:

```bash
supabase db query --linked -f supabase/migrations/20261023120000_community_snapshots.sql
```

That creates the tables, locks writes down, seeds snapshots from 2026-10-21 through two weeks ahead, and schedules `pg_cron` **if the extension is already on**.

### 2. Deploy the refresh function

```bash
supabase functions deploy community-snapshot --project-ref xhaduveumhtikwoekxdi
```

No extra secret is required. The hosted function already receives `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Optional: set `CRON_SECRET` if you want a second bearer token that is not the service-role key.

### 3. Run it every 12 hours

If the migration printed a notice that `pg_cron` is not available, this is the one Dashboard click:

1. Dashboard → **Integrations** → **Cron** (or Edge Functions → `community-snapshot` → Schedules).
2. Create a schedule: `15 */12 * * *` (every 12 hours, at minute 15).
3. Invoke `community-snapshot` with **POST** and the **service role** as the bearer token.

To turn on `pg_cron` instead: Dashboard → Database → Extensions → enable `pg_cron`, then re-run the last `do $$ ... cron.schedule ... $$` block from the migration.

Check a row:

```sql
select puzzle_id, day_key, players, avg_total, seeded
from public.community_snapshots
order by day_key
limit 20;
```
