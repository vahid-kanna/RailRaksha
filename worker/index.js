/**
 * RailRaksha — Cloudflare Worker Entrypoint v8.0 (worker/index.js)
 */

import { handleHealth, handleChat, handleLiveStatus, handleCorridorLive } from './handlers.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/health')        return handleHealth(request, env);
    if (path === '/api/chat')          return handleChat(request, env);
    if (path === '/api/corridor-live') return handleCorridorLive(request, env);
    if (path === '/api/live-status')   return handleLiveStatus(request, env);

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404 });
  },
};
