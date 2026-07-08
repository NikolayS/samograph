/**
 * The SAMO-AUTH error reference (SPEC §5.16). Codes are stable and safe to
 * switch on. The /auth/callback endpoint deliberately returns 401 with NO body
 * on every failure (no information leak about which check failed); the code is
 * carried internally for logging. /auth/magic-link surfaces SAMO-AUTH-004 (429)
 * with a Retry-After header.
 */
import type { AuthErrorCode } from "./types.ts";

export interface AuthErrorInfo {
  code: AuthErrorCode;
  httpStatus: number;
  /** Plain-English, user-facing copy (§5.16). */
  message: string;
  retryable: boolean;
}

export const AUTH_ERRORS: Record<AuthErrorCode, AuthErrorInfo> = {
  "SAMO-AUTH-001": {
    code: "SAMO-AUTH-001",
    httpStatus: 401,
    message: "This sign-in link isn't valid.",
    retryable: false,
  },
  "SAMO-AUTH-002": {
    code: "SAMO-AUTH-002",
    httpStatus: 401,
    message: "This sign-in link has expired.",
    retryable: false,
  },
  "SAMO-AUTH-003": {
    code: "SAMO-AUTH-003",
    httpStatus: 401,
    message: "This link was already used.",
    retryable: false,
  },
  "SAMO-AUTH-004": {
    code: "SAMO-AUTH-004",
    httpStatus: 429,
    message: "Too many sign-in attempts — try again shortly.",
    retryable: true,
  },
  // A stateless HMAC session cookie can outlive its tenant (prod: §5.14 GDPR
  // tenant deletion; dev: the Postgres was recreated). The signature still
  // verifies but the tenant row is gone, so tenant-scoped routes force re-auth:
  // 401 + clear-cookie so the browser drops the cookie and the web redirects to
  // sign-in, instead of reading empty (GET) or a raw FK 500 (POST) — see #114.
  "SAMO-AUTH-005": {
    code: "SAMO-AUTH-005",
    httpStatus: 401,
    message: "You've been signed out. Please sign in again.",
    retryable: false,
  },
};
