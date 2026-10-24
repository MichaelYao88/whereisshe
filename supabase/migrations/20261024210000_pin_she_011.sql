-- Pin she-011 (Angel, @angelyussof) to 2026-11-01. Rotation stays empty.
insert into public.community_pinned (day_key, puzzle_id) values
  (date '2026-11-01', 'she-011')
on conflict (day_key) do update set puzzle_id = excluded.puzzle_id;

-- Seed/refresh snapshots (covers today .. +14 days, so Nov 1 gets its seeded row now).
select public.refresh_community_snapshots();
