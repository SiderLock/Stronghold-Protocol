// Waiting-room seat exchanges. Host authority follows identity; live battle seats never move.
import { ERR, MAX_SEATS } from '../shared/constants.js';

// [ASSUMED] A consent request lasts 30 seconds; each player participates in at most one at a time.
export const SEAT_REQUEST_MS = 30000;
const OK = Object.freeze({ ok: true });
const fail = (error) => ({ error });

export function clearSeatRequests(room) {
  clearTimeout(room.seatRequestTimer);
  room.seatRequestTimer = null;
  room.seatRequests = [];
}

/** Recheck identities and positions, including disconnects, departures and expiry. */
export function pruneSeatRequests(lobby, room) {
  clearTimeout(room.seatRequestTimer);
  room.seatRequestTimer = null;
  room.seatRequests = room.seatRequests.filter((r) => !room.match && !room.disposed && r.expiresAt > lobby.now()
    && [ [r.fromSeat, r.fromId], [r.toSeat, r.toId] ].every(([index, id]) => {
      const seat = room.seats[index];
      return seat?.playerId === id && !seat.isBot && !seat.left && seat.connected;
    }));
  if (room.seatRequests.length) {
    const wait = Math.max(1, Math.min(...room.seatRequests.map((r) => r.expiresAt)) - lobby.now());
    room.seatRequestTimer = setTimeout(() => lobby.broadcastState(room), wait);
    room.seatRequestTimer.unref?.();
  }
}

function exchange(lobby, room, from, toIndex) {
  const target = room.seats[toIndex];
  const oldIndex = from.seat;
  room.seats[toIndex] = from;
  room.seats[oldIndex] = target;
  from.seat = toIndex;
  if (target) target.seat = oldIndex;
  lobby.dropReplay(room, from.playerId);
  if (target && !target.isBot) lobby.dropReplay(room, target.playerId);
  lobby.broadcastState(room);
  return OK;
}

export function requestSeat(lobby, session, { seat, playerId }) {
  const room = lobby.roomOf(session);
  if (!room) return fail(ERR.NOT_IN_ROOM);
  if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
  if (room.match) return fail(ERR.ROOM_STARTED);
  const from = room.seatOf(session.playerId);
  if (room.mode !== 'coop' || !from?.connected || from.isBot || from.left || !session.connected
    || !Number.isInteger(seat) || seat < 0 || seat >= Math.min(room.capacity, MAX_SEATS) || seat === from.seat) return fail(ERR.BAD_TARGET);
  const target = room.seats[seat];
  if ((target?.playerId ?? null) !== playerId || target?.left) return fail(ERR.BAD_TARGET);
  pruneSeatRequests(lobby, room);
  if (!target || target.isBot) return exchange(lobby, room, from, seat);
  const targetSession = lobby.registry.byId(target.playerId);
  if (!target.connected || !targetSession?.connected || targetSession.roomCode !== room.code) return fail(ERR.BAD_TARGET);
  const involved = new Set([from.playerId, target.playerId]);
  if (room.seatRequests.some((r) => involved.has(r.fromId) || involved.has(r.toId))) return fail(ERR.ALREADY);
  room.seatRequests.push({ id: `swap_${room.directoryId}_${++room.seatRequestSeq}`, fromId: from.playerId, toId: target.playerId,
    fromSeat: from.seat, toSeat: seat, expiresAt: lobby.now() + SEAT_REQUEST_MS });
  lobby.broadcastState(room);
  return OK;
}

export function answerSeat(lobby, session, { requestId, accept }) {
  const room = lobby.roomOf(session);
  if (!room) return fail(ERR.NOT_IN_ROOM);
  if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
  if (room.match) return fail(ERR.ROOM_STARTED);
  pruneSeatRequests(lobby, room);
  const request = room.seatRequests.find((r) => r.id === requestId);
  if (!request || (request.toId !== session.playerId && (accept || request.fromId !== session.playerId))) return fail(ERR.BAD_TARGET);
  if (!session.connected || typeof accept !== 'boolean') return fail(ERR.BAD_TARGET);
  room.seatRequests = room.seatRequests.filter((r) => r !== request);
  if (accept) return exchange(lobby, room, room.seatOf(request.fromId), request.toSeat);
  lobby.broadcastState(room);
  return OK;
}
