module.exports = {
  apps: [
    {
      name: "coin-flip",
      script: "dist/server/server/index.js",
      cwd: "/var/www/coin-flip/current",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: "4123"
      }
    }
  ]
};
