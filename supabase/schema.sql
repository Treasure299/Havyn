create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id text primary key,
  name text not null,
  host_user_id uuid not null references public.profiles(id) on delete cascade,
  playback_mode text not null default 'host-only' check (playback_mode in ('host-only', 'host-and-cohosts', 'everyone')),
  active_media_url text,
  active_media_title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.chat_messages enable row level security;

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
    host_user_id = auth.uid()
    or exists (
      select 1 from public.room_members
      where room_members.room_id = rooms.id
      and room_members.user_id = auth.uid()
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
