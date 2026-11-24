import { handleHealth } from '../../worker/handlers.js';
export const onRequest = ({ request, env }) => handleHealth(request, env);
