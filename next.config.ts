import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@huggingface/transformers", "pg"],
  async redirects() {
    return [{ source: "/assistant", destination: "/passages", permanent: true }];
  },
};

export default nextConfig;
