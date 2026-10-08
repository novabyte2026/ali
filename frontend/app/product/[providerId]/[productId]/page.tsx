import type { Metadata } from 'next';
import { ProductView } from '@/components/product/ProductView';

export const metadata: Metadata = {
  // A product page mirrors a marketplace listing we do not own. Indexing it
  // would create thin duplicate pages, which rule 113 rules out.
  robots: { index: false, follow: true },
};

export default async function ProductPage({
  params,
}: {
  readonly params: Promise<{ readonly providerId: string; readonly productId: string }>;
}) {
  const { providerId, productId } = await params;
  return <ProductView providerId={providerId} providerProductId={productId} />;
}
