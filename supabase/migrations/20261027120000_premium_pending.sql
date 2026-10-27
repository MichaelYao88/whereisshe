-- Premium bought on Ranki (same Lemon Squeezy variant) carries a Ranki user id, not a WhereIsShe one.
-- wis_apply_premium grants the matching WhereIsShe profile, or stores the grant in premium_pending
-- keyed by lower(email) until that person signs up or signs in with a confirmed email.
-- Claim runs from the existing auth.users insert hook, and when email_confirmed_at / last_sign_in_at changes.
-- Unconfirmed emails never receive the grant.
--
-- Apply this file in the Supabase SQL editor (or `supabase db query --linked -f ...`).
-- Do not expect the webhook to grant by email until this migration has been applied.

create table if not exists public.premium_pending (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  premium boolean not null default false,
  premium_until timestamptz,
  ls_customer_id text,
  ls_order_id text,
  ls_subscription_id text,
  ls_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.premium_pending is
  'Lemon Squeezy Premium grant waiting for a WhereIsShe account with this confirmed email. Service role only.';

create index if not exists premium_pending_ls_subscription_idx
  on public.premium_pending (ls_subscription_id)
  where ls_subscription_id is not null;

create index if not exists premium_pending_ls_customer_idx
  on public.premium_pending (ls_customer_id)
  where ls_customer_id is not null;

create index if not exists profiles_email_lower_idx
  on public.profiles (lower(email));

alter table public.premium_pending enable row level security;

revoke all on public.premium_pending from public, anon, authenticated;
grant select, insert, update, delete on public.premium_pending to service_role;

-- Apply a webhook patch onto one profile. Only keys present in p_patch change.
-- premium_until is applied even when the JSON value is null (no end date).
create or replace function public.wis_patch_profile(p_id uuid, p_patch jsonb)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.profiles%rowtype;
begin
  update public.profiles set
    premium = case when p_patch ? 'premium' then (p_patch->>'premium')::boolean else premium end,
    premium_until = case
      when p_patch ? 'premium_until' then (p_patch->>'premium_until')::timestamptz
      else premium_until end,
    ls_customer_id = case
      when p_patch ? 'ls_customer_id' then nullif(p_patch->>'ls_customer_id', '')
      else ls_customer_id end,
    ls_order_id = case
      when p_patch ? 'ls_order_id' then nullif(p_patch->>'ls_order_id', '')
      else ls_order_id end,
    ls_subscription_id = case
      when p_patch ? 'ls_subscription_id' then nullif(p_patch->>'ls_subscription_id', '')
      else ls_subscription_id end,
    ls_status = case when p_patch ? 'ls_status' then p_patch->>'ls_status' else ls_status end
  where id = p_id
  returning * into v;
  if not found then
    raise exception 'profile missing for premium grant';
  end if;
  return v;
end
$$;

create or replace function public.wis_merge_premium_pending(p_email text, p_patch jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  if v_email is null or position('@' in v_email) < 2 then
    return null;
  end if;
  insert into public.premium_pending as t (
    email, premium, premium_until, ls_customer_id, ls_order_id, ls_subscription_id, ls_status
  ) values (
    v_email,
    case when p_patch ? 'premium' then coalesce((p_patch->>'premium')::boolean, false) else false end,
    case when p_patch ? 'premium_until' then (p_patch->>'premium_until')::timestamptz else null end,
    nullif(p_patch->>'ls_customer_id', ''),
    nullif(p_patch->>'ls_order_id', ''),
    nullif(p_patch->>'ls_subscription_id', ''),
    p_patch->>'ls_status'
  )
  on conflict (email) do update set
    premium = case when p_patch ? 'premium' then coalesce((p_patch->>'premium')::boolean, t.premium) else t.premium end,
    premium_until = case
      when p_patch ? 'premium_until' then (p_patch->>'premium_until')::timestamptz
      else t.premium_until end,
    ls_customer_id = case
      when p_patch ? 'ls_customer_id' then nullif(p_patch->>'ls_customer_id', '')
      else t.ls_customer_id end,
    ls_order_id = case
      when p_patch ? 'ls_order_id' then nullif(p_patch->>'ls_order_id', '')
      else t.ls_order_id end,
    ls_subscription_id = case
      when p_patch ? 'ls_subscription_id' then nullif(p_patch->>'ls_subscription_id', '')
      else t.ls_subscription_id end,
    ls_status = case when p_patch ? 'ls_status' then p_patch->>'ls_status' else t.ls_status end,
    updated_at = now();
  return v_email;
end
$$;

-- Drop a pending grant that this profile update supersedes, so a later sign-in cannot replay it.
create or replace function public.wis_clear_premium_pending(p_profile uuid, p_email text, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_owner text;
  v_sub text := nullif(p_patch->>'ls_subscription_id', '');
  v_cust text := nullif(p_patch->>'ls_customer_id', '');
begin
  select nullif(lower(btrim(u.email::text)), '') into v_owner
  from auth.users u
  where u.id = p_profile and u.email_confirmed_at is not null;

  delete from public.premium_pending
  where (v_email is not null and email = v_email)
     or (v_owner is not null and email = v_owner)
     or (v_sub is not null and ls_subscription_id = v_sub)
     or (v_cust is not null and ls_customer_id = v_cust);
end
$$;

create or replace function public.wis_apply_premium(p_user_id uuid, p_email text, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_sub text := nullif(p_patch->>'ls_subscription_id', '');
  v_cust text := nullif(p_patch->>'ls_customer_id', '');
  v_id uuid;
  v_n int;
  v_row public.profiles%rowtype;
  v_pending text;
begin
  if p_patch is null then
    raise exception 'missing premium patch';
  end if;
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtext('wis-premium:' || v_email));
  end if;

  -- 1. Checkout custom user_id, when it is a WhereIsShe profile (unchanged path).
  if p_user_id is not null and exists (select 1 from public.profiles where id = p_user_id) then
    v_id := p_user_id;
  end if;

  -- 2. Later subscription / refund events for someone already linked.
  if v_id is null and v_sub is not null then
    select count(*) into v_n from public.profiles where ls_subscription_id = v_sub;
    if v_n = 1 then
      select id into v_id from public.profiles where ls_subscription_id = v_sub;
    elsif v_n > 1 then
      return jsonb_build_object('ignored', 'ambiguous subscription', 'note', 'ambiguous subscription');
    end if;
  end if;

  if v_id is null and v_cust is not null then
    select count(*) into v_n from public.profiles where ls_customer_id = v_cust;
    if v_n = 1 then
      select id into v_id from public.profiles where ls_customer_id = v_cust;
    elsif v_n > 1 then
      return jsonb_build_object('ignored', 'ambiguous customer', 'note', 'ambiguous customer');
    end if;
  end if;

  -- 3. Confirmed email on auth.users, else a single confirmed profile.email.
  --    An unconfirmed account is not granted; the purchase stays pending.
  if v_id is null and v_email is not null then
    select count(*) into v_n
    from public.profiles p
    join auth.users u on u.id = p.id
    where u.email_confirmed_at is not null
      and lower(btrim(coalesce(u.email::text, ''))) = v_email;
    if v_n = 1 then
      select p.id into v_id
      from public.profiles p
      join auth.users u on u.id = p.id
      where u.email_confirmed_at is not null
        and lower(btrim(coalesce(u.email::text, ''))) = v_email;
    elsif v_n > 1 then
      v_pending := public.wis_merge_premium_pending(v_email, p_patch);
      return jsonb_build_object('ok', true, 'pending', true, 'email', v_pending, 'note', 'ambiguous email');
    else
      select count(*) into v_n
      from public.profiles p
      join auth.users u on u.id = p.id
      where u.email_confirmed_at is not null
        and lower(btrim(coalesce(p.email, ''))) = v_email;
      if v_n = 1 then
        select p.id into v_id
        from public.profiles p
        join auth.users u on u.id = p.id
        where u.email_confirmed_at is not null
          and lower(btrim(coalesce(p.email, ''))) = v_email;
      elsif v_n > 1 then
        v_pending := public.wis_merge_premium_pending(v_email, p_patch);
        return jsonb_build_object('ok', true, 'pending', true, 'email', v_pending, 'note', 'ambiguous email');
      end if;
    end if;
  end if;

  if v_id is not null then
    v_row := public.wis_patch_profile(v_id, p_patch);
    perform public.wis_clear_premium_pending(v_id, v_email, p_patch);
    return jsonb_build_object(
      'ok', true,
      'user_id', v_row.id,
      'premium', v_row.premium,
      'premium_until', v_row.premium_until
    );
  end if;

  if v_email is not null then
    v_pending := public.wis_merge_premium_pending(v_email, p_patch);
    return jsonb_build_object('ok', true, 'pending', true, 'email', v_pending, 'note', 'pending email');
  end if;

  -- Renewal / refund with no email: keep a not-yet-claimed grant in step with Lemon Squeezy.
  if v_sub is not null then
    select count(*) into v_n from public.premium_pending where ls_subscription_id = v_sub;
    if v_n = 1 then
      select email into v_pending from public.premium_pending where ls_subscription_id = v_sub;
      perform public.wis_merge_premium_pending(v_pending, p_patch);
      return jsonb_build_object('ok', true, 'pending', true, 'email', v_pending, 'note', 'pending subscription');
    elsif v_n > 1 then
      return jsonb_build_object('ignored', 'ambiguous subscription', 'note', 'ambiguous subscription');
    end if;
  end if;

  if v_cust is not null then
    select count(*) into v_n from public.premium_pending where ls_customer_id = v_cust;
    if v_n = 1 then
      select email into v_pending from public.premium_pending where ls_customer_id = v_cust;
      perform public.wis_merge_premium_pending(v_pending, p_patch);
      return jsonb_build_object('ok', true, 'pending', true, 'email', v_pending, 'note', 'pending customer');
    elsif v_n > 1 then
      return jsonb_build_object('ignored', 'ambiguous customer', 'note', 'ambiguous customer');
    end if;
  end if;

  if p_user_id is not null then
    return jsonb_build_object('ignored', 'no profile for that user id', 'note', 'no profile');
  end if;
  return jsonb_build_object('ignored', 'no user_id in custom data', 'note', 'no user_id');
end
$$;

-- Copy a pending grant onto this user. Only when their auth email is confirmed, and it is the only
-- confirmed auth user with that address (so an unverified signup cannot take someone else's purchase).
create or replace function public.wis_claim_premium_pending(p_uid uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_confirmed timestamptz;
  v_n int;
  pend public.premium_pending%rowtype;
  v_patch jsonb;
begin
  select lower(btrim(u.email::text)), u.email_confirmed_at
    into v_email, v_confirmed
  from auth.users u
  where u.id = p_uid;

  if v_email is null or v_email = '' or v_confirmed is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtext('wis-premium:' || v_email));

  select count(*) into v_n
  from auth.users u
  where u.email_confirmed_at is not null
    and lower(btrim(u.email::text)) = v_email;
  if v_n <> 1 then
    return false;
  end if;

  select * into pend from public.premium_pending where email = v_email for update;
  if not found then
    return false;
  end if;
  if not exists (select 1 from public.profiles where id = p_uid) then
    return false;
  end if;

  v_patch := jsonb_build_object('premium', pend.premium, 'premium_until', pend.premium_until);
  if pend.ls_customer_id is not null then
    v_patch := v_patch || jsonb_build_object('ls_customer_id', pend.ls_customer_id);
  end if;
  if pend.ls_order_id is not null then
    v_patch := v_patch || jsonb_build_object('ls_order_id', pend.ls_order_id);
  end if;
  if pend.ls_subscription_id is not null then
    v_patch := v_patch || jsonb_build_object('ls_subscription_id', pend.ls_subscription_id);
  end if;
  if pend.ls_status is not null then
    v_patch := v_patch || jsonb_build_object('ls_status', pend.ls_status);
  end if;

  perform public.wis_patch_profile(p_uid, v_patch);
  delete from public.premium_pending where email = v_email;
  return true;
end
$$;

-- Existing signup hook: create the profile, then claim a pending grant if this email is already confirmed
-- (Google, or magic-link projects that confirm on insert). Unconfirmed inserts claim nothing.
create or replace function public.wis_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  perform public.wis_claim_premium_pending(new.id);
  return new;
end
$$;

-- Magic-link confirmation sets email_confirmed_at later. Sign-in bumps last_sign_in_at, which claims a
-- grant that arrived after the account already existed.
create or replace function public.wis_on_auth_user_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email_confirmed_at is null or new.email is null then
    return new;
  end if;
  update public.profiles
    set email = new.email
    where id = new.id
      and email is distinct from new.email;
  perform public.wis_claim_premium_pending(new.id);
  return new;
end
$$;

drop trigger if exists wis_on_auth_user_created on auth.users;
create trigger wis_on_auth_user_created
  after insert on auth.users
  for each row execute function public.wis_handle_new_user();

drop trigger if exists wis_on_auth_user_confirmed on auth.users;
create trigger wis_on_auth_user_confirmed
  after update of email, email_confirmed_at, last_sign_in_at on auth.users
  for each row
  when (new.email_confirmed_at is not null)
  execute function public.wis_on_auth_user_confirmed();

revoke all on function public.wis_patch_profile(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.wis_merge_premium_pending(text, jsonb) from public, anon, authenticated;
revoke all on function public.wis_clear_premium_pending(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.wis_apply_premium(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.wis_claim_premium_pending(uuid) from public, anon, authenticated;
revoke all on function public.wis_handle_new_user() from public, anon, authenticated;
revoke all on function public.wis_on_auth_user_confirmed() from public, anon, authenticated;

grant execute on function public.wis_apply_premium(uuid, text, jsonb) to service_role;
