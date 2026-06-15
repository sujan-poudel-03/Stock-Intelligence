/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // V2 uses .js/.jsx with the App Router; no special transpile needed.
  experimental: {
    // Allow long-running server-tool loops in API routes.
  },
};

module.exports = nextConfig;
