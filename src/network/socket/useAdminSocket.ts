'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { EV, type AdminCommand } from '@/network/protocol/events';
import { createSocket } from './socketClient';
import type { RoomPublicState } from '@/types';

export interface AdminSocketApi {
  connected: boolean;
  room: RoomPublicState | null;
  send(cmd: AdminCommand): void;
}

export function useAdminSocket(roomId: string): AdminSocketApi {
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomPublicState | null>(null);
  const socketRef = useRef<ReturnType<typeof createSocket> | null>(null);

  useEffect(() => {
    const socket = createSocket();
    socketRef.current = socket;
    socket.on('connect', () => {
      setConnected(true);
      socket.emit(EV.ADMIN_JOIN, { roomId });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on(EV.ROOM_STATE, (p: RoomPublicState) => setRoom(p));
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId]);

  const send = useCallback((cmd: AdminCommand) => {
    socketRef.current?.emit(EV.ADMIN_COMMAND, cmd);
  }, []);

  return { connected, room, send };
}
