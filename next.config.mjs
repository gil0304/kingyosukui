/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // R3F + sensor listeners: double-invoke causes duplicate WebGL/sensor setup
  transpilePackages: ['three'],
  eslint: { ignoreDuringBuilds: true },
  /**
   * The page documents are tiny and the chunk files they reference are renamed
   * by every build — an HTML file cached across a rebuild produces a page that
   * renders but never hydrates (the venue "button does nothing" failure).
   * Chunks under /_next/static keep their content-hashed immutable caching;
   * only the documents are pinned to no-store.
   */
  async headers() {
    const noStore = [
      { key: 'Cache-Control', value: 'no-store, must-revalidate' },
    ];
    return [
      { source: '/', headers: noStore },
      { source: '/join/:path*', headers: noStore },
      { source: '/screen/:path*', headers: noStore },
      { source: '/admin', headers: noStore },
    ];
  },
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(glsl|vs|fs|vert|frag)$/,
      type: 'asset/source',
    });
    return config;
  },
};
export default nextConfig;
