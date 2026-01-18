-- Adds a manual Pro override flag for specific users.
-- Safe: constant default avoids table rewrite on modern Postgres.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pro_override boolean NOT NULL DEFAULT false;

