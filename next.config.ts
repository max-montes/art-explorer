import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@huggingface/transformers", "pg"],
};

export default nextConfig;
