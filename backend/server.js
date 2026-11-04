"use strict";
/** Bootstrap is deliberately separate from request handling: migrations must finish
 * before readiness succeeds, and failed connections retry with bounded backoff.
 * Production credentials come from Secrets Manager via the EC2 instance role. */
const { loadConfig, connect } = require("./lib/db");
const { createApp } = require("./lib/app");
let server;
let stopping = false;
const state = { pool: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function start() {
  let config;
  for (let attempt = 0; !stopping; attempt++) {
    try {
      config = await loadConfig();
      break;
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "configuration_unavailable",
          code: e.code || e.name,
        }),
      );
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
    }
  }
  if (stopping) return;
  const app = createApp(state, config);
  server = app.listen(Number(process.env.PORT || 5000), "0.0.0.0", () =>
    console.log(
      JSON.stringify({
        event: "listening",
        port: Number(process.env.PORT || 5000),
      }),
    ),
  );
  server.on("error", (e) => {
    console.error(JSON.stringify({ event: "listen_failed", code: e.code }));
    process.exitCode = 1;
    stopping = true;
  });
  for (let attempt = 0; !stopping && !state.pool; attempt++) {
    try {
      Object.assign(config, await loadConfig());
      state.pool = await connect(config);
      state.pool.on("error", () => {});
      console.log(JSON.stringify({ event: "database_ready" }));
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "database_unavailable",
          code: e.code || e.name,
        }),
      );
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
    }
  }
  // Periodically refresh Secrets Manager credentials so managed RDS password
  // rotation is adopted without embedding passwords in user data or the AMI.
  let refreshing = false,
    lastRefresh = Date.now();
  const monitor = setInterval(async () => {
    if (stopping || refreshing) return;
    refreshing = true;
    try {
      if (state.pool) await state.pool.request().query("SELECT 1 AS alive");
      if (!state.pool || Date.now() - lastRefresh > 300000) {
        const fresh = await loadConfig(),
          replacement = await connect(fresh),
          old = state.pool;
        replacement.on("error", () => {});
        state.pool = replacement;
        Object.assign(config, fresh);
        lastRefresh = Date.now();
        if (old) await old.close();
      }
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "database_refresh_failed",
          code: e.code || e.name,
        }),
      );
      if (state.pool && !state.pool.connected) {
        await state.pool.close().catch(() => {});
        state.pool = null;
      }
    } finally {
      refreshing = false;
    }
  }, 30000);
  monitor.unref();
}
async function stop() {
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 30000);
  timer.unref();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (state.pool) await state.pool.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
if (require.main === module)
  start().catch((e) => {
    console.error(
      JSON.stringify({ event: "startup_failed", code: e.code || e.name }),
    );
    process.exitCode = 1;
  });
module.exports = { start };
