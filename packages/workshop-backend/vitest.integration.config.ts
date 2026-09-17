import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";

const { kCurrentWorker } = createRequire(import.meta.resolve("@cloudflare/vitest-pool-workers"))("miniflare");

const EXPECTED_OPEN_ERROR_CODES = new Set([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ACCESS_DENIED",
]);

export default defineConfig({
  esbuild: {
    target: "es2022",
  },
  plugins: [
    capnwebValidate({ tsconfig: "__integration__/tsconfig.json" }),
    cloudflareTest({
      main: "./__integration__/worker.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        durableObjects: {
          SCHEDULE_DRIVER: { className: "ScheduleDriver", useSQLite: true },
          SCHEDULER_FACET: { className: "SchedulerGatekeeper", useSQLite: true },
        },
        serviceBindings: {
          GATEKEEPER_SCHEDULER: { name: kCurrentWorker, entrypoint: "SchedulerVendor" },
          COMPUTER_RUNTIME: { name: kCurrentWorker, entrypoint: 'TestComputerRuntime' },
        },
      },
    }),
  ],
  test: {
    include: ["__integration__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../scripts/assert-workerd.ts"],
    // Whichever test runs first pays for workerd booting and instantiating the whole backend
    // bundle -- ~6s on a dev machine and roughly 3x that on a CI runner, while every subsequent
    // test in the file finishes in tens of milliseconds. The timeout has to clear that cold
    // start, not the steady-state cost, or the first test fails wherever the runner is slow.
    testTimeout: 60_000,
    // A rejected future capability is reported independently from the awaited pipelined call.
    // The tests assert these exact rejections; all unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      const code = "code" in error ? error.code : undefined;
      // The seed rollback test asserts this rejected Cap'n Web future.
      if (error.message === "A seed references an unavailable model. Add it in Providers first.") return false;
      if (typeof code === "string" && EXPECTED_OPEN_ERROR_CODES.has(code)) return false;
      // Browser tests assert these denials; Cap'n Web also reports their rejected futures.
      if (error.message === "Browser access is disabled; the owner must explicitly enable it" ||
          error.message === "Browser access requires the agent's dedicated workspace" ||
          error.message === "Browser control is owner-only" ||
          error.message === "Agent browser access is blocked because this workspace has observed sensitive data" ||
          error.message === "Switch browser control to human before manual interaction") return false;
      // Secret-entry tests assert both denials; rejected Cap'n Web futures are also reported here.
      if (error.message === "Secret entry is owner-only" ||
          error.message === "This secret request is no longer available") return false;
      // The separate workspace grant tests assert these exact failures over the root RPC bridge.
      if (error.message === 'Computer shell and files are disabled') return false;
      // The routine failure tests assert these exact rejections over Cap'n Web as well.
      if (error.message === "Routine changed during update. Reload and retry." ||
          error.message === "Scheduler gatekeeper not available" ||
          error.message === "Invalid IANA timezone: Invalid/Zone" ||
          error.message === "routine test: registration response lost" ||
          error.message === "routine test: activation response lost") return false;
      // The reset-recovery tests abort every Durable Object mid-session; capabilities that were
      // held across the abort (e.g. the fire-and-forget AdminSettings install kicked off by the
      // fetch handler) reject on their own schedule, independent of any awaited call.
      if (error.message?.includes("abortAllDurableObjects")) return false;
      // Same, for the test that aborts only the user DO (state.abort with this reason).
      if (error.message?.includes("user-DO reset injected by test")) return false;
    },
  },
});
