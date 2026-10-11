"use client";

/**
 * "Signed in as <email>" — the standing answer to *which account is this?* (#238).
 *
 * The address is `users.email` as served by `GET /settings`' read-only `signin`
 * block: authoritative, immutable, and the only address this system stands
 * behind (`apps/app-api/settings/signin.ts`). The provider-ASSERTED
 * `user_identities.email` is never served and must never be shown here.
 *
 * WHY IT RENDERS SOMETHING WHEN IT KNOWS NOTHING: the surfaces that mount this
 * (dashboard header, settings) draw before the address arrives — their own data
 * and this fact land on independent requests. Returning `null` in that window
 * would collapse the line and pop the layout when the address lands, and
 * interpolating an absent value would print "undefined" at a user. So the
 * unknown state keeps its line with a non-breaking space and is `aria-hidden`
 * until it has something true to say.
 *
 * An empty string counts as unknown, not as an address: `readSignIn` degrades a
 * missing `users` row to `""` rather than failing the whole settings read, and
 * "Signed in as " with nothing after it is worse than saying nothing.
 */
export function AccountEmail({ email }: { email: string | null }) {
  const known = typeof email === "string" && email.length > 0;
  return (
    <span
      className="samograph-account-email"
      data-loading={known ? undefined : "true"}
      aria-hidden={known ? undefined : "true"}
      title={known ? email : undefined}
    >
      {known ? `Signed in as ${email}` : " "}
    </span>
  );
}
