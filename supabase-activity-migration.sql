-- Run this once in Supabase SQL Editor to enable GPX/FIT activity uploads.
create table if not exists public.activities (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  file_name text not null,
  file_type text not null check (file_type in ('gpx', 'fit')),
  distance_km numeric(10, 2) not null check (distance_km > 0 and distance_km <= 1000),
  uploaded_at timestamptz not null default now()
);

alter table public.activities enable row level security;

create policy "Users can view their own activities"
  on public.activities for select using (auth.uid() = user_id);

create or replace function public.add_activity_distance(
  p_file_name text,
  p_file_type text,
  p_distance_km numeric
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
  if p_file_type not in ('gpx', 'fit') then
    raise exception 'Only GPX and FIT files are supported';
  end if;

  insert into public.activities (user_id, file_name, file_type, distance_km)
  values (auth.uid(), left(p_file_name, 255), p_file_type, round(p_distance_km, 2))
  returning * into new_activity;

  insert into public.race_entries (user_id, race_name, distance_km)
  values (auth.uid(), 'Race around Australia', new_activity.distance_km)
  on conflict (user_id, race_name)
  do update set distance_km = public.race_entries.distance_km + excluded.distance_km;

  return new_activity;
end;
$$;

revoke all on function public.add_activity_distance(text, text, numeric) from public;
grant execute on function public.add_activity_distance(text, text, numeric) to authenticated;
