export interface PageSkeletonProps {
  variant?: "form" | "page";
}

export function PageSkeleton({ variant = "page" }: PageSkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className={`samograph-skeleton samograph-skeleton--${variant}`}
    >
      <span className="samograph-visually-hidden">Loading…</span>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </div>
  );
}
