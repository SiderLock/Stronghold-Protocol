// Presentational lobby discovery controls; admission and ranking are decided by the server.
import { ROOM_CAPACITIES, MAX_SPECTATORS } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';
import { html, Button, Icon, MicroLabel, Spinner, DifficultyTag, Modal } from './components.js';

export function LobbyOnlinePill({ count, connected }) {
  return html`<span class=${`lobby-online${connected ? '' : ' is-offline'}`} data-testid="lobby-online"
      title=${t('在线人数为当前已连接的人类玩家，不含 AI。')} aria-label=${t('服务器在线人数')}>
    <${Icon} name="users" /><span>${t('在线 {n}', { n: connected && count != null ? count : '—' })}</span>
  </span>`;
}

export function LobbyRoomRow({ room, onJoin, onSpectate, busy, connected }) {
  const retained = room.disconnectedRetained === true;
  const coop = room.mode === 'coop';
  const allowed = room.allowMatchmaking !== false;
  // An opaque directory id is used for admission. Private invite codes never become DOM attributes or keys.
  const roomId = typeof room.roomId === 'string' && room.roomId ? room.roomId : null;
  const code = allowed && typeof room.code === 'string' && room.code ? room.code : null;
  const spectatorCount = Number.isInteger(room.spectatorCount) && room.spectatorCount >= 0 ? room.spectatorCount : 0;
  const spectatorsFull = spectatorCount >= MAX_SPECTATORS;
  const state = room.inMatch ? t('进行中') : !coop ? t('独立模拟')
    : room.playerCount >= room.capacity ? t('房间已满') : room.joinable ? t('等候加入') : t('等候中');
  const privateHint = t('房主已关闭公开匹配，仅能通过邀请码加入。');
  return html`<div class=${`lobby-directory__room${retained ? ' is-retained' : room.inMatch ? ' is-match' : ''}`} data-room-id=${roomId}
      ...${code ? { 'data-room-code': code } : {}}>
    <div class="lobby-directory__room-main">
      ${code ? html`<span class="lobby-directory__room-code num" title=${t('房间号')}>${code}</span>`
        : html`<span class="lobby-directory__hidden-code" title=${privateHint}>${t('邀请码已隐藏')}</span>`}
      <span class="lobby-directory__room-mode">${room.mode === 'solo' ? t('独立房间') : t('同盟模拟')}</span>
      <${DifficultyTag} difficulty=${room.difficulty} size="sm" />
    </div>
    <div class="lobby-directory__room-meta">
      <span class=${`lobby-directory__status${room.inMatch ? ' is-match' : ''}`}>${state}</span>
      <span class="num">${t('{used} / {capacity} 席', { used: room.playerCount, capacity: room.capacity })}</span>
      <span class="lobby-directory__people">${t('{n} 个真人', { n: room.humanCount })}${room.botCount > 0 ? ` · ${t('{n} 个 AI', { n: room.botCount })}` : ''}</span>
      ${coop && !allowed ? html`<span class="lobby-directory__private" title=${privateHint}>${t('禁止匹配')}</span>` : null}
      ${retained ? html`<span class="lobby-directory__offline" title=${t('断线保留房间等待原玩家重连，按对应断线期限自动释放。')}>${t('断线保留')}</span>`
        : room.hostOnline === false ? html`<span class="lobby-directory__offline">${t('房主离线')}</span>` : null}
    </div>
    ${coop ? html`<div class="lobby-directory__actions">
      ${room.inMatch ? null : html`<${Button} variant="secondary" size="sm" iconRight="chevronRight"
        class="lobby-directory__join" title=${allowed ? null : privateHint}
        disabled=${!!busy || !connected || !roomId || !allowed || !room.joinable} onClick=${() => onJoin(roomId)}>${t('加入房间')}<//>`}
      <${Button} variant="secondary" size="sm" icon="eye" class="lobby-directory__spectate"
        title=${t('观战席 {used} / {capacity}', { used: spectatorCount, capacity: MAX_SPECTATORS })}
        disabled=${!!busy || !connected || !roomId || room.spectatable !== true || spectatorsFull}
        onClick=${() => onSpectate(roomId)}>${spectatorsFull ? t('观战席已满') : t('观战')}<//>
    </div>` : null}
  </div>`;
}

