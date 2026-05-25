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
