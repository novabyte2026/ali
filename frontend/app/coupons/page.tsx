import type { Metadata } from 'next';
import { CouponsView } from '@/components/coupons/CouponsView';

export const metadata: Metadata = {
  title: 'Coupons',
};

export default function CouponsPage() {
  return <CouponsView />;
}