export function LobbyRoomList({ state, connected, onClose, onRefresh, onPage, onJoin, onSpectate, busy }) {
  const pages = Math.max(1, Number(state.totalPages) || 1);
  const page = Math.min(pages - 1, Number(state.page) || 0);
  const actions = html`<div class="lobby-directory__footer">
    <div class="lobby-directory__pager">
      <${Button} variant="secondary" size="sm" icon="chevronLeft" disabled=${page <= 0 || state.loading || !connected} onClick=${() => onPage(page - 1)}>${t('上一页')}<//>
      <span class="num">${t('第 {page} / {pages} 页', { page: page + 1, pages })}</span>
      <${Button} variant="secondary" size="sm" iconRight="chevronRight" disabled=${page >= pages - 1 || state.loading || !connected} onClick=${() => onPage(page + 1)}>${t('下一页')}<//>
    </div>
    <${Button} variant="primary" size="sm" onClick=${onClose}>${t('关闭')}<//>
  </div>`;
  return html`<${Modal} open=${state.open} title=${t('房间列表')} micro="ROOM DIRECTORY" tone="mint" onClose=${onClose}
      width="min(11.8rem, 94vw)" class="lobby-directory" actions=${actions}>
    <div class="lobby-directory__note"><span>${t('房间列表实时更新')}</span>
      <${Button} variant="secondary" size="sm" icon="refresh" disabled=${state.loading || !connected} onClick=${onRefresh}>${state.error ? t('重试') : t('刷新')}<//>
    </div>
    ${state.rooms.some((room) => room.disconnectedRetained === true)
      ? html`<p class="lobby-directory__retained-note">${t('断线保留房间等待原玩家重连，按对应断线期限自动释放。')}</p>` : null}
    ${!connected ? html`<div class="lobby-directory__empty" role="status">${t('尚未连接到服务器，请稍候')}</div>`
      : state.error ? html`<div class="lobby-directory__empty is-error" role="alert">${t('无法获取房间列表，请重试。')}</div>`
      : state.loading && !state.rooms.length ? html`<div class="lobby-directory__empty" role="status"><${Spinner} size="sm" label=${t('正在获取房间列表…')} /></div>`
      : state.rooms.length ? html`<div class="lobby-directory__rooms">${state.rooms.map((room) => html`<${LobbyRoomRow} key=${room.roomId} room=${room} onJoin=${onJoin} onSpectate=${onSpectate} busy=${busy} connected=${connected} />`)}</div>`
      : html`<div class="lobby-directory__empty">${t('当前没有房间，可以创建同盟邀请好友。')}</div>`}
  <//>`;
}

export function LobbyDiscoveryPanel({ state, capacity, onCapacity, onOpen, onQuickMatch, busy, connected }) {
  return html`<section class="lobby-discovery brackets" data-testid="lobby-discovery" aria-label=${t('联机大厅')}>
    <div class="lobby-discovery__overview">
      <div class="lobby-discovery__heading"><${MicroLabel} tone="mint">ALLIANCE MATCHMAKING<//><strong><${Icon} name="users" />${t('联机大厅')}</strong></div>
      <div class="lobby-discovery__stats">
        <span><b class="num" data-testid="lobby-room-count">${state.roomCount == null ? '—' : state.roomCount}</b><small>${t('总房间')}</small></span>
        <span><b class="num" data-testid="lobby-match-count">${state.matchCount == null ? '—' : state.matchCount}</b><small>${t('进行中')}</small></span>
        <span title=${t('游玩人数仅统计当前对局中在线的真人，包含淘汰和托管玩家，不含 AI 和观战者。')}><b class="num" data-testid="lobby-playing-count">${state.playingCount == null ? '—' : state.playingCount}</b><small>${t('游玩人数')}</small></span>
        <span><b class="num" data-testid="lobby-joinable-count">${state.joinableCount == null ? '—' : state.joinableCount}</b><small>${t('可加入')}</small></span>
      </div>
    </div>
    <div class="lobby-discovery__actions">
      <${Button} variant="secondary" size="sm" icon="users" data-testid="lobby-directory-open" disabled=${!connected} onClick=${onOpen}>${t('房间列表')}<//>
      <label class="lobby-discovery__preference" title=${t('优先所选人数，没有空席时匹配其他房间。')}><span>${t('房间偏好')}</span>
        <select value=${capacity || ''} disabled=${busy || !connected} data-testid="lobby-match-capacity" onChange=${(e) => onCapacity(e.currentTarget.value ? Number(e.currentTarget.value) : null)}>
          <option value="">${t('不限人数')}</option>${ROOM_CAPACITIES.map((n) => html`<option key=${n} value=${n}>${t('优先 {n} 人房', { n })}</option>`)}
        </select>
      </label>
      <${Button} variant="primary" size="sm" iconRight="chevrons" data-testid="lobby-quick-match" loading=${busy} disabled=${!connected} onClick=${onQuickMatch}>${t('最快匹配')}<//>
    </div>
  </section>`;
}
