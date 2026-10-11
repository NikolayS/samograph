import { useId, type ReactNode } from "react";

export interface PageHeaderProps {
  /** The page title. Renders as the page's single `<h1>`. */
  title: ReactNode;
  /** A small line ABOVE the title — a back link, or a kicker. Optional. */
  eyebrow?: ReactNode;
  /** One muted line under the title, capped at a reading measure. Optional. */
  description?: ReactNode;
  /** Page-level actions: right of the title from `--bp-md` up, below it on mobile. */
  actions?: ReactNode;
  /** Extra classes on the `<header>` — page-specific rules compose onto the shared ones. */
  className?: string;
  /** Pin the `<h1>` id (so a caller can point its own `aria-labelledby` at it). */
  titleId?: string;
}

/**
 * The one page header (DESIGN-MODEL §4 "Page header", PLAN.md desktop PR 5).
 *
 * Every page grew its own heading block, so the H1 size, the gap under it and
 * the place secondary text went were three different answers per route — and on
 * `/calls/[id]` the raw meeting URL was rendered INSIDE the H1, where a Zoom
 * `?pwd=` join secret got read out at 28px. This component fixes the shape once:
 *
 *   eyebrow  (back link / kicker)     — `--text-sm`, muted
 *   title    (the ONLY h1 on a page)  — `--text-xl`/700
 *   description                        — `--text-base`, muted, `max-width: 60ch`
 *   actions                            — right-aligned ≥ `--bp-md`, below on mobile
 *
 * Everything but the title is optional and simply not rendered when absent, so
 * a bare `<PageHeader title="Settings" />` emits one `<h1>` and nothing else —
 * no empty boxes contributing grid gap.
 *
 * The `<header>` is labelled by its own title. Inside `<main>` this element is
 * generic, not a `banner` landmark, so the label is not a landmark name — it is
 * an accessible name on the group, which is what lets a screen reader announce
 * which page header it has entered when more than one region is on the page.
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
  titleId,
}: PageHeaderProps) {
  const generatedId = useId();
  const headingId = titleId ?? `samograph-page-title-${generatedId}`;
  // `--has-actions` is what lets the CSS switch to the two-column grid ONLY when
  // there is a second column to switch to: `:has()` would do it, but a class the
  // component already knows keeps the rule readable and works everywhere.
  const classes = [
    "samograph-page-header",
    actions ? "samograph-page-header--has-actions" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <header className={classes} aria-labelledby={headingId}>
      <div className="samograph-page-header-text">
        {eyebrow ? <div className="samograph-page-header-eyebrow">{eyebrow}</div> : null}
        <h1 id={headingId} className="samograph-page-header-title">
          {title}
        </h1>
        {description ? (
          <div className="samograph-page-header-description">{description}</div>
        ) : null}
      </div>
      {actions ? <div className="samograph-page-header-actions">{actions}</div> : null}
    </header>
  );
}
