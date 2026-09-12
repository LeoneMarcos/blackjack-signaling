import type { Env, PeerRole, WebSocketAttachment } from './types';

interface PairType {
  0: WebSocket;
  1: WebSocket;
}

function createWebSocketPair(): PairType {
  const WSPair = (globalThis as unknown as { WebSocketPair?: new () => PairType }).WebSocketPair;
  if (WSPair) return new WSPair();
  throw new Error('WebSocketPair is not defined in this environment.');
}

function createWebSocketResponse(client: WebSocket): Response {
  try {
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  } catch {
    const res = new Response(null, { status: 200 });
    Object.defineProperty(res, 'status', { value: 101 });
    Object.defineProperty(res, 'webSocket', { value: client });
    return res;
  }
}

function isValidSignalPayload(
  senderRole: PeerRole,
  data: unknown,
): { valid: true } | { valid: false; reason: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, reason: 'Signal data must be a JSON object.' };
  }

  const d = data as Record<string, unknown>;
  const type = d.type;

  if (type === 'offer') {
    if (senderRole !== 'host') {
      return { valid: false, reason: 'Role violation: Only host may initiate an offer.' };
    }
    const keys = Object.keys(d);
    if (!keys.every((k) => k === 'type' || k === 'sdp')) {
      return { valid: false, reason: 'Invalid fields on offer signal.' };
    }
    const sdpValid =
      typeof d.sdp === 'string' ||
      (typeof d.sdp === 'object' &&
        d.sdp !== null &&
        typeof (d.sdp as Record<string, unknown>).sdp === 'string');
    if (!sdpValid) return { valid: false, reason: 'Offer must include valid sdp.' };
    return { valid: true };
  }

  if (type === 'answer') {
    if (senderRole !== 'guest') {
      return { valid: false, reason: 'Role violation: Only guest may reply with an answer.' };
    }
    const keys = Object.keys(d);
    if (!keys.every((k) => k === 'type' || k === 'sdp')) {
      return { valid: false, reason: 'Invalid fields on answer signal.' };
    }
    const sdpValid =
      typeof d.sdp === 'string' ||
      (typeof d.sdp === 'object' &&
        d.sdp !== null &&
        typeof (d.sdp as Record<string, unknown>).sdp === 'string');
    if (!sdpValid) return { valid: false, reason: 'Answer must include valid sdp.' };
    return { valid: true };
  }

  if (type === 'candidate') {
    const keys = Object.keys(d);
    if (!keys.every((k) => k === 'type' || k === 'candidate')) {
      return { valid: false, reason: 'Invalid fields on candidate signal.' };
    }
    const c = d.candidate;
    const candidateValid =
      c === null || typeof c === 'string' || (typeof c === 'object' && c !== null);
    if (!candidateValid) {
      return {
        valid: false,
        reason: 'Candidate signal must include valid candidate object or null.',
      };
    }
    return { valid: true };
  }

  return { valid: false, reason: `Unsupported signal type: ${String(type)}` };
}

export class RoomDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const roomId = (
      url.searchParams.get('roomId') ||
      url.pathname.split('/')[2] ||
      'UNKNOWN'
    ).toUpperCase();
    const intent = url.searchParams.get('intent')?.toLowerCase();

    const existingSockets = this.state.getWebSockets();
    if (existingSockets.length >= 2) {
      const pair = createWebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server);
      server.send(
        JSON.stringify({
          type: 'error',
          code: 'room_full',
          message: `Room ${roomId} is full (maximum 2 players).`,
        }),
      );
      server.close(4001, 'Room full');
      return createWebSocketResponse(client as unknown as WebSocket);
    }

    const hosts = this.state.getWebSockets('host');

    if (intent === 'join' && hosts.length === 0) {
      const pair = createWebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server);
      server.send(
        JSON.stringify({
          type: 'error',
          code: 'invalid_room',
          message: `Room ${roomId} does not exist or has no active host.`,
        }),
      );
      server.close(4004, 'Room not found');
      return createWebSocketResponse(client as unknown as WebSocket);
    }

    if (intent === 'create' && hosts.length > 0) {
      const pair = createWebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server);
      server.send(
        JSON.stringify({
          type: 'error',
          code: 'room_full',
          message: `Room ${roomId} already has an active host.`,
        }),
      );
      server.close(4009, 'Room already exists');
      return createWebSocketResponse(client as unknown as WebSocket);
    }

    const role: PeerRole =
      intent === 'create'
        ? 'host'
        : intent === 'join'
          ? 'guest'
          : hosts.length === 0
            ? 'host'
            : 'guest';

    const pair = createWebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server, [role]);
    const attachment: WebSocketAttachment = { role, roomId };
    server.serializeAttachment(attachment);

    server.send(
      JSON.stringify({
        type: 'assigned_role',
        role,
        roomId,
      }),
    );

    if (role === 'guest') {
      for (const host of hosts) {
        host.send(JSON.stringify({ type: 'peer_joined', role: 'guest' }));
      }
      server.send(JSON.stringify({ type: 'peer_joined', role: 'host' }));
    }

    return createWebSocketResponse(client as unknown as WebSocket);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const rawAttachment = ws.deserializeAttachment();
    const attachment = rawAttachment as WebSocketAttachment | null;

    if (!attachment) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'unauthorized',
          message: 'Missing socket attachment session.',
        }),
      );
      return;
    }

    let parsed: unknown;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text);
    } catch {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'malformed_json',
          message: 'Could not parse incoming WebSocket message as JSON.',
        }),
      );
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'invalid_payload',
          message: 'Message payload must be a JSON object.',
        }),
      );
      return;
    }

    const payload = parsed as Record<string, unknown>;

    if (payload.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (payload.type !== 'signal') {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'invalid_signaling_type',
          message:
            'Only signaling messages are permitted over this transport. Gameplay uses WebRTC RTCDataChannel.',
        }),
      );
      return;
    }

    const validation = isValidSignalPayload(attachment.role, payload.data);
    if (!validation.valid) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'invalid_signal',
          message: validation.reason,
        }),
      );
      return;
    }

    const targetRole: PeerRole = attachment.role === 'host' ? 'guest' : 'host';
    const targetPeers = this.state.getWebSockets(targetRole);

    if (targetPeers.length === 0) {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'peer_not_connected',
          message: `Peer (${targetRole}) is not connected yet.`,
        }),
      );
      return;
    }

    for (const peer of targetPeers) {
      peer.send(
        JSON.stringify({
          type: 'signal',
          data: payload.data,
        }),
      );
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const rawAttachment = ws.deserializeAttachment();
    const attachment = rawAttachment as WebSocketAttachment | null;
    if (!attachment) return;

    const targetRole: PeerRole = attachment.role === 'host' ? 'guest' : 'host';
    const otherPeers = this.state.getWebSockets(targetRole);

    for (const peer of otherPeers) {
      peer.send(
        JSON.stringify({
          type: 'peer_left',
          role: attachment.role,
        }),
      );
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
