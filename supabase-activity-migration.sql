-- Run this once in Supabase SQL Editor to enable GPX/FIT activity uploads.
create table if not exists public.activities (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  file_name text not null,
  file_type text not null check (file_type in ('gpx', 'fit', 'manual')),
  distance_km numeric(10, 2) not null check (distance_km > 0 and distance_km <= 1000),
  started_at timestamptz not null check (started_at >= '2026-09-09 00:00:00+10'),
  uploaded_at timestamptz not null default now()
);

alter table public.activities
  add column if not exists started_at timestamptz;

alter table public.activities
  drop constraint if exists activities_file_type_check;

alter table public.activities
  add constraint activities_file_type_check
  check (file_type in ('gpx', 'fit', 'manual'));

alter table public.activities
  drop constraint if exists activities_started_at_check;

alter table public.activities
  add constraint activities_started_at_check
  check (started_at is not null and started_at >= '2026-09-09 00:00:00+10');

alter table public.activities enable row level security;

create policy "Users can view their own activities"
  on public.activities for select using (auth.uid() = user_id);

drop function if exists public.add_activity_distance(text, text, numeric);
drop function if exists public.add_activity_distance(text, text, numeric, timestamptz);

create or replace function public.add_activity_distance(
  p_file_name text,
  p_file_type text,
  p_distance_km numeric,
  p_started_at timestamptz
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
  if p_distance_km <= 0 or p_distance_km > 1000 then
    raise exception 'Activity distance must be between 0 and 1000 km';
  end if;
  if p_started_at is null or p_started_at < '2026-09-09 00:00:00+10' then
    raise exception 'Activities before 9 September 2026 are not accepted';
  end if;
  if p_file_type not in ('gpx', 'fit', 'manual') then
    raise exception 'Only GPX, FIT and manual runs are supported';
  end if;

  insert into public.activities (user_id, file_name, file_type, distance_km, started_at)
  values (auth.uid(), left(p_file_name, 255), p_file_type, round(p_distance_km, 2), p_started_at)
  returning * into new_activity;

  insert into public.race_entries (user_id, race_name, distance_km)
  values (auth.uid(), 'Race around Australia', new_activity.distance_km)
  on conflict (user_id, race_name)
  do update set distance_km = public.race_entries.distance_km + excluded.distance_km;

  return new_activity;
end;
$$;

revoke all on function public.add_activity_distance(text, text, numeric, timestamptz) from public;
grant execute on function public.add_activity_distance(text, text, numeric, timestamptz) to authenticated;
