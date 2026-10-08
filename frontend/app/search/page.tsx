import { Suspense } from 'react';
import type { Metadata } from 'next';
import { SearchView } from '@/components/search/SearchView';
import { ResultSkeleton } from '@/components/search/ResultSkeleton';

export const metadata: Metadata = {
  // Search result pages are per-user and time-sensitive; indexing them would
  // create thousands of thin pages with no lasting value (rule 113).
  robots: { index: false, follow: true },
};

/**
 * Search page.
 *
 * The URL is the state (rule 112): query, source, filters, sort and page all
 * live in the query string, so a search is shareable, the back button works,
 * and a reload restores exactly what the user was looking at. Nothing private
 * goes in the URL.
 */
export default function SearchPage() {
  return (
    <Suspense fallback={<SearchPageFallback />}>
      <SearchView />
    </Suspense>
  );
}

function SearchPageFallback() {
  return (
    <div className="page" style={{ paddingBlock: 'var(--s-6)' }}>
      <ResultSkeleton count={4} />
    </div>
  );
}
