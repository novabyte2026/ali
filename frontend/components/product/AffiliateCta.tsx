'use client';

import { useLocale } from '@/components/LocaleProvider';
import { Button } from '@/components/ui/Button';
import { ExternalIcon } from '@/components/ui/Icon';
import styles from './AffiliateCta.module.css';

/**
 * Outbound call to action.
 *
 * Four deliberate choices, all from the same principle: the user should know
 * exactly what happens when they press this.
 *
 *   - The label names the store. "Open in Amazon", not "Buy now!!!" — this
 *     product does not sell anything and should not imply that it does
 *     (rules 117, 276).
 *   - The destination host is printed under the button, so leaving our site is
 *     visible before the click rather than after it.
 *   - The affiliate disclosure sits adjacent to the button, in body text, not
 *     in a tooltip and not only in the footer (rules 22, 153).
 *   - No urgency, no countdown, no scarcity. There is nothing here we could
 *     substantiate, so there is nothing here (rules 96, 97).
 */
export function AffiliateCta({
  providerId,
  providerName,
  destinationUrl,
  disclosureText,
  onOpen,
}: {
  readonly providerId: string;
  readonly providerName: string;
  readonly destinationUrl: string;
  readonly disclosureText: string | null;
  readonly onOpen: () => void;
}) {
  const { dict } = useLocale();

  const host = safeHost(destinationUrl);

  return (
    <div className={styles.wrap}>
      <Button variant="primary" size="lg" onClick={onOpen} block>
        {dict.product.openInStore(providerName)}
        <ExternalIcon size={17} />
      </Button>

      {host ? <p className={styles.destination}>{dict.product.goingTo(host)}</p> : null}

      {/* The programme's own wording where it specifies one, falling back to
       * our general statement. Never both, and never neither. */}
      <p className={styles.disclosure}>{disclosureText ?? dict.affiliate.disclosureLong}</p>
    </div>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
