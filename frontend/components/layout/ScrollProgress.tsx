'use client';

import { useScrollProgress } from '@/lib/hooks';

/**
 * Scroll progress line.
 *
 * 2px at the top of the viewport, driven by actual scroll position. Rendered
 * at zero width on a page that does not scroll, so it never appears as a
 * decorative bar on a short page.
 *
 * Hidden from assistive technology: it conveys nothing a screen reader user
 * needs, and announcing a scroll percentage would be noise.
 */
export function ScrollProgress() {
  const progress = useScrollProgress();

  if (progress <= 0) return null;

  return (
    <div
      className="scroll-progress"
      style={{ ['--progress' as string]: String(progress) }}
      aria-hidden="true"
    />
  );
}
