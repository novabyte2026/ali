import type { Metadata } from 'next';
import { CookiesView } from '@/components/pages/legal/CookiesView';

export const metadata: Metadata = { title: 'Cookie policy' };

export default function CookiesPage() {
  return <CookiesView />;
}
