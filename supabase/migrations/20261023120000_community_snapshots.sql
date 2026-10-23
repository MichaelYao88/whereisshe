-- Community compare: a public snapshot per (puzzle, day), refreshed about every 12 hours.
-- Players never write the snapshot. Finished daily games may insert one play event.
-- Until a day has 40 real finishes, the snapshot is a deterministic seed blended with
-- whatever events exist, so "How did everyone do?" is never an empty card.
-- The seed formula matches communitySeed() in app.js (FNV-1a, same salts).

create table if not exists public.community_rotation (
  ord integer primary key check (ord >= 0),
  puzzle_id text not null
);

create table if not exists public.community_pinned (
  day_key date primary key,
  puzzle_id text not null
);

insert into public.community_rotation (ord, puzzle_id) values
  (0, 'she-001'), (1, 'she-002'), (2, 'she-003'), (3, 'she-004'),
  (4, 'she-005'), (5, 'he-001'), (6, 'she-006')
on conflict (ord) do update set puzzle_id = excluded.puzzle_id;

insert into public.community_pinned (day_key, puzzle_id) values
  (date '2026-10-21', 'she-001'),
  (date '2026-10-22', 'she-002'),
  (date '2026-10-23', 'she-003'),
  (date '2026-10-24', 'she-004'),
  (date '2026-10-25', 'she-005'),
  (date '2026-10-26', 'he-001'),
  (date '2026-10-27', 'she-006')
on conflict (day_key) do update set puzzle_id = excluded.puzzle_id;

create table if not exists public.community_snapshots (
  puzzle_id text not null,
  day_key date not null,
  players integer not null check (players >= 0),
  avg_total numeric not null check (avg_total >= 0 and avg_total <= 25000),
  histogram jsonb not null,
  per_round_avg jsonb not null,
  seeded boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (puzzle_id, day_key)
);

comment on table public.community_snapshots is
  'Approximate per-day score snapshot. Public read. Overwritten by refresh_community_snapshots(). seeded=true means a stand-in distribution is still in the mix.';

create table if not exists public.community_play_events (
  id bigint generated always as identity primary key,
  puzzle_id text not null,
  day_key date not null,
  total integer not null check (total >= 0 and total <= 25000),
  rounds integer[] not null check (cardinality(rounds) = 5),
  created_at timestamptz not null default now()
);

create index if not exists community_play_events_day_idx
  on public.community_play_events (puzzle_id, day_key);

comment on table public.community_play_events is
  'One row per finished daily game. No public read. Inserts go through submit_community_play().';

alter table public.community_rotation enable row level security;
alter table public.community_pinned enable row level security;
alter table public.community_snapshots enable row level security;
alter table public.community_play_events enable row level security;

revoke all on public.community_rotation from public, anon, authenticated;
revoke all on public.community_pinned from public, anon, authenticated;
revoke all on public.community_play_events from public, anon, authenticated;
revoke all on public.community_snapshots from public, anon, authenticated;
grant select on public.community_snapshots to anon, authenticated;

drop policy if exists community_snapshots_read on public.community_snapshots;
create policy community_snapshots_read on public.community_snapshots
  for select to anon, authenticated
  using (true);

-- Schedule: pinned dates win. The day after 2026-10-27 is rotation[0] (she-001).
create or replace function public.community_puzzle_for(p_day date)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select puzzle_id from public.community_pinned where day_key = p_day),
    (select puzzle_id from public.community_rotation
      where ord = mod((p_day - date '2026-10-27' - 1), 7))
  );
$$;

-- Unsigned 32-bit FNV-1a. Same steps as fnv1a() in app.js.
create or replace function public.community_fnv1a(p text)
returns bigint
language plpgsql
immutable
security definer
set search_path = public
as $$
declare
  h bigint := 2166136261;
  i integer;
  c integer;
