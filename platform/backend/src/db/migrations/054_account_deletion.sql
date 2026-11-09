-- 054: genuine self-service account deletion (owner decision OD-6).
--
-- Two things stopped an account from being deleted:
--
-- 1. memberships.user_id was ON DELETE RESTRICT, so anyone who had ever pressed
--    "Join" could not leave. A membership with ledger rows must outlive its
--    member (the ledger is append-only and references it), but not the
--    member's identity: the column becomes nullable and SET NULL, and the
--    delete transaction first writes an opaque `former_member_ref` so the
--    administrator's cohort view can still say "former member <ref>". A
--    membership row may never be anonymous without that reference.
--
-- 2. admin_audit.actor and ledger_entries.recorded_by were declared ON DELETE
--    SET NULL, but Postgres implements that as an UPDATE of the child row, and
--    the append-only trigger refused every UPDATE, so deleting any account
--    those columns named failed (with 23001, not even the 23503 the route
--    mapped). The UPDATE half of each trigger is replaced by a guard that allows
--    exactly one change: that column becoming NULL with every other column
--    unchanged. DELETE and TRUNCATE still raise; every economic column stays
--    immutable.
--
-- Added without IF NOT EXISTS on purpose, as 052 explains.

ALTER TABLE memberships ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE memberships DROP CONSTRAINT memberships_user_id_fkey;
ALTER TABLE memberships ADD CONSTRAINT memberships_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;
-- Opaque, random, set by the delete transaction; never derived from the account.
ALTER TABLE memberships ADD COLUMN former_member_ref text;
ALTER TABLE memberships ADD CONSTRAINT memberships_former_member_ck
  CHECK (user_id IS NOT NULL OR former_member_ref IS NOT NULL);

-- ledger_entries: only recorded_by -> NULL, nothing else.
CREATE FUNCTION ledger_entries_scrub_recorder_only() RETURNS trigger AS $$
BEGIN
  IF OLD.recorded_by IS NOT NULL AND NEW.recorded_by IS NULL
     AND (to_jsonb(NEW) - 'recorded_by') = (to_jsonb(OLD) - 'recorded_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only: % on % is not permitted; record a correcting entry instead',
    TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- admin_audit: only actor -> NULL, nothing else.
CREATE FUNCTION admin_audit_scrub_actor_only() RETURNS trigger AS $$
BEGIN
  IF OLD.actor IS NOT NULL AND NEW.actor IS NULL
     AND (to_jsonb(NEW) - 'actor') = (to_jsonb(OLD) - 'actor') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only: % on % is not permitted; record a correcting entry instead',
    TG_OP, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION package_ledger_append_only();
CREATE TRIGGER ledger_entries_update_guard BEFORE UPDATE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_scrub_recorder_only();

DROP TRIGGER admin_audit_append_only ON admin_audit;
CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION package_ledger_append_only();
CREATE TRIGGER admin_audit_update_guard BEFORE UPDATE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION admin_audit_scrub_actor_only();
