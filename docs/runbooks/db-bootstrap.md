# DB role bootstrap — run as superuser BEFORE migrate, per env

**Audience:** SRE / deploy owner. **Severity if skipped:** prod sign-in is broken
on every fresh DB / redeploy / DBLab preview clone — magic-link callback 500s and
tenant routes throw `42501`. This has already broken prod **twice** (#186 / #180).

**SPEC provenance:** §5.10 (one multi-tenant Postgres with RLS). The runtime app
connects as a NON-superuser LOGIN role so RLS actually applies to it.

## The rule (deployment invariant)

For **every environment** (prod, `samograph-main`, each branch preview) and **every
fresh database** (including each DBLab thin-clone/branch), the deploy MUST run the
superuser bootstrap **once, BEFORE** the normal migrate step:

```bash
# 1. As a SUPERUSER (env-specific login role name; prod uses `samo`):
psql -v app_login_role=samo -f packages/shared/db/bootstrap.sql "$SUPERUSER_DATABASE_URL"
#    …or programmatically:
SUPERUSER_DATABASE_URL=… bun packages/shared/db/bootstrap.ts samo

# 2. THEN migrate, as the app login role (non-superuser):
DATABASE_URL=… bun packages/shared/db/migrate.ts
```

`bootstrap.sql` is **idempotent** — re-running it on every deploy is safe and
expected.

## Why — the two grants, and why they can't live in `migrate.ts`

`migrate.ts` connects as the **non-superuser app login role**, which cannot
`ALTER ROLE … BYPASSRLS` or self-grant membership — so this wiring **cannot** go
in the migration path. And the login-role NAME is env-specific (`samo` in prod,
the `samograph` superuser in CI), so it is parameterized, not hard-coded.

`bootstrap.sql` wires exactly what the runtime path needs:

| Statement | Why it's needed |
|---|---|
| `CREATE ROLE samograph_app NOLOGIN` (guarded) | The runtime role every RLS policy is written `TO` (§5.10). |
| `ALTER ROLE samograph_app NOBYPASSRLS` | Pins the isolation invariant — the runtime role must never bypass RLS. |
| `GRANT samograph_app TO <login>` | So tenant routes' `SET LOCAL ROLE samograph_app` (`apps/app-api/calls/http.ts`, 7 sites) don't throw `42501 permission denied to set role`. |
| `ALTER ROLE <login> WITH BYPASSRLS` | So the **pre-tenant** magic-link auth `INSERT INTO tenants` (`PostgresUserStore`) passes FORCE RLS **before** any `app.tenant_id` is set. |

Migration `0001` only does `CREATE ROLE samograph_app NOLOGIN` + table grants — it
**never wires the LOGIN role** — which is exactly why prod came up missing this.

## Why CI stayed green while prod broke — the blind spot

Dev/CI connect to Postgres **as the container SUPERUSER** (`POSTGRES_USER=samograph`
in `scripts/dev-local.sh` and `.github/workflows/ci.yml`; `rls.test.ts` seeds as
that superuser). A superuser can `SET ROLE` with **no** grant and **bypasses RLS**,
so the prod prerequisite — a non-superuser login role that MUST be explicitly wired
— was never exercised. That is the whole point of
[`packages/shared/db/bootstrap.db.test.ts`](../../packages/shared/db/bootstrap.db.test.ts):
it creates a **fresh non-superuser login role** on the same superuser runner and
asserts the flow is denied (`42501`) WITHOUT bootstrap and works WITH it, so a
regression fails CI red.

## Follow-up — NOT done here (owner: Nik)

> Wiring `bootstrap.sql` into the samohost / GitHub-Actions deploy automation so it
> runs (as superuser, per env) ahead of `migrate` on every tier — branch preview,
> `samograph-main`, and the tag→prod deploy — is a separate deploy-automation PR.
> This PR ships the repo-tracked, tested bootstrap + this runbook; the CI/CP wiring
> is the follow-up.

## See also

- [`packages/shared/db/bootstrap.sql`](../../packages/shared/db/bootstrap.sql) / [`bootstrap.ts`](../../packages/shared/db/bootstrap.ts) — the script + programmatic runner.
- [README index](./README.md) — full runbook set.
