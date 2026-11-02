// Text chat is independent from the original picture-only emote wheel. State and transport are supplied by the
// match chat controller: this view neither persists messages nor writes drafts to browser storage.

import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { toastError } from './toasts.js';
import { t } from '../../../shared/i18n.js';
import { CHAT_LIMITS, chatTextLength } from '../../../shared/matchChat.js';
import { useStore } from '../store.js';
import { chatStore, chatActions, selectChatUnread } from '../matchChat.js';
import { PlayerAvatar } from './gameComponents.js';
import { poolGroups } from './gameLogic/groups.js';

const cx = (...parts) => parts.flat().filter(Boolean).join(' ');

/** Code points, rather than UTF-16 units: supplementary characters use the same budget as other characters. */
export const chatLength = chatTextLength;

/** Enter commits text only after an input method has finished composing it. */
export function chatEnterSends(event) {
  return event?.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

/** A separate, framed chat entry. It never changes the original emote button or its contents. */
export function MatchChatToggle({ open = false, unread = 0, onToggle, class: cls }) {
  const count = Math.max(0, Number(unread) || 0);
  return html`<button type="button" class=${cx('mchat-toggle', open && 'is-open', count && 'has-unread', cls)}
    aria-label=${count ? t('对局聊天，{n} 条未读', { n: count }) : t('对局聊天')}
    aria-haspopup="dialog" aria-expanded=${open ? 'true' : 'false'} data-match-chat-toggle="true"
    onPointerDown=${(e) => e.stopPropagation()} onClick=${(e) => { e.stopPropagation(); onToggle?.(!open); }}>
    <${Icon} name="chat" /><span>${t('聊天')}</span>
    ${count ? html`<b class="mchat-toggle__badge" aria-hidden="true">${count > 99 ? '99+' : count}</b>` : null}
  </button>`;
}

/**
 * A light, non-modal conversation panel. The controller clears a successfully sent draft and retains refused text.
 * Rendering strings as text vnodes prevents user messages and names from injecting markup or links.
 */
export function MatchChatPanel({ open = false, messages = [], draft = '', unread = 0, connected = true, canSend = true,
  maxChars = CHAT_LIMITS.text, players = [], spectators = [], publicView = null, onClose, onDraft, onSend, onRead, class: cls, style }) {
  const [busy, setBusy] = useState(false);
  const sendPending = useRef(false);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const returnFocus = useRef(null);
  const nearBottom = useRef(true);
  const wasOpen = useRef(false);
  const live = useRef(null);
  live.current = { onClose, onRead };
  const rows = Array.isArray(messages) ? messages : [];
  const participants = new Map();
  for (const player of [...(Array.isArray(players) ? players : []), ...(Array.isArray(spectators) ? spectators : [])]) {
    if (player?.playerId && !participants.has(player.playerId)) participants.set(player.playerId, player);
  }
  const groupByPlayer = new Map();
  for (const group of poolGroups(publicView)) for (const playerId of group.playerIds) {
    if (!groupByPlayer.has(playerId)) groupByPlayer.set(playerId, group);
  }
  const lastSeq = rows.at(-1)?.seq || 0;
  const count = chatLength(draft);
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : CHAT_LIMITS.text;

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      returnFocus.current = globalThis.document?.activeElement;
      nearBottom.current = true;
      inputRef.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
    if (open && nearBottom.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
      if (lastSeq) live.current.onRead?.(lastSeq);
    }
  }, [open, lastSeq]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => {
      if (e.target?.closest?.('.mchat-panel, .mchat-toggle')) return;
      live.current.onClose?.();
    };
    const key = (e) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      live.current.onClose?.();
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', key, true); };
  }, [open]);

  const send = async () => {
    if (sendPending.current || !connected || !canSend || !draft.trim() || count > limit) return;
    sendPending.current = true;
    setBusy(true);
    nearBottom.current = true;
    try { await onSend?.(draft); }
    catch (err) { toastError(err); }
    finally { sendPending.current = false; setBusy(false); }
  };
  if (!open) return null;
  const close = () => {
    onClose?.();
    if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
  };
  return html`<section class=${cx('mchat-panel', cls)} style=${style} role="dialog" aria-label=${t('对局聊天')} data-testid="match-chat-panel"
    onPointerDown=${(e) => e.stopPropagation()} onKeyDown=${(e) => e.stopPropagation()}>
    <header class="mchat-panel__head"><b><${Icon} name="chat" />${t('对局聊天')}</b>
      <button type="button" class="mchat-panel__close" aria-label=${t('关闭聊天')} title=${t('关闭聊天')} onClick=${close}>×</button>
    </header>
    <div class="mchat-panel__messages" role="log" aria-label=${t('聊天记录')} aria-live="polite" aria-relevant="additions"
      ref=${listRef} onScroll=${(e) => {
        const el = e.currentTarget;
        nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
        if (nearBottom.current && lastSeq) onRead?.(lastSeq);
      }}>
      ${rows.length ? rows.map((m) => {
        const participant = participants.get(m.playerId) || m;
        const seat = Number.isInteger(participant.seat) ? participant.seat : m.seat;
        const group = m.spectator ? null : groupByPlayer.get(m.playerId);
        const player = { ...participant, playerId: m.playerId, name: participant.name || m.name, seat };
        return html`<div class=${cx('mchat-line', m.spectator && 'is-spectator')} key=${m.seq}>
          <div class="mchat-line__who">
            <${PlayerAvatar} player=${player} size="sm" class="mchat-line__avatar" />
            ${group ? html`<span class="mchat-line__group" style=${`--pool-group-color:${group.color}`}
              aria-label=${t('{group}组 · 同组共享卡池', { group: group.label })}>${group.label}</span>` : null}
            <span class="mchat-line__seat">${m.spectator ? t('观战') : Number.isInteger(seat) ? `P${seat + 1}` : ''}</span>
            <b>${player.name || t('博士')}</b>
          </div><p>${m.text}</p>
        </div>`;
      }) : html`<p class="mchat-panel__empty">${t('还没有聊天消息')}</p>`}
    </div>
    ${unread && !nearBottom.current ? html`<button type="button" class="mchat-panel__latest" onClick=${() => {
      nearBottom.current = true;
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
      if (lastSeq) onRead?.(lastSeq);
    }}>${t('{n} 条新消息，查看最新', { n: unread })}</button>` : null}
    <footer class="mchat-panel__foot">
      <div class="mchat-panel__compose">
        <textarea ref=${inputRef} rows="2" maxlength=${CHAT_LIMITS.inputUnits} value=${draft} disabled=${!connected || !canSend} data-testid="match-chat-input"
          aria-label=${t('聊天内容')} placeholder=${connected ? t('输入消息…') : t('断线后暂时无法发送')}
          onInput=${(e) => onDraft?.(e.currentTarget.value)} onKeyDown=${(e) => {
            e.stopPropagation();
            if (chatEnterSends(e)) { e.preventDefault(); void send(); }
          }}></textarea>
        <button type="button" class="mchat-panel__send" data-testid="match-chat-send" disabled=${busy || !connected || !canSend || !draft.trim() || count > limit}
          onClick=${() => { void send(); }}>${busy ? t('发送中…') : t('发送')}</button>
      </div>
      <div class="mchat-panel__hint"><span>${t('Enter 发送 · Shift+Enter 换行')}</span>
        <span class=${cx(count > limit && 'is-over')}>${count}/${limit}</span></div>
    </footer>
  </section>`;
}

