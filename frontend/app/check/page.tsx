import type { Metadata } from 'next';
import { CheckView } from '@/components/check/CheckView';

export const metadata: Metadata = { title: 'Check a product' };

export default function CheckPage() {
  return <CheckView />;
}
