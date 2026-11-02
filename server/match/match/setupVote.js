// INFO_CHECK full setup reroll: unanimous human consent, keeping the room and player settings.
// [ASSUMED] Remake convenience, not official mode rules (DESIGN §28.21): the unanimous human vote, the INFO_CHECK
// timer paused during the vote and resumed with its remaining time, the independent reroll stream; and (PR #860) any
// seated player may open or cancel the vote, each seat may open one every 30 s, a completed reroll opens a fresh window
// (a cancelled or rejected vote does not give the cooldown back); a connection's starts also draw from its heavy bucket.
// Installed on Match.prototype like the other method containers. The lobby only refuses spectators and absent seats.
import { PHASE, ERR, SETUP_REROLL_COOLDOWN_MS as REROLL_COOLDOWN_MS } from '../../../shared/constants.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { setupMatchWaves } from '../waves.js';
import { drawDisabledBonds, createPoolGroups } from '../pool.js';
import { OK, fail } from './common.js';

/** One 申请重刷 per player per 30 s: a host who ignored or refused it cannot be pinged in a loop. */
const ASK_COOLDOWN_MS = 30_000;
// One start per seat per cooldown: the vote freezes the INFO_CHECK countdown, so an endless restart loop would stall
// the opening. A completed reroll starts a new opening and therefore a new window. (SETUP_REROLL_COOLDOWN_MS, 30 s, lives
// in shared/constants.js so the client's refusal toast names the same value.) With one human every start completes at
// once and clears the seat cooldown, so the throttle there is the connection's heavy bucket: room.rerollSetup is in
// server/net.js HEAVY_TYPES (2 per second, burst 6), as each reroll rebuilds the opening and resends m.public (DESIGN §35.47).

export class MatchSetupVote {
  requestSetupReroll(playerId, revision) {
    if (this.emergencyFrozen) return fail(ERR.SERVER_EMERGENCY);
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
    if (revision !== this.setupRevision) return fail(ERR.BAD_TARGET, 'setup revision changed');
    if (this.setupVote) return fail(ERR.WRONG_PHASE, 'setup reroll vote in progress');
    const humans = this.humans();
    if (humans.some((p) => !p.connected)) return fail(ERR.NOT_READY, 'all humans must be connected to vote');
    const now = this.sched.now();
    const last = this._rerollStartAt.get(playerId);
    if (last !== undefined && now - last < REROLL_COOLDOWN_MS) return fail(ERR.RATE, 'setup reroll cooldown');
    this._rerollStartAt.set(playerId, now);
    this.setupVote = {
      id: ++this._setupVoteSeq,
      proposerId: playerId,
      voters: humans.map((p) => p.playerId),
      agreed: new Set([playerId]),
      remainingMs: this.deadline > 0 ? Math.max(1, this.deadline - now) : 0,
    };
    this.cancel(this._infoAdvanceTimer);
    this._infoAdvanceTimer = null;
    this.setDeadline(0);
    if (humans.length === 1) return this.completeSetupReroll();
    this._rerollAsks.clear();
    this.markPublic();
    this.flush(true);
    return OK;
  }

  /**
   * Legacy 申请重刷 (GitHub #854): only records an ask for older clients, without opening a vote.
   * Current clients let every seated human call requestSetupReroll directly (fork D018 / D041).
   */
  askSetupReroll(playerId, revision) {
    if (this.emergencyFrozen) return fail(ERR.SERVER_EMERGENCY);
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
    if (revision !== this.setupRevision) return fail(ERR.BAD_TARGET, 'setup revision changed');
    if (this.setupVote) return fail(ERR.WRONG_PHASE, 'setup reroll vote in progress');
    const now = this.sched.now();
    const last = this._lastRerollAskAt.get(playerId);
    if (last !== undefined && now - last < ASK_COOLDOWN_MS) return fail(ERR.RATE);
    this._lastRerollAskAt.set(playerId, now);
    this._rerollAsks.set(playerId, now);
    this.markPublic();
    this.flush(true);
    return OK;
  }

  /** m.public.rerollRequests: connected humans asking for a reroll while no vote runs; [] once voting. */
  pendingRerollRequests() {
    if (this.setupVote || this.phase !== PHASE.INFO_CHECK) return [];
    const requests = [];
    for (const id of this._rerollAsks.keys()) {
      const ps = this.players.get(id);
      if (ps && !ps.isBot && ps.connected && !ps.left) requests.push({ playerId: id });
    }
    return requests;
  }

