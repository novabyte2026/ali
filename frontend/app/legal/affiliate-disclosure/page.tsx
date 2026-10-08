import type { Metadata } from 'next';
import { AffiliateDisclosureView } from '@/components/pages/AffiliateDisclosureView';

export const metadata: Metadata = { title: 'Affiliate disclosure' };

export default function AffiliateDisclosurePage() {
  return <AffiliateDisclosureView />;
}
