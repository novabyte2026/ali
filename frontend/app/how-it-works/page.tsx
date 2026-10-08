import type { Metadata } from 'next';
import { HowItWorksView } from '@/components/pages/HowItWorksView';

export const metadata: Metadata = { title: 'How it works' };

export default function HowItWorksPage() {
  return <HowItWorksView />;
}
