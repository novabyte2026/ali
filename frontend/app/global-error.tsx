'use client';

/**
 * Last-resort error boundary.
 *
 * Replaces the whole document when the root layout itself throws, so it has to
 * carry its own html/body. Deliberately shows no stack trace, no digest beyond
 * the one Next provides for log correlation, and no exception message —
 * nothing a user receives should expose our internals (rule 79).
 *
 * The copy is bilingual rather than translated: at this point the locale
 * provider may be the thing that failed, so a dictionary lookup is not safe.
 */
export default function GlobalError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  return (
    <html lang="he" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem',
          background: '#fbfaf9',
          color: '#1c1a18',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans Hebrew', Arial, sans-serif",
        }}
      >
        <div style={{ display: 'grid', gap: '1rem', justifyItems: 'center', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
            משהו לא עבד
            <span style={{ display: 'block', fontSize: '0.9rem', fontWeight: 400, opacity: 0.7 }}>
              Something did not work
            </span>
          </h1>

          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: 40,
              padding: '0.5rem 1rem',
              borderRadius: 6,
              border: '1px solid #0f5e59',
              background: '#0f5e59',
              color: '#fbfaf9',
              font: 'inherit',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            נסה שוב · Try again
          </button>

          {error.digest ? (
            <code style={{ fontSize: '0.75rem', opacity: 0.55, userSelect: 'all' }}>
              {error.digest}
            </code>
          ) : null}
        </div>
      </body>
    </html>
  );
}
