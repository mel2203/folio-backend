CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS trigger AS $$
DECLARE
  d NUMERIC; c NUMERIC; eid UUID;
BEGIN
  eid := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
    INTO d, c FROM journal_lines WHERE entry_id = eid;
  IF d <> c THEN
    RAISE EXCEPTION 'Journal entry % is not balanced (debit %, credit %)', eid, d, c;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_balanced
AFTER INSERT OR UPDATE OR DELETE ON journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();
