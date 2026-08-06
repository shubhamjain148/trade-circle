-- Reactions on anything in the timeline — a line someone typed, or a move the
-- watcher posted. A 🚀 on "Rahul opened NVDA" is the point of the feature, so
-- the target is polymorphic: (item_kind, item_id) rather than a message_id.
--
-- That polymorphism is why there is no REFERENCES on item_id. SQLite cannot
-- point one column at two tables, and a trigger that faked it would be a
-- constraint the D1 path and the Node path could disagree about. Instead the
-- API validates the kind and the summary read simply finds nothing for an id
-- that no longer exists — a reaction on a deleted row renders as nothing, which
-- is the same thing the reader would see if we had cascaded.
--
-- The primary key is the whole tuple: one member, one emoji, one item, once.
-- That is what makes PUT idempotent without a read-modify-write, and it is also
-- the rule "tap again to remove" depends on — the DELETE names the same tuple.
-- Different emoji from the same member on the same item are different rows, on
-- purpose: 🚀 and 💀 on the same trade is a joke this group will make.
CREATE TABLE IF NOT EXISTS reactions (
  item_kind  TEXT NOT NULL CHECK (item_kind IN ('message','event')),
  item_id    TEXT NOT NULL,
  member_id  TEXT NOT NULL REFERENCES members(id),
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_kind, item_id, member_id, emoji)
);
CREATE INDEX IF NOT EXISTS reactions_item ON reactions(item_kind, item_id);
CREATE INDEX IF NOT EXISTS reactions_member ON reactions(member_id);

-- How a cursor-based poll ever learns that someone reacted to a *week-old* row.
--
-- The chat cursor advances past everything it has seen, so an old message is
-- never in a poll's page again — but its reaction pills still have to change on
-- every other phone in the group. This table is the delta the poll reads: one
-- row per item that has ever been reacted to, stamped every time its reactions
-- change in either direction.
--
-- Deliberately a touch log and not a change log. A row here says "this item's
-- reactions are not what you last saw", and the response then carries the
-- item's *whole* current summary rather than a diff. That is what lets a
-- removal propagate at all: deleting from `reactions` leaves nothing behind to
-- replay, but it does bump touched_at, and the recomputed summary is simply
-- shorter (or empty). Idempotent by construction — a summary applied twice is
-- the same summary — which is why the poll bound below can afford to be
-- inclusive, exactly like listMessages/listFeedEvents already are.
CREATE TABLE IF NOT EXISTS reaction_activity (
  item_kind  TEXT NOT NULL CHECK (item_kind IN ('message','event')),
  item_id    TEXT NOT NULL,
  touched_at TEXT NOT NULL,
  PRIMARY KEY (item_kind, item_id)
);
CREATE INDEX IF NOT EXISTS reaction_activity_time ON reaction_activity(touched_at DESC);
