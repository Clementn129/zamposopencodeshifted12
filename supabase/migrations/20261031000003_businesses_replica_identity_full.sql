-- Set businesses replica identity to FULL so Realtime payloads include the old
-- row. This makes the `businesses` UPDATE handler in AppSyncManager able to
-- tell which fields actually changed (instead of refetching on every write,
-- including the frequent `last_sync_at` stamps from downstream pulls).
alter table public.businesses replica identity full;
">