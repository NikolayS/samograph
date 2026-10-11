-- 0013: release the addresses still held by §5.14 tombstones written before #220.
--
-- §5.14 erasure is a TOMBSTONE erasure: the tenant's rows are purged, one
-- `audit_log(action='account_deleted')` row is written, and the `users`/`tenants`
-- rows are RETAINED so `tenantActive` can revoke every stateless session cookie.
-- Until #220 the retained `users` row kept the person's real address, which made
-- the erasure both incomplete (an email is directly-identifying personal data
-- retained forever on a row that exists only to say "this account is gone") and
-- REVERSIBLE: `users.email` is UNIQUE and every sign-in path resolves by address,
-- so the next Google callback's `findByEmail` HIT re-linked a fresh
-- `user_identities` row to the erased account — re-creating the provider `sub`
-- that the erasure had just deleted — and emailed the erased address about it.
--
-- `DELETE /account` now releases the address as part of the erasure. This
-- backfills the accounts erased BEFORE that shipped, so no live tombstone is left
-- in the resurrectable state.
--
-- SAFETY. This statement REWRITES `users.email`; a predicate that over-matched by
-- one row would lock a live user out of their own account permanently. It is
-- therefore keyed on exactly the predicate `tenantActive` uses — the presence of
-- an `account_deleted` tombstone on the tenant this user OWNS — and on nothing
-- else. `apps/app-api/account/release-erased-emails.db.test.ts` runs THIS FILE
-- verbatim and asserts an active owner's address is byte-identical afterwards.
--
-- The replacement is deterministic in the user id (so re-running is a no-op, not
-- a UNIQUE violation) and uses the RFC 2606 reserved `.invalid` TLD, so it can
-- never be routed and can never collide with an address a person could own. It is
-- the same string `erasedAccountEmail()` builds in `apps/app-api/account/http.ts`;
-- both sides are pinned to that helper by their tests.
--
-- Runs on the migration connection, which has BYPASSRLS (docs/runbooks/db-bootstrap.md)
-- — `tenants` and `audit_log` are FORCE RLS with policies granted only to
-- `samograph_app`, so a connection without it would simply match nothing.
UPDATE users u
SET email = 'deleted-' || u.id::text || '@deleted.invalid'
WHERE EXISTS (
        SELECT 1
        FROM tenants t
        JOIN audit_log a ON a.tenant_id = t.id AND a.action = 'account_deleted'
        WHERE t.owner_user_id = u.id
      )
  AND u.email <> 'deleted-' || u.id::text || '@deleted.invalid';
