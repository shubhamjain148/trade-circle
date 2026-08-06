-- Web Push subscriptions: one row per browser, not per member.
--
-- A subscription is minted by the browser's push service and belongs to that
-- installation — phone and laptop are two rows for the same person, exactly as
-- device_links already assumes two devices are normal. Deleting one never
-- touches the other.
--
-- The primary key is a hash of the endpoint rather than the endpoint itself:
-- the endpoint is a capability URL (anyone holding it can push to that device),
-- it is long enough to be an awkward key, and re-subscribing on the same
-- browser returns the same endpoint, which is what makes the upsert work.
-- subscription_json holds the whole PushSubscription — endpoint, p256dh and
-- auth — because sending needs all three.
--
-- failed_count is the pruning rule and nothing else: a push service that
-- answers 404/410 has told us the subscription is dead and the row goes
-- immediately; anything else might be a bad evening, so it takes five.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash     TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL REFERENCES members(id),
  subscription_json TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_ok_at        TEXT,
  failed_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS push_subscriptions_member ON push_subscriptions(member_id);
