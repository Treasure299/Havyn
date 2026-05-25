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
