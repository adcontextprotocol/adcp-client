const fastify = require('fastify');

const app = fastify({ logger: true });

app.get('/', async () => {
  return { hello: 'world' };
});

const start = async () => {
  try {
    console.log('Starting server...');
    await app.listen({ port: 3002, host: 'localhost' });
    console.log('Server started on port 3002');
  } catch (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
};

start();