CREATE TABLE IF NOT EXISTS worldfront_state (
  id text PRIMARY KEY CHECK (id = 'worldfront'),
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE worldfront_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE worldfront_state FROM anon, authenticated;
