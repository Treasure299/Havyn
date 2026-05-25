drop policy if exists "room members can read members" on public.room_members;
drop policy if exists "authenticated users can read room members" on public.room_members;

create policy "authenticated users can read room members"
  on public.room_members for select
  to authenticated
  using (true);

drop policy if exists "room members can create invites" on public.room_invites;
drop policy if exists "room members and hosts can create invites" on public.room_invites;
drop policy if exists "room hosts can create invites" on public.room_invites;

create policy "room hosts can create invites"
  on public.room_invites for insert
  to authenticated
  with check (
    auth.uid() = inviter_user_id
    and exists (
      select 1 from public.rooms
      where rooms.id = room_invites.room_id
      and rooms.host_user_id = auth.uid()
    )
  );
