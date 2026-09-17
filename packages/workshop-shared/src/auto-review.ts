/** An administrator's required human-review scope. Null matches every vendor or action tag. */
export type AutoReviewBoundary = {
  /** Stable gatekeeper vendor ID, or null for all vendors. */
  vendorId: string | null;
  /** Exact action-kind tag, or null for every action kind. */
  tag: string | null;
};

/** Whether policy requires a human decision. Unknown legacy vendors conservatively match vendor scopes. */
export function requiresManualReview(boundaries: readonly AutoReviewBoundary[], vendorId: string | undefined, tag: string | undefined): boolean {
  return boundaries.some(rule => (rule.vendorId === null || vendorId === undefined || rule.vendorId === vendorId) &&
    (rule.tag === null || rule.tag === tag));
}
