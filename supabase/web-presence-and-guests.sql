-- Havyn Web presence activity. Run after social-beta.sql in the Supabase SQL editor.
alter table public.user_presence
  add column if not exists activity_state text not null default 'online'
    check (activity_state in ('online', 'idle', 'watching')),
  add column if not exists active_room_id text references public.rooms(id) on delete set null,
  add column if not exists active_title text,
  add column if not exists activity_updated_at timestamptz not null default now();

-- Presence is social metadata, not a public activity feed.
drop policy if exists "presence is readable by authenticated users" on public.user_presence;
create policy "friends can read presence"
  on public.user_presence for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.friendships
      where friendships.user_id = auth.uid()
        and friendships.friend_user_id = user_presence.user_id
    )
  );
