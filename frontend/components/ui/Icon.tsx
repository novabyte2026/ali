import type { SVGProps } from 'react';

/**
 * Icons.
 *
 * One consistent set, drawn here as inline SVG rather than pulled from a
 * library. Three reasons: an icon library is 50–200KB for the dozen glyphs
 * this product uses, inline SVG has no render-blocking cost, and drawing them
 * means they share one grid, one stroke weight and one terminal style — which
 * is what stops a UI looking assembled from several kits.
 *
 * All 20×20 on a 1.5px stroke, round caps, no fills. Every one is a navigation
 * or state signal; none is decoration. There is deliberately no wand, no
 * sparkle, no robot and no "magic" glyph in this file.
 */

type IconProps = SVGProps<SVGSVGElement> & { readonly size?: number };

function Svg({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Icons here always sit beside a text label or inside a button with an
      // accessible name, so they are hidden from assistive technology rather
      // than announced twice.
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="m12.7 12.7 3.8 3.8" />
    </Svg>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 10h13" />
      <path d="m11.5 5 5 5-5 5" />
    </Svg>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16.5 10h-13" />
      <path d="m8.5 5-5 5 5 5" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 7.75 5 5 5-5" />
    </Svg>
  );
}

/** Outbound link. Signals leaving for a store, never used decoratively. */
export function ExternalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 3.5h5.5V9" />
      <path d="M16.5 3.5 9 11" />
      <path d="M15 12.5v2.75a1.25 1.25 0 0 1-1.25 1.25H4.75A1.25 1.25 0 0 1 3.5 15.25V6.25A1.25 1.25 0 0 1 4.75 5H7.5" />
    </Svg>
  );
}

/** Verified: a check inside a circle. Used only where a check actually ran. */
export function VerifiedIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="6.75" />
      <path d="m7 10.25 2 2 4-4.5" />
    </Svg>
  );
}

/** Unknown / not verified. A question mark, not a warning triangle. */
export function UnknownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="6.75" />
      <path d="M8.25 8a1.75 1.75 0 1 1 2.6 1.52c-.53.32-.85.86-.85 1.48v.25" />
      <path d="M10 14.1h.01" />
    </Svg>
  );
}

/** Caution. Used for a condition on a coupon, not for errors. */
export function CautionIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.75 2.75 16.25h14.5L10 3.75Z" />
      <path d="M10 8.5v3" />
      <path d="M10 13.9h.01" />
    </Svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="6.75" />
      <path d="M10 9.25v4" />
      <path d="M10 6.6h.01" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5.5 5.5 9 9" />
      <path d="m14.5 5.5-9 9" />
    </Svg>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 6h13" />
      <path d="M6 10h8" />
      <path d="M8.25 14h3.5" />
    </Svg>
  );
}

export function SortIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 6.5h11" />
      <path d="M4.5 10h7.5" />
      <path d="M4.5 13.5h4" />
    </Svg>
  );
}

/** Saved. A bookmark outline, filled when active. */
export function BookmarkIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...props} fill={filled ? 'currentColor' : 'none'}>
      <path d="M5.5 3.75h9a.75.75 0 0 1 .75.75v11.25L10 13.1l-5.25 2.65V4.5a.75.75 0 0 1 .75-.75Z" />
    </Svg>
  );
}

/** Basket. The Smart Cart is a comparison worksheet, so this is a simple tray. */
export function BasketIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7.5h14l-1.4 8a1.25 1.25 0 0 1-1.23 1.05H5.63A1.25 1.25 0 0 1 4.4 15.5L3 7.5Z" />
      <path d="M7.25 7.5 9 3.5" />
      <path d="M12.75 7.5 11 3.5" />
    </Svg>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.6 3.5H16a.5.5 0 0 1 .5.5v5.4a1 1 0 0 1-.29.7l-6.1 6.11a1 1 0 0 1-1.42 0L3.79 11.3a1 1 0 0 1 0-1.41l6.1-6.1a1 1 0 0 1 .71-.3Z" />
      <path d="M13.4 6.6h.01" />
    </Svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.5a4.25 4.25 0 0 1 4.25 4.25c0 3.1 1 4 1 4h-10.5s1-.9 1-4A4.25 4.25 0 0 1 10 3.5Z" />
      <path d="M8.5 15.25a1.6 1.6 0 0 0 3 0" />
    </Svg>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="7.25" r="2.75" />
      <path d="M4.5 16.5a5.5 5.5 0 0 1 11 0" />
    </Svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 6h13" />
      <path d="M3.5 10h13" />
      <path d="M3.5 14h13" />
    </Svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="7.25" y="7.25" width="9.25" height="9.25" rx="1.25" />
      <path d="M12.75 7.25V4.75A1.25 1.25 0 0 0 11.5 3.5h-6.75A1.25 1.25 0 0 0 3.5 4.75v6.75a1.25 1.25 0 0 0 1.25 1.25h2.5" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.5 10.5 3.75 3.75L15.5 7" />
    </Svg>
  );
}

/** Compare: two columns side by side. */
export function CompareIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.25" y="4.5" width="5.5" height="11" rx="1" />
      <rect x="11.25" y="4.5" width="5.5" height="11" rx="1" />
      <path d="M10 3v14" strokeDasharray="2 2" />
    </Svg>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.5 11.5a2.75 2.75 0 0 0 3.89 0l2.36-2.36a2.75 2.75 0 0 0-3.89-3.89l-.98.98" />
      <path d="M11.5 8.5a2.75 2.75 0 0 0-3.89 0L5.25 10.86a2.75 2.75 0 0 0 3.89 3.89l.98-.98" />
    </Svg>
  );
}

export function ShippingIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.75 6.5h8v7h-8z" />
      <path d="M10.75 9h3l2.5 2.5v2h-5.5z" />
      <circle cx="5.75" cy="15" r="1.4" />
      <circle cx="13.5" cy="15" r="1.4" />
    </Svg>
  );
}

export function StarIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...props} fill={filled ? 'currentColor' : 'none'}>
      <path d="m10 3.5 2.06 4.18 4.61.67-3.34 3.26.79 4.59L10 14.03l-4.12 2.17.79-4.59L3.33 8.35l4.61-.67L10 3.5Z" />
    </Svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.25 15.5 5.5v4.25c0 3.3-2.2 5.6-5.5 6.75-3.3-1.15-5.5-3.45-5.5-6.75V5.5L10 3.25Z" />
    </Svg>
  );
}

/**
 * Placeholder for a listing with no image.
 *
 * A neutral mark rather than the words "not available": a missing photograph
 * is unremarkable, and labelling it as absent data makes an ordinary gap look
 * like a failure. Drawn at a lighter weight than the interface icons so it
 * recedes into the empty frame.
 */
export function ImagePlaceholderMark({ size = 28, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={0.45}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 16.5 4.5-4.5 3.5 3.5 3-3 6 6" />
      <circle cx="8.5" cy="9.5" r="1.25" />
    </svg>
  );
}
