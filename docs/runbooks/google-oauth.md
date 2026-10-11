# Google sign-in (OIDC) — Cloud Console setup, env vars, and the samohost trap

**Audience:** the project owner (Google Cloud Console steps) + the SRE / deploy
owner (env wiring). **Severity if done wrong:** either Google sign-in is simply
absent (safe — the magic-link path is untouched), or — the one dangerous failure
mode — the button *renders* and every sign-in dies at Google's token endpoint. See
[the `.samohost.toml` trap](#the-samohosttoml-trap--never-put-the-secret-in-secrets).

**SPEC provenance:** amendment **S5-1** in
[`SPEC.amendments.md`](../../blueprints/samograph-dev/SPEC.amendments.md) —
Google sign-in deliberately reverses the §1 v1 non-goal "no Google OAuth"
(post-v1, with owner sign-off). Issue **#209**. Calendar access is a separate,
incremental grant under amendment S5-3; ordinary sign-in remains `openid email`.

> **Nothing here is required for the app to run.** With no Google credentials set,
> `bun test` and `bunx tsc --noEmit` are green, the app boots, `GET /auth/providers`
> returns `{"google": false}`, and the button does not render. Magic link is the
> baseline credential on every environment and stays enabled everywhere Google is
> enabled — **Google is never the only way into an account.**

## ⛔ READ FIRST — the redirect URI path is `/auth/google/callback`

> **The path is `/auth/google/callback`. It is NOT `/auth/callback`.**
>
> `/auth/callback` is the **magic-link** callback — a different route, on a
> different credential path. Registering it as the Google redirect URI produces
> `Error 400: redirect_uri_mismatch` on every single sign-in, with nothing in our
> logs. **This has already been hit once on real, freshly-created clients — both
> were registered against `/auth/callback`.** If you created the clients before
> reading this, go back and check the URIs character by character before doing
> anything else.

Google **exact-matches** `redirect_uri` — scheme, host, port and path must be
byte-identical — and allows **no wildcards**. Paste these strings; do not retype
them, and do not add a trailing slash:

| Environment / host | Exact redirect URI to register |
|---|---|
| `samograph.dev` | `https://samograph.dev/auth/google/callback` |
| `samograph.samo.team` | `https://samograph.samo.team/auth/google/callback` |
| `samograph-main` preview | `https://samograph-main.samo.cat/auth/google/callback` |
| local dev | `http://localhost:3000/auth/google/callback` |

Register a second URI for Calendar on every enabled host by replacing the path
above with `/calendar/connect/callback` (for example,
`https://samograph.dev/calendar/connect/callback` and
`http://localhost:3000/calendar/connect/callback`). Both paths must be registered
on the same OAuth client. Calendar requests only
`https://www.googleapis.com/auth/calendar.events.readonly` and requires Google
sensitive-scope verification before production launch.

Those four origins are exactly the compiled-in allowlist
`GOOGLE_REGISTERED_REDIRECT_ORIGINS` in
[`apps/app-api/auth/google-oauth.ts`](../../apps/app-api/auth/google-oauth.ts) —
an environment whose derived origin is not one of them **refuses to boot**
naming `GOOGLE_OAUTH_REDIRECT_URI`, rather than failing at every user's click.
The list is pinned by an exact-array test, so adding a host is a reviewed code
change, never a silent one.

**Register the URI on the client whose credentials that environment holds.** Which
host is production and which is staging is the owner's call and is *not* settled
here — `samograph.dev` and `samograph.samo.team` are both accepted, and each must
be registered on whichever client serves it. A client may carry more than one
redirect URI; what it must never do is carry a URI for a host it does not serve.

## Why there are TWO OAuth clients

| Client | Registered redirect URIs | Given to |
|---|---|---|
| `samograph-prod` | `https://samograph.dev/auth/google/callback` and/or `https://samograph.samo.team/auth/google/callback` — whichever host(s) that credential's environment actually serves | that environment only |
| `samograph-nonprod` | `https://samograph-main.samo.cat/auth/google/callback`, `http://localhost:3000/auth/google/callback` | the `samograph-main` preview + local dev machines |

Four registrable URIs, two clients.

Two clients rather than one is deliberate: a preview `.env` on a shared VM is a
lower-trust store than prod's, and the ID-token verifier **pins `aud` to the
configured client id**, so a leaked *preview* credential cannot mint a token prod
will accept. One credential spanning both would erase that boundary.

**Branch previews (`samograph-<branch>.samo.cat`) get NO Google credentials, by
design.** Their hostnames are unbounded and dynamic, and an unbounded set of
hostnames must never be registrable redirect targets. `GET /auth/providers`
returns `{"google": false}` there, the button does not render, and
`/auth/google/*` answers with a credential-free stub that redirects to
`/auth?error=SAMO-AUTH-010`. Previews sign in with magic link — the same
credential they already have.

## Part 1 — create the `samograph-prod` client (owner, once)

Do these in order in <https://console.cloud.google.com>. Newer consoles have
renamed some screens; both names are given.

1. **Project.** Create or select a project named `samograph`. Note the project id.
2. **Consent screen.** Open **APIs & Services → OAuth consent screen** (newer:
   **Google Auth Platform → Branding**).
   - User type: **External**.
   - App name: exactly `samograph`.
   - Set the **user support email**.
   - **SKIP the app logo.** Uploading one triggers Google brand verification and
     delays publishing. It only affects how the consent screen looks.
   - App domain → Application home page: `https://samograph.samo.team`;
     Privacy policy link: `https://samograph.samo.team/privacy`;
     Terms of service link: `https://samograph.samo.team/terms`.
   - **Authorized domains: add ALL of `samograph.dev`, `samo.team` AND
     `samo.cat`.** These are three distinct registrable domains; omitting
     `samo.cat` makes the non-prod client unusable, and omitting `samograph.dev`
     makes the `samograph.dev` redirect URI unregistrable.
   - Set the **developer contact email**. Save.
3. **Scopes.** Open **Data access** (older: the **Scopes** step) → *Add or remove
   scopes* → tick **only** `openid` and `.../auth/userinfo.email`.
   **Do NOT tick `.../auth/userinfo.profile`.** Do not add any calendar scope.
   Both selected scopes are **non-sensitive**, which is what lets this client
   publish with no Google security assessment and no restricted-scope review.
   Update, then Save.
4. **Test users / publishing.** Open **Audience** (older: the **Test users**
   step). While Publishing status is **Testing**, add the owner's own Google
   account under *Test users* — only listed accounts can sign in, capped at
   **100**. Click **Publish app** once `/privacy` and `/terms` are live; with only
   non-sensitive scopes this does **not** queue for review.
5. **Credentials.** **Credentials → Create credentials → OAuth client ID →
   Application type `Web application`.** Name it `samograph-prod`.
   - Leave **Authorized JavaScript origins EMPTY** — we never use the Google JS SDK.
   - Under **Authorized redirect URIs**, click *ADD URI* and paste the exact URI
     for the host this credential's environment serves — from the table in
     [READ FIRST](#-read-first--the-redirect-uri-path-is-authgooglecallback):
     `https://samograph.dev/auth/google/callback` and/or
     `https://samograph.samo.team/auth/google/callback`. **No trailing slash, no
     wildcard, and the path is `/auth/google/callback` — NOT `/auth/callback`.**
   - Click **Create**.
6. **Copy the pair.** The dialog shows the **Client ID** and **Client secret**
   once, with a *Download JSON* button. Copy both now — the secret can be
   re-created later but never re-read.
7. **Hand them over OUT OF BAND.** Never paste either value into a GitHub issue, a
   PR comment, a commit, a chat log, or a screenshot. This repo is public.
8. **Wire prod.** Put them in prod's `envFile` (`/opt/samograph/app/.env`) as
   `GOOGLE_OAUTH_CLIENT_ID=` and `GOOGLE_OAUTH_CLIENT_SECRET=`, then restart the
   `samograph-web` unit.

> Redirect-URI edits can take **from five minutes to a few hours** to propagate.
> Until they do, sign-in fails with `Error 400: redirect_uri_mismatch`. That is
> expected, not a code bug — see [Troubleshooting](#troubleshooting).

## Part 2 — create the `samograph-nonprod` client (owner, once)

In the **same project**, under the **same consent screen** (do not create a second
consent screen):

1. **Credentials → Create credentials → OAuth client ID → `Web application`.**
   Name it `samograph-nonprod`.
2. Leave **Authorized JavaScript origins** empty.
3. Under **Authorized redirect URIs** add exactly **two** entries — again the
   path is `/auth/google/callback`, **not** `/auth/callback`:
   - `https://samograph-main.samo.cat/auth/google/callback`
   - `http://localhost:3000/auth/google/callback` — `http` is permitted for
     `localhost` **only**.
4. **Create**, then copy the client id and secret.
5. Give this pair to the **`samograph-main` preview's env file** and to **local
   developer machines**. Give the **prod** pair to **nothing but prod**.
6. Give **neither** pair to a branch preview.

## Part 3 — the blocking owner input that is not a secret

Google will not publish an External consent screen out of Testing mode without
**live Privacy policy and Terms of service URLs**. Engineering ships the
`/privacy` and `/terms` routes; the **owner must supply the policy text** — what
samograph collects, that Google sign-in receives **only the account's email
address**, retention per §5.13, and the §5.14 erasure right.

Until both URLs return 200 on `https://samograph.samo.team`, the client stays in
**Testing** mode and only the ≤100 listed test users can sign in. The code is
fully functional in that state, so this blocks **general availability** — not
development, and not the owner's own end-to-end test.

## Environment variables

| Var | Where it belongs | Required? | Purpose |
|---|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | prod `.env` (prod client); `samograph-main` env + local dev (non-prod client). **Never** a branch preview. | No — absent ⇒ Google sign-in is simply OFF | Sent on `/authorize` and at the token exchange, and **pinned as the required `aud`** (and `azp` when present) during ID-token verification. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | same as above | No — absent ⇒ OFF. Setting **exactly one** of the pair **throws at boot**, naming the missing var and echoing no value | Authenticates the server-to-server token exchange. **See the trap below.** |
| `GOOGLE_OAUTH_REDIRECT_URI` | optional override, per env | No — unless this env sets neither `BASE_URL` nor `WEB_ORIGIN` and holds a Google credential, in which case **one of the three must be set or the server refuses to boot** (#209) | **The escape hatch for any host not in the four-origin allowlist above.** Setting it **skips the allowlist entirely** — the operator has asserted the host — but the value still gets the full **shape check**: https (or http for `localhost` only), no embedded credentials, no query, no fragment, path exactly `/auth/google/callback`, and already-canonical (an explicit `:443`, an uppercase host or a `..` segment is rejected at boot, because it could not byte-match what Google has registered). When it is unset, the redirect URI is derived as `<web origin>/auth/google/callback` and the origin must be one of the four. |
| `GOOGLE_CALENDAR_REDIRECT_URI` | optional override, per env | No | Calendar equivalent of `GOOGLE_OAUTH_REDIRECT_URI`; path must be exactly `/calendar/connect/callback`. Otherwise derived from the configured web origin and checked against the same registered-origin allowlist. |
| `CALENDAR_TOKEN_ENCRYPTION_KEY_VERSION` | app-api secret env | Yes when Google Calendar is enabled | Together with the other two `CALENDAR_TOKEN_*` vars, explicitly opts the deployment into Calendar. Positive integer version used for newly encrypted refresh tokens. |
| `CALENDAR_TOKEN_ENCRYPTION_KEY` | app-api secret env | Yes when Google Calendar is enabled | Together with the other two `CALENDAR_TOKEN_*` vars, explicitly opts the deployment into Calendar. Base64 encoding of exactly 32 random bytes; the active AES-256-GCM key. |
| `CALENDAR_TOKEN_DECRYPTION_KEYS` | app-api secret env | Yes when Google Calendar is enabled | Together with the other two `CALENDAR_TOKEN_*` vars, explicitly opts the deployment into Calendar. JSON map of key versions to base64 keys, including the active version, e.g. `{"1":"<base64>"}`. Keep old versions during rotation. |
| `APP_API_ORIGIN` | already required, per env (`apps/web/next.config.mjs`) | **Yes** (pre-existing) | Proxies `/auth/google/start`, `/auth/google/callback` and `/auth/providers` from the web origin to app-api. The whole `rewrites()` key disappears when it is unset — this already-known trap now takes Google sign-in down with it. **Verify it per env on every deploy.** |

Both Google vars are read in `googleOAuthFromEnv()` from inside the server
entrypoint, never at module top level — so a repo with no Google config stays
importable under `bun test`.

Google Calendar is separately and explicitly opted in only when all three
`CALENDAR_TOKEN_*` variables above are present alongside the Google sign-in
credentials. If all three are absent, Calendar is disabled and Google sign-in
continues normally. A partial or malformed Calendar configuration refuses to
boot with the existing token-encryption configuration error.

> **Note on the derived redirect URI — set `WEB_ORIGIN`/`BASE_URL` per env.**
> `apps/app-api/server.ts` resolves the web origin via
> `resolveMagicLinkBaseUrl(env, APP_API_WEB_ORIGIN_FALLBACK)`, so the hard-coded
> last-resort default is `https://samograph.dev` — and that host is itself a
> registered origin, so the allowlist alone can no longer catch an environment
> that has lost **both** `WEB_ORIGIN` and `BASE_URL`. **Every environment must set
> its own `WEB_ORIGIN` (prod) or `BASE_URL` (samohost sets it on previews), or pin
> `GOOGLE_OAUTH_REDIRECT_URI` outright** — and since #209 the prod entrypoint
> *enforces* that whenever Google is configured (see the boot failure below). A
> derived origin outside the four-origin allowlist still throws at boot naming
> `GOOGLE_OAUTH_REDIRECT_URI`; an explicit override skips the allowlist but still
> gets the shape check.

### Boot failure: "sets neither BASE_URL nor WEB_ORIGIN"

`apps/app-api/server.ts` **refuses to boot** with:

```text
GoogleOAuthError: Google sign-in is configured but this environment sets neither
BASE_URL nor WEB_ORIGIN, so the Google redirect URI would silently derive from the
hard-coded https://samograph.dev fallback in apps/app-api/server.ts and every
sign-in would die at Google with redirect_uri_mismatch — set BASE_URL (or
WEB_ORIGIN) to THIS environment's own public origin, or set
GOOGLE_OAUTH_REDIRECT_URI explicitly to the URI registered for this host
```

**What it means.** This env holds a Google credential, pins no
`GOOGLE_OAUTH_REDIRECT_URI`, and sets neither `BASE_URL` nor `WEB_ORIGIN` — so its
redirect URI would come from the hard-coded fallback rather than from config. The
process dies at startup, in **our** logs, instead of booting and failing later at
Google in **Google's** logs on every user's click.

**The fix — one of, in preference order:**

1. Set `BASE_URL` to this environment's own public origin (what samohost injects
   into every preview's `secrets.env`). A missing `BASE_URL` on a preview means
   provisioning did not run — fix that rather than working around it.
2. Set `WEB_ORIGIN` (how prod names its own host).
3. Set `GOOGLE_OAUTH_REDIRECT_URI` to the exact URI registered for this host. Use
   this only when the host is outside the four-origin allowlist.

**The other fix, if you did not want Google here at all:** unset **both**
`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. The guard fires when
*either* is set, deliberately — the same "configured" test `googleOAuthFromEnv`
gates on, so a half-configured client cannot slip past it.

**Scope.** The guard is Google-only. An environment with no Google credentials is
completely unaffected, magic link keeps its `https://samograph.dev` default
everywhere, and `apps/app-api/dev-server.ts` does not carry the guard at all — its
own fallback is `http://localhost:3000`, which is a registered origin, so the trap
does not exist in local dev.

## The `.samohost.toml` trap — NEVER put the secret in `secrets`

> ### ⛔ `GOOGLE_OAUTH_CLIENT_SECRET` must NEVER be added to `.samohost.toml`'s `secrets` array.
>
> That array is a **per-env GENERATOR**, not a distributor. It exists to mint fresh
> random signing secrets per preview environment:
>
> ```toml
> secrets = ["SESSION_SECRET", "TOKEN_SECRET", "MAGIC_LINK_SECRET", "RECALL_WEBHOOK_SECRET"]
> ```
>
> Add `GOOGLE_OAUTH_CLIENT_SECRET` there and samohost will **mint a random
> string** for it. Then, in order:
>
> 1. the presence gate sees a non-empty value and reports Google as **configured**;
> 2. `GET /auth/providers` returns `{"google": true}`;
> 3. the **button renders** on the sign-in page;
> 4. every user who clicks it gets through Google's consent screen and then **fails
>    at Google's token endpoint**, because the "secret" is a random string Google
>    has never seen.
>
> That is **strictly worse than absent**: absent means the button never renders and
> the user is quietly served the magic-link path that works.

The same reasoning is why the OAuth **state** cookie reuses `SESSION_SECRET` with a
domain-separation prefix rather than introducing a new signed secret name: a new
name would either be added to that generator (fine, but one more per-env secret to
coordinate) or be missing on previews and crash-loop them.

Google credentials are **operator-placed values in the per-env env file**, exactly
like `RECALL_API_KEY` — never generated, never in the repo.

## Rotation

1. In **Credentials → `samograph-prod`** (or `-nonprod`), *Add secret* to create a
   second client secret. Google supports two live secrets per client during a
   rollover.
2. Update the env file(s) for that client's environments and restart the unit.
3. Confirm a live sign-in works.
4. Delete the old secret in the console.

Rotate immediately, out of band, if a secret is ever pasted anywhere public. The
client **id** is not a secret; the client **secret** is.

## Troubleshooting

**`Error 400: redirect_uri_mismatch`.** The `redirect_uri` the server sent is not
byte-identical to a registered one. In order of likelihood:

1. **The registered path is `/auth/callback` instead of `/auth/google/callback`.**
   Check this FIRST — it has already happened on real clients. `/auth/callback` is
   the magic-link callback; the Google redirect URI must end in
   `/auth/google/callback`. Fix the entry in the console and wait for propagation.
2. **You just edited the redirect URI in the console.** Propagation takes from
   **five minutes to a few hours**. Wait before changing anything else — this is
   the single most common cause of a false "the code is broken" diagnosis.
3. **Wrong host for the env** — a `samograph-main` request reaching the `-prod`
   client, or vice versa. Check which `GOOGLE_OAUTH_CLIENT_ID` that env holds.
4. **Trailing slash, `http` vs `https`, or a port.** Google compares the full
   string. `https://samograph.samo.team/auth/google/callback/` ≠
   `…/callback`.
5. **A branch preview.** It should never reach Google at all — it has no
   credentials and `/auth/google/*` returns `SAMO-AUTH-010`. If a branch preview
   *did* reach Google, a credential leaked into a preview env; rotate it.
6. **The derived default drifted to `samograph.dev`** because that env has neither
   `WEB_ORIGIN` nor `BASE_URL` set. Since #209 this cannot happen silently on
   `apps/app-api/server.ts` — that env refuses to boot with the
   ["sets neither BASE_URL nor WEB_ORIGIN"](#boot-failure-sets-neither-base_url-nor-web_origin)
   error instead. If you are seeing `redirect_uri_mismatch` rather than a boot
   failure, the env DID set one of them (or pinned `GOOGLE_OAUTH_REDIRECT_URI`) —
   check its value against the console entry rather than assuming the default.

**"Access blocked: samograph has not completed the Google verification process"**,
or a sign-in that works for the owner and nobody else. The client is still in
**Testing** mode: only the **≤100 listed test users** can sign in. Add the account
under *Audience → Test users*, or publish the app (needs `/privacy` and `/terms`
live — Part 3).

**The button does not render.** Expected on branch previews and on any env with no
credentials. Check `GET /auth/providers` on that env: `{"google": false}` means the
provider is genuinely not composed. A `5xx` or a network failure on that probe also
resolves to `false` in the client **by design**, so a broken probe can never break
the sign-in page — but it will hide a working button, so check app-api's health
too.

**The button renders but every sign-in fails at Google.** Read [the
`.samohost.toml` trap](#the-samohosttoml-trap--never-put-the-secret-in-secrets)
first — that is what this symptom means until proven otherwise. Then check that
the id/secret pair belongs to the **same** client.

**`SAMO-AUTH-009` — "email isn't verified".** The Google account's
`email_verified` is not boolean `true` on the ID token. This is a **hard gate**: we
create nothing, link nothing, and mint no cookie. Do not "fix" it by relaxing the
gate — it is the check that stands between the callback and an account takeover
(S5-1 item 4). The user verifies with Google, or signs in with magic link.

**Sign-in works but lands on the wrong host / 404s.** Check `APP_API_ORIGIN` for
that env — without it, `apps/web/next.config.mjs` drops the whole `rewrites()` key
and `/auth/google/*` never reaches app-api.

## See also

- [`SPEC.amendments.md` → S5-1](../../blueprints/samograph-dev/SPEC.amendments.md) — the amendment that reverses the §1 "no Google OAuth" non-goal, and the boundary it holds (no calendar scopes).
- [db-bootstrap.md](./db-bootstrap.md) — the per-env superuser bootstrap; a fresh DB without it breaks **all** sign-in, Google included.
- [trusted-proxy.md](./trusted-proxy.md) — `clientIp()` feeds the 20/hr/IP limit on `/auth/google/start` too.
- [README index](./README.md) — full runbook set.
