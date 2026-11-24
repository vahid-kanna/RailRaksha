import { handleChat } from '../../worker/handlers.js';
export const onRequest = ({ request, env }) => handleChat(request, env);
