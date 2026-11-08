module.exports = {
  apps: [
    {
      name: "aerogami",
      script: "server/index.js",
      env: {
        PORT: 3000,
        NODE_ENV: "production",
      },
    },
  ],
};