begin
  if p is null then return 0; end if;
  for i in 1..length(p) loop
    c := ascii(substr(p, i, 1));
    h := (h # c) & 4294967295;
    h := (h * 16777619) & 4294967295;
  end loop;
  return h;
end;
$$;

create or replace function public.community_seed(p_puzzle_id text, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  day_text text := to_char(p_day, 'YYYY-MM-DD');
  base_w integer[] := array[8, 18, 38, 26, 10];
  mids integer[] := array[2500, 7500, 12500, 17500, 22500];
  mins integer[] := array[0, 5000, 10000, 15000, 20000];
  maxs integer[] := array[5000, 10000, 15000, 20000, 25001];
  weights integer[] := array[0, 0, 0, 0, 0];
  counts integer[] := array[0, 0, 0, 0, 0];
  avgs integer[] := array[0, 0, 0, 0, 0];
  players integer;
  sum_w integer := 0;
  drift integer;
  weighted bigint := 0;
  avg_total integer;
  i integer;
  jitter integer;
  sum_avgs integer;
begin
  players := 48 + (public.community_fnv1a(p_puzzle_id || '|' || day_text || '|n') % 133);
  for i in 1..5 loop
    weights[i] := greatest(1, base_w[i] + (public.community_fnv1a(p_puzzle_id || '|' || day_text || '|w' || (i - 1)) % 5) - 2);
    sum_w := sum_w + weights[i];
  end loop;
  for i in 1..5 loop
    counts[i] := (players * weights[i]) / sum_w;
  end loop;
  drift := players - (counts[1] + counts[2] + counts[3] + counts[4] + counts[5]);
  counts[3] := counts[3] + drift;
  for i in 1..5 loop
    weighted := weighted + counts[i]::bigint * mids[i];
  end loop;
  avg_total := round(weighted::numeric / players);
  for i in 1..5 loop
    jitter := (public.community_fnv1a(p_puzzle_id || '|' || day_text || '|r' || (i - 1)) % 801) - 400;
    avgs[i] := greatest(600, least(4600, round(avg_total::numeric / 5 + jitter)));
  end loop;
  sum_avgs := avgs[1] + avgs[2] + avgs[3] + avgs[4] + avgs[5];
  avgs[5] := greatest(0, least(5000, avgs[5] + (avg_total - sum_avgs)));
  return jsonb_build_object(
    'players', players,
    'avg_total', avg_total,
    'histogram', jsonb_build_array(
      jsonb_build_object('min', mins[1], 'max', maxs[1], 'n', counts[1]),
      jsonb_build_object('min', mins[2], 'max', maxs[2], 'n', counts[2]),
      jsonb_build_object('min', mins[3], 'max', maxs[3], 'n', counts[3]),
      jsonb_build_object('min', mins[4], 'max', maxs[4], 'n', counts[4]),
      jsonb_build_object('min', mins[5], 'max', maxs[5], 'n', counts[5])
    ),
    'per_round_avg', to_jsonb(avgs)
  );
end;
$$;

create or replace function public.upsert_community_snapshot(p_puzzle_id text, p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  seed jsonb;
  seed_players integer;
  seed_avg integer;
  real_n integer;
  sum_total bigint;
  sum_rounds bigint[];
  counts integer[] := array[0, 0, 0, 0, 0];
  avgs integer[] := array[0, 0, 0, 0, 0];
  mins integer[] := array[0, 5000, 10000, 15000, 20000];
  maxs integer[] := array[5000, 10000, 15000, 20000, 25001];
  players integer;
  avg_total integer;
  seeded boolean;
  i integer;
  ev record;
  hist jsonb;
begin
  if p_puzzle_id is null or p_day is null then return; end if;
  seed := public.community_seed(p_puzzle_id, p_day);
  seed_players := (seed->>'players')::integer;
  seed_avg := (seed->>'avg_total')::integer;
  for i in 1..5 loop
    counts[i] := (seed->'histogram'->(i - 1)->>'n')::integer;
    avgs[i] := (seed->'per_round_avg'->> (i - 1))::integer;
  end loop;

  select count(*), coalesce(sum(total), 0) into real_n, sum_total
  from public.community_play_events
  where puzzle_id = p_puzzle_id and day_key = p_day;

  if real_n > 0 then
    select array[
      coalesce(sum(rounds[1]), 0), coalesce(sum(rounds[2]), 0), coalesce(sum(rounds[3]), 0),
      coalesce(sum(rounds[4]), 0), coalesce(sum(rounds[5]), 0)
    ] into sum_rounds
    from public.community_play_events
    where puzzle_id = p_puzzle_id and day_key = p_day;
  else
    sum_rounds := array[0, 0, 0, 0, 0]::bigint[];
  end if;

  if real_n >= 40 then
    seeded := false;
    players := real_n;
    avg_total := round(sum_total::numeric / real_n);
    for i in 1..5 loop
      avgs[i] := round(sum_rounds[i]::numeric / real_n)::integer;
      counts[i] := 0;
    end loop;
    for ev in
      select case
        when total >= 20000 then 5
        when total >= 15000 then 4
        when total >= 10000 then 3
        when total >= 5000 then 2
        else 1
      end as b
      from public.community_play_events
      where puzzle_id = p_puzzle_id and day_key = p_day
    loop
      counts[ev.b] := counts[ev.b] + 1;
    end loop;
  else
    seeded := true;
    players := seed_players + real_n;
    avg_total := round((seed_avg::numeric * seed_players + sum_total) / players);
    for i in 1..5 loop
      avgs[i] := round((avgs[i]::numeric * seed_players + sum_rounds[i]) / players)::integer;
    end loop;
    if real_n > 0 then
      for ev in
        select case
          when total >= 20000 then 5
          when total >= 15000 then 4
          when total >= 10000 then 3
          when total >= 5000 then 2
          else 1
        end as b
        from public.community_play_events
        where puzzle_id = p_puzzle_id and day_key = p_day
      loop
        counts[ev.b] := counts[ev.b] + 1;
      end loop;
    end if;
  end if;

  hist := jsonb_build_array(
    jsonb_build_object('min', mins[1], 'max', maxs[1], 'n', counts[1]),
    jsonb_build_object('min', mins[2], 'max', maxs[2], 'n', counts[2]),
    jsonb_build_object('min', mins[3], 'max', maxs[3], 'n', counts[3]),
    jsonb_build_object('min', mins[4], 'max', maxs[4], 'n', counts[4]),
    jsonb_build_object('min', mins[5], 'max', maxs[5], 'n', counts[5])
  );

  insert into public.community_snapshots
    (puzzle_id, day_key, players, avg_total, histogram, per_round_avg, seeded, updated_at)
  values
    (p_puzzle_id, p_day, players, avg_total, hist, to_jsonb(avgs), seeded, now())
  on conflict (puzzle_id, day_key) do update set
    players = excluded.players,
    avg_total = excluded.avg_total,
    histogram = excluded.histogram,
    per_round_avg = excluded.per_round_avg,
    seeded = excluded.seeded,
    updated_at = now();
end;
$$;

-- Recompute recent days and keep a seed through two weeks ahead. Returns rows written.
create or replace function public.refresh_community_snapshots()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  start_d date := date '2026-10-21';
  end_d date;
  d date;
  pid text;
  n integer := 0;
  rec record;
begin
  end_d := least((timezone('utc', now()))::date + 14, start_d + 400);
  if end_d < start_d then end_d := start_d; end if;
  d := start_d;
  while d <= end_d loop
    pid := public.community_puzzle_for(d);
    if pid is not null then
      perform public.upsert_community_snapshot(pid, d);
      n := n + 1;
    end if;
    d := d + 1;
  end loop;
  for rec in
    select distinct puzzle_id, day_key
    from public.community_play_events
    where day_key < start_d or day_key > end_d
  loop
    perform public.upsert_community_snapshot(rec.puzzle_id, rec.day_key);
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.submit_community_play(
  p_puzzle_id text,
  p_day_key date,
  p_total integer,
  p_rounds integer[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  round_sum integer;
begin
  if p_puzzle_id is null or p_puzzle_id !~ '^(she|he)-[0-9]{3}$' then
    raise exception 'invalid community play' using errcode = '22023';
  end if;
  if p_day_key is null
     or p_day_key < date '2026-10-21'
     or p_day_key > (timezone('utc', now()))::date then
    raise exception 'invalid community play' using errcode = '22023';
  end if;
  if p_rounds is null or cardinality(p_rounds) <> 5 then
    raise exception 'invalid community play' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_rounds) as r where r is null or r < 0 or r > 5000) then
    raise exception 'invalid community play' using errcode = '22023';
  end if;
  select coalesce(sum(r), 0) into round_sum from unnest(p_rounds) as r;
  if p_total is null or p_total < 0 or p_total > 25000 or p_total <> round_sum then
    raise exception 'invalid community play' using errcode = '22023';
  end if;
  insert into public.community_play_events (puzzle_id, day_key, total, rounds)
  values (p_puzzle_id, p_day_key, p_total, p_rounds);
end;
$$;

revoke all on function public.community_puzzle_for(date) from public, anon, authenticated;
revoke all on function public.community_fnv1a(text) from public, anon, authenticated;
revoke all on function public.community_seed(text, date) from public, anon, authenticated;
revoke all on function public.upsert_community_snapshot(text, date) from public, anon, authenticated;
revoke all on function public.refresh_community_snapshots() from public, anon, authenticated;
revoke all on function public.submit_community_play(text, date, integer, integer[]) from public;
grant execute on function public.submit_community_play(text, date, integer, integer[]) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.refresh_community_snapshots() to service_role;
  end if;
end $$;

select public.refresh_community_snapshots();

-- pg_cron is optional. If the extension is not enabled, the migration still succeeds.
-- Dashboard alternative: see SETUP.md (Edge Function community-snapshot, every 12 hours).
do $$
declare
  job_id bigint;
begin
  if exists (select 1 from pg_namespace where nspname = 'cron')
     and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'cron' and p.proname = 'schedule') then
    select j.jobid into job_id from cron.job j where j.jobname = 'community-snapshots-12h';
    if job_id is not null then
      perform cron.unschedule(job_id);
    end if;
    perform cron.schedule(
      'community-snapshots-12h',
      '15 */12 * * *',
      'select public.refresh_community_snapshots()'
    );
  else
    raise notice 'pg_cron is not available. Schedule the community-snapshot Edge Function every 12 hours (SETUP.md).';
  end if;
exception when others then
  raise notice 'community snapshot cron was not scheduled (%). See SETUP.md.', sqlerrm;
end $$;
