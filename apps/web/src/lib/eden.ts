import { treaty } from '@elysiajs/eden';
import type { App } from '@alfred/api';

const API_URL = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL ?? 'http://localhost:3001';

export const client = treaty<App>(API_URL);
