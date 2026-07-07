# Trusted-proxy assumption for `clientIp()` / per-IP magic-link limit

**Audience:** SRE / deploy owner. **Severity if violated:** the per-IP magic-link
rate limit (§5.1) becomes trivially bypassable and per-IP accounting is meaningless.

**SPEC provenance:** [SPEC.amendments item 11](../../blueprints/samograph-dev/SPEC.amendments.md)
(§5.1 clarification — `clientIp()` trusts the first `X-Forwarded-For` hop).

## The rule (deployment invariant)

app-api MUST sit behind a **trusted edge/proxy** (in v1: Cloudflare → Caddy →
the regional cloudflared **named** tunnel, §4.3) that **OVERWRITES** — not
appends — the `X-Forwarded-For` header with the real client IP before the request
reaches app-api.

**app-api MUST NEVER be exposed directly to the public internet.** Only the
trusted edge may reach app-api's origin.

## Why — the code that depends on it

`clientIp()` in `apps/app-api/auth/http.ts` (lines 18–27) derives the caller IP
for the 20/hr per-IP magic-link limit like this:

1. take the **FIRST** hop of `X-Forwarded-For` (`xff.split(",")[0]`), else
2. fall back to `cf-connecting-ip`, else
3. bucket the caller as the literal string `"unknown"`.

`X-Forwarded-For` is a client-supplied request header. The first hop is only the
real client IP when a trusted proxy has **rewritten** the header. Two failure
modes if the invariant is violated:

- **Spoofing.** If app-api is reachable directly (or the edge *appends* to a
  client-supplied XFF instead of replacing it), an attacker sets
  `X-Forwarded-For: 1.2.3.4` per request and rotates it freely. Each forged value
  is a fresh per-IP bucket, so the **20/hr** per-IP magic-link cap is bypassed at
  will — unlimited magic-link emails to any address.
- **Bucket collapse.** Direct callers with no XFF and no `cf-connecting-ip` all
  fall through to the single `"unknown"` bucket, so honest and hostile traffic
  share one counter and legitimate users get throttled by unrelated load.

This is acceptable for v1 **only because** the deployment boundary guarantees a
trusted proxy that overwrites XFF. That guarantee is what this runbook records.

## Operator verification

Confirm, on the origin app-api receives:

- app-api's origin is **not** routable from the public internet (only the edge
  can reach it — firewall / private network / origin auth).
- The edge sets `X-Forwarded-For` to the connecting client IP, **replacing** any
  client-supplied value (or, equivalently, app-api reads `cf-connecting-ip` set
  by Cloudflare). A request arriving with an attacker-chosen `X-Forwarded-For`
  must NOT have that value survive to app-api.

Quick check (from outside the trusted edge, against the public hostname):

```bash
# The forged XFF must NOT win. If the rate-limit bucket keys off 9.9.9.9,
# the edge is appending instead of overwriting — that is the bug.
curl -s -D- -H 'X-Forwarded-For: 9.9.9.9' https://<app-api-host>/auth/magic-link \
  -H 'content-type: application/json' -d '{"email":"probe@example.com"}'
```

## Infra follow-up — NOT done in this doc (needs VM access, owner: Nik)

> **FOLLOW-UP (prod infra, requires VM access):** The production
> **Cloudflare + Caddy** config must be verified and, if needed, adjusted to
> **normalize `X-Forwarded-For`** so the value app-api sees is the real client IP
> and cannot be spoofed. **Caddy's `reverse_proxy` APPENDS to `X-Forwarded-For`
> by default** — it does not replace a client-supplied header — so a raw config
> can leak an attacker-chosen first hop through to `clientIp()`. Fixes to apply
> at the edge, to be checked on the VM:
>
> - Strip/replace any inbound `X-Forwarded-For` at the Cloudflare edge and at
>   Caddy so only the trusted-computed client IP reaches app-api (e.g. Caddy
>   `header_up X-Forwarded-For {remote_host}` / `{http.request.remote.host}`, or
>   rely on Cloudflare's `cf-connecting-ip` which `clientIp()` already reads).
> - Ensure app-api's origin is firewalled so it is reachable **only** through the
>   Cloudflare + Caddy path, never directly.
>
> This half cannot be completed from an application-repo PR — it is a deployment
> change on the Hetzner VM and is handed off to the deploy owner (Nik).

## See also

- [SPEC.amendments item 11](../../blueprints/samograph-dev/SPEC.amendments.md) — the §5.1 clarification this runbook enforces.
- [README index](./README.md) — full runbook set.
