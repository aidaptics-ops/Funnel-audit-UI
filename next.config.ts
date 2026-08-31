import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives beside the Funnel Audit API in one repository. Without this
  // Next walks up and picks the API's lockfile as the workspace root.
  turbopack: { root: path.resolve(__dirname) },
  outputFileTracingRoot: path.resolve(__dirname),
  /*
   * Emits .next/standalone with a minimal server.js and only the node_modules
   * actually reached. That is what keeps the Docker image small enough to
   * rebuild quickly on every push, and it is why the runtime stage installs
   * nothing at all.
   */
  output: "standalone",
  // The seed email library and the derived profile are read at runtime rather
  // than imported, so tracing does not discover them on its own. Without this
  // they are missing from the serverless bundle and a deployed instance has
  // neither voice samples nor a profile.
  outputFileTracingIncludes: { "/api/**": ["./seed/**"] },
};

export default nextConfig;
