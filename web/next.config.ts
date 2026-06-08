import path from "path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// Load DATABASE_URL and other secrets from the repo-root .env (shared with Python importers).
loadEnvConfig(path.join(__dirname, ".."));

const nextConfig: NextConfig = {};

export default nextConfig;
