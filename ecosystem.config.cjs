/**
 * PM2 — run from repo root after `npm run build`.
 *   pm2 start ecosystem.config.cjs          # start BOTH processes
 *   pm2 logs laser-helius                   # bot logs
 *   pm2 logs laser-dashboard                # dashboard logs
 *   pm2 reload laser-helius                 # hot reload bot
 *   pm2 stop laser-dashboard                # stop UI only; trading keeps running
 */
module.exports = {
  apps: [
    {
      name: "laser-helius",
      script: "dist/main.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      kill_timeout: 30_000,
      time: true,
      merge_logs: true,
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: { NODE_ENV: "production" },
    },
    {
      // Dashboard — static HTML + API reverse proxy. Runs in its own process
      // so dashboard HTTP handling NEVER competes with the bot's hot path.
      name: "laser-dashboard",
      script: "dashboard/server.cjs",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      kill_timeout: 5_000,
      time: true,
      merge_logs: true,
      error_file: "./logs/dashboard-error.log",
      out_file: "./logs/dashboard-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
        DASHBOARD_PORT: "3000",
        DASHBOARD_BIND: "0.0.0.0",
        CONTROL_API_HOST: "127.0.0.1",
        CONTROL_API_PORT: "9092",
        // If CONTROL_API_TOKEN is set in the bot's .env, mirror it here:
        // CONTROL_API_TOKEN: "same-token",
      },
    },
  ],
};
