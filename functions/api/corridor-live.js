import { handleCorridorLive } from '../../worker/handlers.js';
export const onRequest = ({ request, env }) => handleCorridorLive(request, env);
