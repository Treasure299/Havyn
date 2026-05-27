alter table public.rooms
  add column if not exists active_media_state jsonb;

comment on column public.rooms.active_media_state is
  'Latest Havyn playback snapshot used to recover watch sync after reconnects or server restarts.';
