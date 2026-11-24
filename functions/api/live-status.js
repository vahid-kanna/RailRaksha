import { handleLiveStatus } from '../../worker/handlers.js';
export const onRequest = ({ request, env }) => handleLiveStatus(request, env);
