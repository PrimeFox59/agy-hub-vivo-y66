module.exports = {
  apps: [
    {
      name: 'agy-project-manager',
      cwd: './agy-project-manager',
      script: 'server.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: 5678
      },
      watch: false,
      max_memory_restart: '300M'
    },
    {
      name: 'agy-telegram-bot',
      cwd: './agy-telegram-bot',
      script: 'bot.py',
      interpreter: 'python3',
      watch: false,
      max_memory_restart: '200M'
    }
  ]
};
