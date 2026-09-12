export type PeerRole = 'host' | 'guest';

export type ClientSignalingMessage = { type: 'signal'; data: unknown } | { type: 'ping' };

export type ServerSignalingMessage =
  | { type: 'assigned_role'; role: PeerRole; roomId: string }
  | { type: 'peer_joined'; role: PeerRole }
  | { type: 'peer_left'; role: PeerRole }
  | { type: 'signal'; data: unknown }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

export interface Env {
  ROOM_DO: DurableObjectNamespace;
}

export interface WebSocketAttachment {
  role: PeerRole;
  roomId: string;
}
