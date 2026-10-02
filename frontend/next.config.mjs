/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Product imagery is served from marketplace CDNs. Only the hosts whose
  // providers we integrate are allowed, so a mis-mapped response cannot turn
  // into an arbitrary outbound image request from our origin.
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.media-amazon.com' },
      { protocol: 'https', hostname: '*.ssl-images-amazon.com' },
      { protocol: 'https', hostname: '*.alicdn.com' },
      { protocol: 'https', hostname: '*.aliexpress-media.com' },
      { protocol: 'https', hostname: 'img.kwcdn.com' },
      { protocol: 'https', hostname: '*.kwcdn.com' },
      { protocol: 'https', hostname: '*.temu.com' },
    ],
    formats: ['image/avif', 'image/webp'],
    // Matches the card and detail sizes actually used, so we are not
    // generating variants nothing requests.
    deviceSizes: [360, 480, 640, 828, 1080, 1280],
    imageSizes: [64, 96, 128, 200, 256, 384],
    minimumCacheTTL: 3600,
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            // Nothing in this product needs a camera, a microphone or a
            // location, so none of them is requestable.
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },

  experimental: {
    // Keeps the shared contracts package in the server bundle rather than
    // being traced as an external dependency.
    optimizePackageImports: ['@shelf/shared'],
  },

  transpilePackages: ['@shelf/shared'],
};

export default nextConfig;
