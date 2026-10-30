-- ---------------------------------------------------------------------------
-- Cleanup abandoned Lenco pending payments (status hygiene only)
-- ---------------------------------------------------------------------------
-- 17 rows sat on `pending` in pending_payments. Two of them were actually paid
-- and applied (their lenco_reference already exists in `payments`) but the
-- client-side recovery path never flipped them to `completed`. The rest are
-- abandoned checkouts that will never be completed. Neither case moves money;
-- this just stops the permanent re-verification loop and keeps the table honest.
-- ---------------------------------------------------------------------------

-- Rows that were actually paid + applied: mark completed.
update public.pending_payments pp
   set status = 'completed',
       verified_at = coalesce(pp.verified_at, now())
 where pp.status = 'pending'
   and exists (select 1 from public.payments p where p.lenco_reference = pp.lenco_reference);

-- Abandoned checkouts older than 7 days that never reached `payments`: mark failed.
update public.pending_payments pp
   set status = 'failed',
       verified_at = coalesce(pp.verified_at, now())
 where pp.status = 'pending'
   and pp.created_at < now() - interval '7 days'
   and not exists (select 1 from public.payments p where p.lenco_reference = pp.lenco_reference);

insert into supabase_migrations.schema_migrations (version, name)
values ('20261031000002', 'cleanup_pending_payments')
on conflict (version) do nothing;