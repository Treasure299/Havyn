create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  username text unique check (username is null or username ~ '^[a-z0-9_]{3,24}$'),
  avatar_url text,
  last_active_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id text primary key,
  name text not null,
  host_user_id uuid not null references public.profiles(id) on delete cascade,
  playback_mode text not null default 'host-only' check (playback_mode in ('host-only', 'host-and-cohosts', 'everyone')),
  visibility text not null default 'private' check (visibility in ('private', 'public')),
  is_public boolean generated always as (visibility = 'public') stored,
  active_media_url text,
  active_media_title text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists username text unique check (username is null or username ~ '^[a-z0-9_]{3,24}$'),
  add column if not exists last_active_at timestamptz not null default now();

alter table public.rooms
  add column if not exists visibility text not null default 'private' check (visibility in ('private', 'public')),
  add column if not exists is_public boolean generated always as (visibility = 'public') stored,
  add column if not exists last_seen_at timestamptz not null default now();

create table if not exists public.room_members (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'viewer' check (role in ('host', 'cohost', 'viewer')),
  joined_at timestamptz not null default now(),
  unique(room_id, user_id)
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.rooms(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  display_name text not null,
  message text not null,
  created_at timestamptz not null default now()
);

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

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_user_id uuid not null references public.profiles(id) on delete cascade,
  addressee_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  unique(requester_user_id, addressee_user_id),
  check (requester_user_id <> addressee_user_id)
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(user_id, friend_user_id),
  check (user_id <> friend_user_id)
);

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.user_presence enable row level security;
alter table public.watch_partners enable row level security;
alter table public.room_invites enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;

create policy "profiles are readable by authenticated users"
  on public.profiles for select
  to authenticated
  using (true);

create policy "users can upsert their own profile"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

create policy "users can update their own profile"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id);

create policy "authenticated users can create rooms"
  on public.rooms for insert
  to authenticated
  with check (auth.uid() = host_user_id);

create policy "room members can read rooms"
  on public.rooms for select
  to authenticated
  using (
    visibility = 'public'
    or
    host_user_id = auth.uid()
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

create policy "hosts can update rooms"
  on public.rooms for update
  to authenticated
  using (host_user_id = auth.uid());

create policy "authenticated users can join rooms"
  on public.room_members for insert
  to authenticated
  with check (auth.uid() = user_id);

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

create policy "room members can insert chat"
  on public.chat_messages for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "room members can read chat"
  on public.chat_messages for select
  to authenticated
  using (
    exists (
      select 1 from public.room_members
      where room_members.room_id = chat_messages.room_id
      and room_members.user_id = auth.uid()
    )
  );

create policy "presence is readable by authenticated users"
  on public.user_presence for select
  to authenticated
  using (true);

create policy "users can upsert own presence"
  on public.user_presence for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users can update own presence"
  on public.user_presence for update
  to authenticated
  using (auth.uid() = user_id);

create policy "users can read own watch partners"
  on public.watch_partners for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can create own watch partners"
  on public.watch_partners for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "users can update own watch partners"
  on public.watch_partners for update
  to authenticated
  using (auth.uid() = user_id);

create policy "invite participants can read invites"
  on public.room_invites for select
  to authenticated
  using (auth.uid() = invitee_user_id or auth.uid() = inviter_user_id);

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

create policy "invitees can update invite status"
  on public.room_invites for update
  to authenticated
  using (auth.uid() = invitee_user_id or auth.uid() = inviter_user_id)
  with check (auth.uid() = invitee_user_id or auth.uid() = inviter_user_id);

create policy "friend request participants can read"
  on public.friend_requests for select
  to authenticated
  using (auth.uid() = requester_user_id or auth.uid() = addressee_user_id);

create policy "users can send friend requests"
  on public.friend_requests for insert
  to authenticated
  with check (auth.uid() = requester_user_id);

create policy "friend request participants can update"
  on public.friend_requests for update
  to authenticated
  using (auth.uid() = requester_user_id or auth.uid() = addressee_user_id)
  with check (auth.uid() = requester_user_id or auth.uid() = addressee_user_id);

create policy "users can read own friendships"
  on public.friendships for select
  to authenticated
  using (auth.uid() = user_id);

create policy "users can create own friendships"
  on public.friendships for insert
  to authenticated
  with check (auth.uid() = user_id or auth.uid() = friend_user_id);

do $$
begin
  begin
    alter publication supabase_realtime add table public.room_invites;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.friend_requests;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.friendships;
  exception when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.user_presence;
  exception when duplicate_object then null;
  end;
end $$;
