-- Run this in the Supabase SQL Editor after supabase-activity-migration.sql.
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 120),
  route_file text not null,
  start_date date not null,
  start_location text not null,
  finish_location text not null,
  created_at timestamptz not null default now()
);

alter table public.challenges enable row level security;

drop policy if exists "Challenges are publicly readable" on public.challenges;
create policy "Challenges are publicly readable"
  on public.challenges for select using (true);

create table if not exists public.challenge_entries (
  id bigint generated always as identity primary key,
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  distance_km numeric(10,2) not null default 0 check (distance_km >= 0),
  joined_at timestamptz not null default now(),
  unique (challenge_id, user_id)
);

alter table public.challenge_entries enable row level security;

drop policy if exists "Challenge entries are publicly readable" on public.challenge_entries;
create policy "Challenge entries are publicly readable"
  on public.challenge_entries for select using (true);
drop policy if exists "Users can create their own challenge entry" on public.challenge_entries;
create policy "Users can create their own challenge entry"
  on public.challenge_entries for insert with check (auth.uid() = user_id);
drop policy if exists "Users can update their own challenge entry" on public.challenge_entries;
create policy "Users can update their own challenge entry"
  on public.challenge_entries for update using (auth.uid() = user_id);

alter table public.activities
  add column if not exists challenge_id uuid references public.challenges(id) on delete cascade;

alter table public.activities
  drop constraint if exists activities_challenge_id_not_null;

insert into public.challenges (name, route_file, start_date, start_location, finish_location)
values (
  'Race around Australia',
  'route3.kml',
  '2026-09-09',
  'Mirboo North',
  'South Point'
)
on conflict (name) do update set
  route_file = excluded.route_file,
  start_date = excluded.start_date,
  start_location = excluded.start_location,
  finish_location = excluded.finish_location;

insert into public.challenge_entries (challenge_id, user_id, distance_km)
select c.id, r.user_id, r.distance_km
from public.challenges c
join public.race_entries r on r.race_name = c.name
where c.name = 'Race around Australia'
on conflict (challenge_id, user_id) do update
  set distance_km = excluded.distance_km;

update public.activities a
set challenge_id = c.id
from public.challenges c
where c.name = 'Race around Australia'
  and a.challenge_id is null;

drop function if exists public.add_activity_distance(text, text, numeric, timestamptz);
drop function if exists public.add_activity_distance(text, text, numeric, timestamptz, uuid);

create or replace function public.add_activity_distance(
  p_file_name text,
  p_file_type text,
  p_distance_km numeric,
  p_started_at timestamptz,
  p_challenge_id uuid
)
returns public.activities
language plpgsql
security definer
set search_path = public
as $$
declare
  new_activity public.activities;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to upload an activity';
  end if;
  if not exists (
    select 1 from public.challenges where id = p_challenge_id
  ) then
    raise exception 'The selected challenge does not exist';
  end if;
  if not exists (
    select 1 from public.challenge_entries
    where challenge_id = p_challenge_id and user_id = auth.uid()
  ) then
    raise exception 'Join the selected challenge before adding a run';
  end if;
  if p_distance_km <= 0 or p_distance_km > 1000 then
    raise exception 'Activity distance must be between 0 and 1000 km';
  end if;
  if p_started_at is null or p_started_at < '2026-09-09 00:00:00+10' then
    raise exception 'Activities before 9 September 2026 are not accepted';
  end if;
  if p_file_type not in ('gpx', 'fit', 'manual') then
    raise exception 'Only GPX, FIT and manual runs are supported';
  end if;

  insert into public.activities (user_id, challenge_id, file_name, file_type, distance_km, started_at)
  values (auth.uid(), p_challenge_id, left(p_file_name, 255), p_file_type, round(p_distance_km, 2), p_started_at)
  returning * into new_activity;

  update public.challenge_entries
  set distance_km = distance_km + new_activity.distance_km
  where challenge_id = p_challenge_id and user_id = auth.uid();

  return new_activity;
end;
$$;

revoke all on function public.add_activity_distance(text, text, numeric, timestamptz, uuid) from public;
grant execute on function public.add_activity_distance(text, text, numeric, timestamptz, uuid) to authenticated;
