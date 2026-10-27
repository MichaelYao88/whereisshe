-- Suggest who to feature next, from the WhereIsShe home page.
-- Project: xhaduveumhtikwoekxdi (whereisshe).
-- NOT applied to production. Apply in the SQL editor after review.
-- Idempotent. Safe to re-run.
--
-- The browser inserts with the publishable anon key, or with the signed-in
-- user's access token. There is no select, update, or delete policy, so a
-- suggestion cannot be read back or edited from the client.
-- Use Prefer: return=minimal. return=representation needs a select policy
-- and will fail on purpose.
--
-- id and created_at are not granted, so the client cannot choose them.
-- A private trigger (not exposed by PostgREST) rate-limits one anon_id
-- to 5 inserts per hour. Read the rows in the SQL editor (the table owner
-- bypasses RLS).

create table if not exists public.feature_suggestions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  handle text not null,
  note text,
  email text,
  user_agent text,
  anon_id text not null,
  constraint feature_suggestions_handle_len
    check (char_length(btrim(handle)) between 1 and 30 and btrim(handle) ~ '^[A-Za-z0-9._]+$'),
  constraint feature_suggestions_note_len
    check (note is null or char_length(btrim(note)) between 1 and 500),
  constraint feature_suggestions_email_len
    check (
      email is null
      or (
        char_length(btrim(email)) between 3 and 120
        and btrim(email) ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    ),
  constraint feature_suggestions_user_agent_len
    check (user_agent is null or char_length(user_agent) between 1 and 240),
  constraint feature_suggestions_anon_id_len
    check (char_length(anon_id) between 1 and 80)
);

comment on table public.feature_suggestions is
  'Home-page suggestions of who to feature next. Anon and authenticated may insert only. No client reads.';

comment on column public.feature_suggestions.handle is
  'Instagram handle without @, 1–30 characters.';

comment on column public.feature_suggestions.anon_id is
  'PostHog distinct id, or a local fallback. Used only to rate-limit inserts. Not an account.';

create index if not exists feature_suggestions_created_at_idx
  on public.feature_suggestions (created_at desc);

create index if not exists feature_suggestions_anon_recent_idx
  on public.feature_suggestions (anon_id, created_at desc);

alter table public.feature_suggestions enable row level security;

revoke all on table public.feature_suggestions from anon, authenticated;

grant insert (
  handle,
  note,
  email,
  user_agent,
  anon_id
) on table public.feature_suggestions to anon, authenticated;

drop policy if exists feature_suggestions_insert on public.feature_suggestions;

create policy feature_suggestions_insert
  on public.feature_suggestions
  for insert
  to anon, authenticated
  with check (true);

create schema if not exists private;

revoke all on schema private from public;

grant usage on schema private to anon, authenticated;

create or replace function private.feature_suggestions_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  select count(*) into n
    from public.feature_suggestions
    where anon_id = new.anon_id
      and created_at > pg_catalog.now() - interval '1 hour';
  if n >= 5 then
    raise exception 'rate limited' using errcode = 'P0001';
  end if;
  return new;
end
$$;

drop trigger if exists feature_suggestions_guard on public.feature_suggestions;

create trigger feature_suggestions_guard
  before insert on public.feature_suggestions
  for each row execute function private.feature_suggestions_guard();

revoke all on function private.feature_suggestions_guard() from public;

grant execute on function private.feature_suggestions_guard() to anon, authenticated;
