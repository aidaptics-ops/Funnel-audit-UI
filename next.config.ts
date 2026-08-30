import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives beside the Funnel Audit API in one repository. Without this
  // Next walks up and picks the API's lockfile as the workspace root.
  turbopack: { root: path.resolve(__dirname) },
  outputFileTracingRoot: path.resolve(__dirname),
  // The seed emails are read at runtime rather than imported, so tracing does
  // not discover them on its own. Without this they are missing from the
  // serverless bundle and a deployed instance has no voice samples.
  outputFileTracingIncludes: { "/api/**": ["./seed/**"] },
};

export default nextConfig;
