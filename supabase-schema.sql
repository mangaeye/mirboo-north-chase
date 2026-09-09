-- Run this in Supabase SQL Editor after creating your project.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.race_entries (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  race_name text not null default 'Race around Australia',
  distance_km numeric(10,2) not null default 0 check (distance_km >= 0),
  joined_at timestamptz not null default now(),
  unique (user_id, race_name)
);

alter table public.profiles enable row level security;
alter table public.race_entries enable row level security;

create policy "Profiles are publicly readable"
  on public.profiles for select using (true);
create policy "Users can create their own profile"
  on public.profiles for insert with check (auth.uid() = id);
create policy "Users can update their own profile"
  on public.profiles for update using (auth.uid() = id);
create policy "Race entries are publicly readable"
  on public.race_entries for select using (true);
create policy "Users can join for themselves"
  on public.race_entries for insert with check (auth.uid() = user_id);
create policy "Users can update their own entry"
  on public.race_entries for update using (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
