// Ephemeral room-match communication, deliberately independent of Match and its result replay.
import { randomBytes } from 'node:crypto';
import { ERR, MAX_SEATS, NAME_MAX_LEN } from '../shared/constants.js';
import { CHAT_LIMITS, chatTextLength, normalizeChatText } from '../shared/matchChat.js';
import { TokenBucket } from './net.js';

/** @typedef {{ seq: number, playerId: string, name: string, seat: number|null, spectator: boolean, text: string, at: number }} ChatEntry */
/** @typedef {{ playerId: string, name: string, seat: number|null, spectator: boolean }} ChatSender */

export class MatchChat {
  /** @param {{ now?: () => number, historyLimit?: number }} [opts] */
  constructor({ now = Date.now, historyLimit = CHAT_LIMITS.history } = {}) {
    if (typeof now !== 'function') throw new TypeError('invalid chat clock');
    if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > CHAT_LIMITS.history) {
      throw new RangeError('invalid chat history limit');
    }
    this.now = now;
    this.historyLimit = historyLimit;
    // Independent of room code/number: even a reused code cannot accept a prior match's queued chat intent.
    this.matchId = `chat_${randomBytes(12).toString('hex')}`;
    this.seq = 0;
    this.closed = false;
    /** @type {ChatEntry[]} */ this.messages = [];
    /** @type {Map<string, TokenBucket>} */ this.players = new Map();
    this.roomBucket = new TokenBucket(10, 20, this.now());
  }

  /**
   * Sender comes from Lobby's authoritative membership, never the request body. Permissions are Lobby's concern.
   * @param {ChatSender} sender @param {unknown} rawText
   */
  append(sender, rawText) {
    if (this.closed) return { error: ERR.WRONG_PHASE, detail: 'chat match has ended' };
    if (!sender || typeof sender.playerId !== 'string' || !sender.playerId.length || sender.playerId.length > 64
      || typeof sender.name !== 'string' || !sender.name.length || chatTextLength(sender.name) > NAME_MAX_LEN
      || typeof sender.spectator !== 'boolean'
      || (sender.spectator ? sender.seat !== null : !Number.isInteger(sender.seat) || sender.seat < 0 || sender.seat >= MAX_SEATS)) {
      return { error: ERR.BAD_TARGET, detail: 'invalid chat sender' };
    }
    const text = normalizeChatText(rawText);
    if (text === null) return { error: ERR.BAD_MSG, detail: 'invalid chat text' };
    const at = this.now();
    let bucket = this.players.get(sender.playerId);
    if (!bucket) { bucket = new TokenBucket(0.5, 3, at); this.players.set(sender.playerId, bucket); }
    if (!bucket.take(at) || !this.roomBucket.take(at)) return { error: ERR.RATE, detail: 'chat too often' };
    const entry = Object.freeze({ seq: ++this.seq, playerId: sender.playerId, name: sender.name, seat: sender.seat,
      spectator: sender.spectator, text, at });
    this.messages.push(entry);
    if (this.messages.length > this.historyLimit) this.messages.shift();
    return { message: { t: 'm.chat', matchId: this.matchId, ...entry } };
  }

  /** One bounded history frame at match start/resync, never attached to repeated public/room snapshots. */
  snapshot() {
    return this.closed ? null : { t: 'm.chatState', matchId: this.matchId, seq: this.seq, messages: this.messages.slice() };
  }

  /** A permanent departure, not a temporary disconnect, can release its sender budget. */
  forgetPlayer(playerId) { this.players.delete(playerId); }

  /** End, failed start or room destruction: release every body and sender budget, with no I/O or timers. */
  clear() {
    this.closed = true;
    this.messages.length = 0;
    this.players.clear();
    this.seq = 0;
  }
}
