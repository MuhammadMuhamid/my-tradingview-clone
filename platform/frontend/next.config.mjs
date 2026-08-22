/** @type {import('next').NextConfig} */
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:4000";

const nextConfig = {
  reactStrictMode: true,
  // Produce a minimal self-contained Node server for the production container.
  output: "standalone",
  // Proxy API calls to the backend so the browser talks to one origin (no CORS).
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND}/api/:path*` }];
  },
};

export default nextConfig;
