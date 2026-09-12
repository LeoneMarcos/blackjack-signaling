import { RoomDO } from './room-do';
import type { Env } from './types';

export { RoomDO };

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Upgrade',
};

function parseRoomId(url: URL): string | null {
  const queryRoom = url.searchParams.get('roomId') || url.searchParams.get('room');
  if (queryRoom) return queryRoom;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'room' && parts[1]) return parts[1];
  if (parts[0] === 'ws' && parts[1]) return parts[1];
  return null;
}

export function isValidRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9]{3,12}$/.test(roomId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'ok', service: 'blackjack-signaling' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    const rawRoomId = parseRoomId(url);
    if (!rawRoomId || !isValidRoomId(rawRoomId)) {
      return new Response(
        JSON.stringify({
          error: 'invalid_room_id',
          message: 'Room code must be 3-12 alphanumeric characters.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        },
      );
    }

    const normalizedRoomId = rawRoomId.trim().toUpperCase();
    const doId = env.ROOM_DO.idFromName(normalizedRoomId);
    const roomStub = env.ROOM_DO.get(doId);

    const response = await roomStub.fetch(request);
    const responseHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      if (!responseHeaders.has(key)) responseHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      webSocket: response.webSocket,
    });
  },
};
