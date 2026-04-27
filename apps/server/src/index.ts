import { cors } from '@elysiajs/cors';
import { node } from '@elysiajs/node';
import { app, closeConnections, warmPool, initEventBridge, closeEventBridge, closeRedis } from '@alfred/api';
import { serverEnv } from '@alfred/env/server';
import { Elysia } from 'elysia';

await warmPool();
await initEventBridge();

const server = new Elysia({ adapter: node() })
  .use(
    cors({
      origin: serverEnv().CORS_ORIGIN,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    }),
  )
  .use(app)
  .listen({ port: 3001 }, () => {
    console.log('Alfred server running on http://localhost:3001');
  });

async function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down...`);
  await server.stop();
  try {
    await closeEventBridge();
    await closeRedis();
    console.log('Redis closed');
  } catch (err) {
    console.error('Error closing Redis:', err instanceof Error ? err.message : String(err));
  }
  try {
    await closeConnections();
    console.log('DB pool closed');
  } catch (err) {
    console.error('Error closing DB:', err instanceof Error ? err.message : String(err));
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
