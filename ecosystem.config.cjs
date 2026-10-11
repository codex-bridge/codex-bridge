module.exports = {
  apps: [
    {
      name: "codex-bridge",
      cwd: __dirname,
      script: "src/index.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      autorestart: true,
      restart_delay: 3000,
      max_memory_restart: "1G",
      max_restarts: 50,
      watch: false,
      time: true,
      env: {
        DOTENV_CONFIG_PATH: ".env.bridge",
        BRIDGE_LOG_INSTANCE: "main",
        BRIDGE_DB_FILE: "./workspaces/bridge.sqlite",
        PM2_APP_NAME: "codex-bridge"
      },
      out_file: "./workspaces/logs/pm2-bridge-out.log",
      error_file: "./workspaces/logs/pm2-bridge-error.log",
      merge_logs: true
    }
  ]
};
