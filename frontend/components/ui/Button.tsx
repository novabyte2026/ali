import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

/**
 * Button.
 *
 * Renders as a `<button>`, a Next `<Link>` or an `<a>` depending on what it
 * does, because that distinction is what makes keyboard and screen-reader
 * behaviour correct: a thing that navigates must be a link, a thing that acts
 * must be a button. The appearance is identical either way.
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface CommonProps {
  readonly variant?: Variant;
  readonly size?: Size;
  readonly block?: boolean;
  readonly iconOnly?: boolean;
  /** Mirrors a directional icon under RTL. */
  readonly flipIcon?: boolean;
  readonly children?: ReactNode;
  readonly className?: string;
}

type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & {
    readonly as?: 'button';
  };

type InternalLinkProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children' | 'href'> & {
    readonly as: 'link';
    readonly href: string;
  };

type ExternalLinkProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children' | 'href'> & {
    readonly as: 'external';
    readonly href: string;
  };

export type Props = ButtonProps | InternalLinkProps | ExternalLinkProps;

function classesFor(props: CommonProps): string {
  return [
    styles.button,
    styles[props.variant ?? 'secondary'],
    styles[props.size ?? 'md'],
    props.block ? styles.block : '',
    props.iconOnly ? styles.iconOnly : '',
    props.flipIcon ? styles.flipIcon : '',
    props.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function Button(props: Props) {
  const className = classesFor(props);

  if (props.as === 'link') {
    const { as: _as, variant, size, block, iconOnly, flipIcon, className: _c, children, href, ...rest } = props;
    return (
      <Link href={href} className={className} {...rest}>
        {children}
      </Link>
    );
  }

  if (props.as === 'external') {
    const { as: _as, variant, size, block, iconOnly, flipIcon, className: _c, children, href, ...rest } = props;
    return (
      <a
        href={href}
        className={className}
        // `noopener` prevents the destination from reaching back into this
        // window; `noreferrer` keeps our URL out of the store's referrer logs,
        // which is both a privacy choice and avoids leaking a user's query.
        rel="noopener noreferrer"
        {...rest}
      >
        {children}
      </a>
    );
  }

  const { as: _as, variant, size, block, iconOnly, flipIcon, className: _c, children, type, ...rest } = props;
  return (
    <button type={type ?? 'button'} className={className} {...rest}>
      {children}
    </button>
  );
}
