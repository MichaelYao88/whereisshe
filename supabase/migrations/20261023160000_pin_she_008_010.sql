-- Pin she-007…she-010 and stop the community rotation so it matches schedule.json.
-- An empty rotation means a day with no pin plays nothing, instead of looping she-001.

insert into public.community_pinned (day_key, puzzle_id) values
  (date '2026-10-28', 'she-007'),
  (date '2026-10-29', 'she-008'),
  (date '2026-10-30', 'she-009'),
  (date '2026-10-31', 'she-010')
on conflict (day_key) do update set puzzle_id = excluded.puzzle_id;

delete from public.community_rotation;

-- Pinned dates win. With no rotation row, any other day returns null.
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

-- Drop seeded snapshots for days that the old rotation had already filled in,
-- then rebuild from the pins. Oct 28 is still in the future relative to this migration's authoring date.
delete from public.community_snapshots
where day_key >= date '2026-10-28';

select public.refresh_community_snapshots();
