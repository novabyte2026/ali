import type { Metadata } from 'next';
import { TermsView } from '@/components/pages/legal/TermsView';

export const metadata: Metadata = { title: 'Terms of use' };

export default function TermsPage() {
  return <TermsView />;
}
