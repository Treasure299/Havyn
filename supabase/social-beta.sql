-- Havyn Social Beta migration for existing Supabase projects.
-- Run this once in the Supabase SQL editor if the base schema already exists.

alter table public.profiles
  add column if not exists last_active_at timestamptz not null default now();

alter table public.rooms
  add column if not exists visibility text not null default 'private' check (visibility in ('private', 'public')),
  add column if not exists is_public boolean generated always as (visibility = 'public') stored,
  add column if not exists last_seen_at timestamptz not null default now();

create table if not exists public.user_presence (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  online boolean not null default true,
  last_active_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.watch_partners (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  partner_user_id uuid not null references public.profiles(id) on delete cascade,
  last_room_id text references public.rooms(id) on delete set null,
  last_watched_at timestamptz not null default now(),
  unique(user_id, partner_user_id),
  check (user_id <> partner_user_id)
);

create table if not exists public.room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.rooms(id) on delete cascade,
  inviter_user_id uuid not null references public.profiles(id) on delete cascade,
  invitee_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique(room_id, inviter_user_id, invitee_user_id)
);

alter table public.user_presence enable row level security;
alter table public.watch_partners enable row level security;
alter table public.room_invites enable row level security;

drop policy if exists "room members can read rooms" on public.rooms;
create policy "room members can read rooms"
  on public.rooms for select
  to authenticated
  using (
    visibility = 'public'
    or host_user_id = auth.uid()
    or exists (
      select 1 from public.room_members
      where room_members.room_id = rooms.id
      and room_members.user_id = auth.uid()
    )
    or exists (
      select 1 from public.room_invites
      where room_invites.room_id = rooms.id
      and room_invites.invitee_user_id = auth.uid()
      and room_invites.status in ('pending', 'accepted')
    )
  );

drop policy if exists "room members can read members" on public.room_members;
create policy "room members can read members"
  on public.room_members for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.rooms
      where rooms.id = room_members.room_id
      and rooms.visibility = 'public'
    )
    or exists (
      select 1 from public.room_members member_check
      where member_check.room_id = room_members.room_id
      and member_check.user_id = auth.uid()
    )
  );

drop policy if exists "presence is readable by authenticated users" on public.user_presence;
create policy "presence is readable by authenticated users"
  on public.user_presence for select
  to authenticated
  using (true);

drop policy if exists "users can upsert own presence" on public.user_presence;
create policy "users can upsert own presence"
  on public.user_presence for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "users can update own presence" on public.user_presence;
create policy "users can update own presence"
  on public.user_presence for update
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users can read own watch partners" on public.watch_partners;
create policy "users can read own watch partners"
  on public.watch_partners for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users can create own watch partners" on public.watch_partners;
create policy "users can create own watch partners"
  on public.watch_partners for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "users can update own watch partners" on public.watch_partners;
create policy "users can update own watch partners"
  on public.watch_partners for update
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "invite participants can read invites" on public.room_invites;
create policy "invite participants can read invites"
  on public.room_invites for select
  to authenticated
  using (auth.uid() = invitee_user_id or auth.uid() = inviter_user_id);

drop policy if exists "room members can create invites" on public.room_invites;
drop policy if exists "room members and hosts can create invites" on public.room_invites;
create policy "room members and hosts can create invites"
  on public.room_invites for insert
  to authenticated
  with check (
    auth.uid() = inviter_user_id
    and (
      exists (
        select 1 from public.room_members
        where room_members.room_id = room_invites.room_id
        and room_members.user_id = auth.uid()
      )
      or exists (
        select 1 from public.rooms
        where rooms.id = room_invites.room_id
        and rooms.host_user_id = auth.uid()
      )
    )
  );

drop policy if exists "invitees can update invite status" on public.room_invites;
create policy "invitees can update invite status"
  on public.room_invites for update
  to authenticated
  using (auth.uid() = invitee_user_id or auth.uid() = inviter_user_id)
  with check (auth.uid() = invitee_user_id or auth.uid() = inviter_user_id);
