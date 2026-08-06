-- Device links: a member minting a way to sign *themselves* in on a second
-- device. Deliberately its own table rather than a flag on invite_tokens —
-- invites are handed to someone else and never expire, these are read off a
-- screen and die in fifteen minutes, and the admin roster must not start
-- reporting "invite pending" every time someone opens the app on their phone.
--
-- Only the hash is stored, exactly as with invites: the DB cannot mint a login.
CREATE TABLE IF NOT EXISTS device_links (
  token_hash TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS device_links_member ON device_links(member_id);
