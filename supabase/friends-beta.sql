-- Havyn Friends Beta migration for existing Social Beta projects.

alter table public.profiles
  add column if not exists username text unique check (username is null or username ~ '^[a-z0-9_]{3,24}$');

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

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;

drop policy if exists "friend request participants can read" on public.friend_requests;
create policy "friend request participants can read"
  on public.friend_requests for select
  to authenticated
  using (auth.uid() = requester_user_id or auth.uid() = addressee_user_id);

drop policy if exists "users can send friend requests" on public.friend_requests;
create policy "users can send friend requests"
  on public.friend_requests for insert
  to authenticated
  with check (auth.uid() = requester_user_id);

drop policy if exists "friend request participants can update" on public.friend_requests;
create policy "friend request participants can update"
  on public.friend_requests for update
  to authenticated
  using (auth.uid() = requester_user_id or auth.uid() = addressee_user_id)
  with check (auth.uid() = requester_user_id or auth.uid() = addressee_user_id);

drop policy if exists "users can read own friendships" on public.friendships;
create policy "users can read own friendships"
  on public.friendships for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "users can create own friendships" on public.friendships;
create policy "users can create own friendships"
  on public.friendships for insert
  to authenticated
  with check (auth.uid() = user_id or auth.uid() = friend_user_id);
