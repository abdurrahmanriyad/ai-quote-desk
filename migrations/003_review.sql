ALTER TABLE quote_cases DROP CONSTRAINT quote_cases_status_check;
ALTER TABLE quote_cases ADD CONSTRAINT quote_cases_status_check
  CHECK (status IN ('received', 'processing', 'needs_review', 'approved', 'failed'));

-- What a person signed off. Later changes to prices or catalogs can't alter it.
CREATE TABLE approved_quotes (
  case_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  quote_number bigint GENERATED ALWAYS AS IDENTITY,
  lines jsonb NOT NULL,
  price jsonb NOT NULL,
  customer jsonb NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, tenant_id) REFERENCES quote_cases (id, tenant_id)
);

CREATE FUNCTION reject_approved_quote_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approved_quotes cannot be changed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approved_quotes_immutable
  BEFORE UPDATE OR DELETE ON approved_quotes
  FOR EACH ROW EXECUTE FUNCTION reject_approved_quote_change();
