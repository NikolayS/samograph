/**
 * Marketing landing at `samograph.dev` (SPEC §3 Story 1, §8 Sprint 3 final copy).
 * Hero + honest v1 value prop (hosted, zero-setup) + the four-step flow, with a
 * single call-to-action into the magic-link sign-in.
 * probe-deploy-evidence-20260710
 */
export function Landing() {
  return (
    <main>
      <h1>samograph</h1>
      <p className="samograph-tagline">
        Zero-setup live transcripts for your Zoom and Google Meet calls.
      </p>
      <p>
        samograph is hosted — no local CLI, no Recall token, no tunnel to run.
        Sign in, add a meeting link, and watch the transcript stream live. Share
        it read-only with anyone, or download it when the call ends.
      </p>
      <ol className="samograph-steps">
        <li>Sign in with a magic link.</li>
        <li>Add a Zoom or Google Meet meeting link.</li>
        <li>Watch the transcript stream live.</li>
        <li>Share it read-only, or download it.</li>
      </ol>
      <a href="/auth">Get started</a>
    </main>
  );
}
