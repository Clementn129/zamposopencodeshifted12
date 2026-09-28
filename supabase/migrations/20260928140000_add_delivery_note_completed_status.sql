-- New delivery-note state: the note was completed at creation time, meaning
-- stock has moved AND the goods were recorded as a sale.
--
-- This is deliberately its own migration file. PostgreSQL will not let you USE
-- a newly added enum value inside the same transaction that adds it
--   ERROR: unsafe use of new value "completed" of enum type delivery_note_status
-- so the value must commit before any function body compares against it.

ALTER TYPE public.delivery_note_status ADD VALUE IF NOT EXISTS 'completed';
