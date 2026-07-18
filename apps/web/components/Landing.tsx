/**
 * Marketing landing at `samograph.dev` — the "Greenroom" hero (issue #182,
 * SPEC §3 Story 1, §8 Sprint 3 final copy).
 *
 * Two-column hero: an honest value prop + the four-step v1 flow + a single
 * primary CTA into the magic-link sign-in, beside an illustrative
 * product-preview panel that echoes the live-transcript look (mono timestamp
 * lines, a streaming partial caret, a presence pill). The preview is sample
 * data — explicitly labeled as an example, never the viewer's real call.
 *
 * Copy stays truthful to what v1 does (hosted, zero-setup — no CLI, no Recall
 * token, no tunnel). No invented metrics or claims. Styling and light/dark
 * theming come from the Greenroom tokens in `app/globals.css`.
 */
export function Landing() {
  return (
    <main className="samograph-landing">
      <div className="samograph-hero">
        <div className="samograph-hero-copy">
          <p className="samograph-wordmark">samograph</p>
          <h1 className="samograph-hero-headline">
            Zero-setup live transcripts for your Zoom and Google Meet calls.
          </h1>
          <p className="samograph-hero-subhead">
            samograph is hosted — no local CLI, no Recall token, no tunnel to
            run. Sign in, add a meeting link, and watch the transcript stream
            live. Share it read-only with anyone, or download it when the call
            ends.
          </p>
          <ol className="samograph-hero-steps" aria-label="How it works">
            <li>Sign in with a magic link.</li>
            <li>Add a Zoom or Google Meet meeting link.</li>
            <li>Watch the transcript stream live.</li>
            <li>Share it read-only, or download it.</li>
          </ol>
          <a className="samograph-hero-cta" href="/auth">
            Get started
          </a>
        </div>

        <figure className="samograph-hero-preview">
          <div className="samograph-hero-preview-bar">
            <span className="samograph-hero-preview-status">
              <span
                className="samograph-hero-live-dot"
                aria-hidden="true"
              />
              Live
            </span>
            <span className="samograph-presence">
              <span className="samograph-presence-pill" data-state="listening">
                Listening
              </span>
            </span>
          </div>
          <ol
            className="samograph-hero-transcript"
            aria-label="Sample transcript lines"
          >
            <li>[00:00:04] Alex: Morning — can everyone hear me okay?</li>
            <li>[00:00:11] Priya: Loud and clear. Let&apos;s start with the rollout.</li>
            <li className="samograph-hero-line-partial">
              [00:00:18] Alex: So the cutover plan is
            </li>
          </ol>
          <figcaption className="samograph-hero-preview-note">
            Sample transcript — an illustrative example, not a live call.
          </figcaption>
        </figure>
      </div>
    </main>
  );
}
