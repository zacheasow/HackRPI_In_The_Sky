module.exports = {
  apps: [
    {
      name: "in-the-clouds",
      script: "server/index.js",
      env: {
        PORT: 3000,
        NODE_ENV: "production",
      },
    },
  ],
};
