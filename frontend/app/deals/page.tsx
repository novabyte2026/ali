import type { Metadata } from 'next';
import { DealsView } from '@/components/deals/DealsView';

export const metadata: Metadata = { title: 'Deals' };

export default function DealsPage() {
  return <DealsView />;
}