  voteSetupReroll(ps, voteId, agree) {
    if (this.phase !== PHASE.INFO_CHECK || !this.setupVote) return fail(ERR.WRONG_PHASE);
    const vote = this.setupVote;
    if (vote.id !== voteId) return fail(ERR.BAD_TARGET, 'setup vote changed');
    if (!ps.connected || !vote.voters.includes(ps.playerId)) return fail(ERR.NOT_IN_ROOM);
    if (!agree) { this.cancelSetupVote(); return OK; }
    vote.agreed.add(ps.playerId);
    if (vote.voters.every((id) => vote.agreed.has(id))) return this.completeSetupReroll();
    this.markPublic();
    this.flush(true);
    return OK;
  }

  cancelSetupReroll(playerId, voteId) {
    if (this.emergencyFrozen) return fail(ERR.SERVER_EMERGENCY);
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK || !this.setupVote) return fail(ERR.WRONG_PHASE);
    if (this.setupVote.id !== voteId) return fail(ERR.BAD_TARGET, 'setup vote changed');
    const ps = this.players.get(playerId);
    if (!ps || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
    this.cancelSetupVote();
    return OK;
  }

  cancelSetupVote() {
    const vote = this.setupVote;
    if (!vote) return;
    this.setupVote = null;
    this._rerollAsks.clear();
    if (this.phase === PHASE.INFO_CHECK && !this.disposed && !this.ended) {
      if (vote.remainingMs > 0) {
        this.deadline = this.sched.gameNow() + vote.remainingMs;
        this._phaseTimer = this.later(vote.remainingMs, () => {
          this._phaseTimer = null;
          this.enterBandDraft();
        });
      }
      this.maybeEndInfo();
      this.markPublic();
      this.flush(true);
    }
  }

  completeSetupReroll() {
    let prepared;
    try {
      const rng = createRng(deriveSeed(this.seed, `reroll-setup:${this.setupRevision + 1}`));
      const setup = setupMatchWaves(this.gd, rng);
      const stage = setup.stageId ? this.gd.stage(setup.stageId) : null;
      const bans = drawDisabledBonds(this.gd, rng);
      // Keep the opening seat groups and their scaled copies; every player's transactions use playerPools.
      const poolGroups = createPoolGroups(this.gd, this.order, { banned: bans.banned });
      if (!poolGroups.length || poolGroups.some((g) => !g.pool.entries.size)) throw new Error('rerolled chess pool is empty');
      const playerPools = new Map(poolGroups.flatMap((g) => g.playerIds.map((id) => [id, g.pool])));
      const off = new Set([...bans.drawn, ...bans.staticOff]);
      const stocks = this.order.map((ps) => ps.buildDiyStock(off));
      prepared = { setup, stage, bans, poolGroups, playerPools, stocks };
    } catch (e) {
      this.reportError('reroll setup', e);
      this.cancelSetupVote();
      return fail(ERR.INTERNAL);
    }
    // All data-dependent work succeeds before any opening or player state changes.
    const { setup, stage, bans, poolGroups, playerPools, stocks } = prepared;
    this.stageId = setup.stageId;
    this.stage = stage;
    this.factions = setup.factions;
    this.bossId = setup.bossId;
    this.hiddenBossId = setup.hiddenBossId;
    this.disabledBonds = bans.drawn;
    this.staticInactiveBonds = bans.staticOff;
    this.bannedChess = bans.banned;
    this.poolGroups = poolGroups;
    this.playerPools = playerPools;
    this.pool = poolGroups[0].pool;
    this._botPath = null;
    for (const [i, ps] of this.order.entries()) {
      ps.diyStock = stocks[i].stock;
      ps.diyBanned = stocks[i].banned;
      ps.invalidateDeployMap();
      ps.infoReady = ps.botControlled;
    }
    this.setupRevision++;
    this.setupVote = null;
    // A fresh opening deserves fresh requests: the asks were answered and the cooldown no longer applies.
    this._rerollAsks.clear();
    this._lastRerollAskAt.clear();
    // A completed reroll is a new opening, so every seat gets a fresh chance to ask for another one.
    this._rerollStartAt.clear();
    this.enterInfoCheck();
    return OK;
  }
}
