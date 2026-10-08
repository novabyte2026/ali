import type { Metadata } from 'next';
import { AboutView } from '@/components/pages/legal/AboutView';

export const metadata: Metadata = { title: 'About' };

export default function AboutPage() {
  return <AboutView />;
}
