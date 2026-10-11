-- 0012_users_signup_method — how each account was CREATED (SPEC §5.11 / §9;
-- SPEC amendment S5-1 item 7; issues #209 / #222).
--
-- WHY THIS COLUMN EXISTS. The §5.11 activation funnel is CUMULATIVE: a user is
-- counted at every stage up to the furthest one they reached. Before Google
-- sign-in, stage 2 was `magic_link_clicked`, derived from a consumed
-- `magic_links` row — a row a Google signup NEVER produces. So a Google user who
-- created a call had that stage back-filled anyway, IMPUTING a magic-link click
-- that never happened. Nothing 500'd and no test went red; THE v1 success metric
-- just reported a wrong number. Stage 2 is now `auth_completed`, and this column
-- is what lets `samograph_funnel_stage` and `samograph_activation_w1_by_method`
-- carry a `method` label — which is in turn what makes the §9 re-baselining rule
-- ("for the first full week after Google ships, the >= 0.5 target is judged
-- against method='magic_link'") expressible at all.
--
-- IT RECORDS CREATION, NOT THE LAST SIGN-IN. `PostgresUserStore.createOrLoadUser`
-- writes it on INSERT and its `ON CONFLICT ... DO UPDATE` deliberately OMITS it,
-- so a magic-link user who later signs in with Google keeps `magic_link` — the
-- same immutability `users.email` has (S5-1 item 3), for the same reason: a
-- later sign-in is not a re-signup, and a metric that silently reclassified
-- historical cohorts would make every week-over-week comparison a lie.
--
-- DEFAULT 'magic_link' IS THE DOCUMENTED BACKFILL. Every row that predates this
-- migration was created by the magic-link callback BY CONSTRUCTION — Google
-- sign-in has never been enabled on an environment with real users — so the
-- column default doubles as the backfill and no UPDATE is needed. NOT NULL, so
-- there is no third "unknown" state for a dashboard to have an opinion about.
--
-- WHY A CHECK AND NOT A PG ENUM: `ALTER TYPE ... ADD VALUE` cannot run inside a
-- transaction and migrate.ts wraps every migration file in one, so a future
-- 'github' value would break the runner. Same call 0008 (`transcripts.kind`) and
-- 0011 (`user_identities.provider`) made. The domain MIRRORS `SignupMethod` in
-- apps/app-api/auth/types.ts; `packages/shared/observe/funnel.ts` holds a third
-- copy for the metric label, kept honest by a compile-time check in
-- apps/app-api/auth/stores.test.ts.
--
-- `users` is a PRIVILEGED pre-tenant table (0001): not granted to samograph_app,
-- no RLS. Adding a column changes none of that.

ALTER TABLE users
  ADD COLUMN signup_method text NOT NULL DEFAULT 'magic_link'
    CHECK (signup_method IN ('magic_link', 'google'));

-- Deliberately NO index: the only reader is the /metrics funnel refresh, which
-- already does a full scan of a table this small, and every write is a
-- single-row upsert keyed on the UNIQUE email.
