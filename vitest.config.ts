import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Miniflare logs every failed Workflow step attempt and forced event timeout as "uncaught exception",
// even when the step's retries or the Workflow's own catch handle it. Those lines are expected in the
// retry and timeout tests; only failed tests count.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          HF_KEY: "test-id:test-secret",
          // base64 of "test-webhook-secret"
          HF_WEBHOOK_SECRET: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==",
          R2_ACCESS_KEY_ID: "test-access-key",
          R2_SECRET_ACCESS_KEY: "test-secret-key",
          RESULT_HOSTS: "results.example.com,cdn.higgsfield.ai",
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