/** Every phase's entry talks to the same RAM controller; switching screens keeps messages and unsent text. */
export function MatchChatButton({ class: cls, onBeforeOpen }) {
  const state = useStore((s) => s, Object.is, chatStore);
  if (!state.matchId) return null;
  return html`<${MatchChatToggle} open=${state.open} unread=${selectChatUnread(state)} class=${cls}
    onToggle=${(on) => { if (on) onBeforeOpen?.(); chatActions.setOpen(on); }} />`;
}

/** One panel at the GameScreen boundary, including pre-game choices, combat and human AI supervision. */
export function MatchChatHost({ phase, away = false }) {
  const state = useStore((s) => s, Object.is, chatStore);
  const connected = useStore((s) => s.connection.status === 'online');
  const publicView = useStore((s) => s.match?.public || null);
  const spectators = useStore((s) => s.room?.spectators || []);
  const [anchor, setAnchor] = useState(null);
  useLayoutEffect(() => {
    if (!state.open) return undefined;
    const reposition = () => {
      const doc = globalThis.document;
      const button = doc?.querySelector('.mchat-away-entry') || doc?.querySelector('[data-match-chat-toggle]');
      const r = button?.getBoundingClientRect();
      if (!r || !(r.height > 0)) return;
      setAnchor({ left: Math.max(12, r.left), bottom: Math.max(12, window.innerHeight - r.top + 8) });
    };
    reposition();
    window.addEventListener('resize', reposition);
    globalThis.visualViewport?.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('resize', reposition);
      globalThis.visualViewport?.removeEventListener('resize', reposition);
    };
  }, [state.open, phase, away]);
  if (!state.matchId) return null;
  return html`<${MatchChatPanel} open=${state.open} messages=${state.messages} draft=${state.draft}
    publicView=${publicView} players=${publicView?.players || []} spectators=${spectators}
    unread=${selectChatUnread(state)} connected=${connected} onClose=${() => chatActions.setOpen(false)}
    onDraft=${chatActions.setDraft} onSend=${chatActions.send} onRead=${chatActions.markRead}
    style=${anchor ? `--mchat-left:${anchor.left}px;--mchat-bottom:${anchor.bottom}px` : undefined} />`;
}
