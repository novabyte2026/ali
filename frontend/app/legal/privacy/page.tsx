import type { Metadata } from 'next';
import { PrivacyView } from '@/components/pages/legal/PrivacyView';

export const metadata: Metadata = { title: 'Privacy policy' };

export default function PrivacyPage() {
  return <PrivacyView />;
}
