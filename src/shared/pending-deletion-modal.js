import { STORAGE_KEYS } from './constants.js';
import { domBuilder } from './dom.js';

export const PENDING_MODAL_OVERLAY_ID = 'aichad-pending-chats-modal';
export const CLAUDE_CHAT_BASE = 'https://claude.ai/chat';

const SNOOZE_MS = 24 * 60 * 60 * 1000;

function formatLastEditedLabel(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

export function buildChatRows(pend) {
  const ids = pend.chatIds || [];
  const byId = new Map(
    (pend.chats || []).map((c) => [
      c.id,
      { name: c.name, lastEditAt: c.lastEditAt ?? null }
    ])
  );
  return ids.map((id) => {
    const row = byId.get(id);
    const name = row?.name ?? id;
    const lastEditAt = row?.lastEditAt ?? null;
    const lastEdited = formatLastEditedLabel(lastEditAt);
    return { id, name, lastEdited };
  });
}

export function closePendingDeletionModal(doc = document) {
  doc.getElementById(PENDING_MODAL_OVERLAY_ID)?.remove();
}

export async function applySnoozeToPending(storageKey = STORAGE_KEYS.PENDING_CONFIRM) {
  const r = await chrome.storage.local.get(storageKey);
  const pendingConfirm = r[storageKey];
  if (!pendingConfirm) return false;
  await chrome.storage.local.set({
    [storageKey]: {
      ...pendingConfirm,
      snoozedUntil: Date.now() + SNOOZE_MS
    }
  });
  return true;
}

/**
 * Deletion approval modal (shared by the Claude sidebar badge and extension options).
 * Uses classes from shared/modal.css (.aichad-modal-overlay, .aichad-modal--chats, …).
 *
 * @param {object} pend - pending_confirm snapshot
 * @param {object} [opts]
 * @param {Document} [opts.document]
 * @param {() => void} [opts.onModalCleanup] - after overlay removed (Escape, overlay click, close)
 * @param {() => Promise<void>|void} [opts.afterSnooze]
 * @param {(result: { deleted?: number }) => Promise<void>|void} [opts.afterConfirmSuccess]
 * @param {(msg: string) => void} [opts.onError] - defaults to alert()
 */
export function openPendingDeletionModal(pend, opts = {}) {
  const doc = opts.document ?? document;
  const afterSnooze = opts.afterSnooze;
  const afterConfirmSuccess = opts.afterConfirmSuccess;
  const onError = opts.onError ?? ((msg) => { alert(msg); });
  const onModalCleanup = opts.onModalCleanup;

  const el = domBuilder(doc);
  closePendingDeletionModal(doc);

  const rows = buildChatRows(pend);
  const listItems = rows.length
    ? rows.map((r) => el('li', { class: 'aichad-modal__chat-item' },
      el('a', {
        href: `${CLAUDE_CHAT_BASE}/${encodeURIComponent(r.id)}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        class: 'aichad-modal__chat-link'
      }, r.name),
      r.lastEdited && el('span', { class: 'aichad-modal__chat-meta' }, `Last edited ${r.lastEdited}`)))
    : el('li', { class: 'aichad-modal__chat-item aichad-modal__chat-item--empty' }, 'No chat links available.');

  const count = pend.count ?? 0;
  const overlay = el('div', {
    id: PENDING_MODAL_OVERLAY_ID,
    class: 'aichad-modal-overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'aichad-pending-chats-modal-title'
  },
  el('div', { class: 'aichad-modal aichad-modal--chats' },
    el('h2', { id: 'aichad-pending-chats-modal-title', class: 'aichad-modal__title' }, 'Chats ready to delete'),
    el('p', { class: 'aichad-modal__body' }, `${count} chat${count === 1 ? '' : 's'} will be permanently removed.`),
    el('ul', { class: 'aichad-modal__chat-list' }, listItems),
    el('div', { class: 'aichad-modal__actions aichad-modal__actions--stack' },
      el('button', { type: 'button', class: 'aichad-modal__btn aichad-modal__btn--danger', 'data-aichad-confirm-delete': true }, 'Confirm deletion'),
      el('button', { type: 'button', class: 'aichad-modal__btn aichad-modal__btn--outline', 'data-aichad-snooze': true }, 'Snooze for 1 day'),
      el('button', { type: 'button', class: 'aichad-modal__btn aichad-modal__btn--outline', 'data-aichad-close': true }, 'Close'))));
  doc.body.appendChild(overlay);

  const detachKey = () => {
    doc.removeEventListener('keydown', onKey);
  };

  function onKey(e) {
    if (e.key === 'Escape') {
      detachKey();
      closePendingDeletionModal(doc);
      onModalCleanup?.();
    }
  }
  doc.addEventListener('keydown', onKey);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      detachKey();
      closePendingDeletionModal(doc);
      onModalCleanup?.();
    }
  });

  overlay.querySelector('[data-aichad-close]').addEventListener('click', () => {
    detachKey();
    closePendingDeletionModal(doc);
    onModalCleanup?.();
  });

  overlay.querySelector('[data-aichad-snooze]').addEventListener('click', async () => {
    detachKey();
    const ok = await applySnoozeToPending();
    closePendingDeletionModal(doc);
    onModalCleanup?.();
    if (ok && afterSnooze) await afterSnooze();
  });

  overlay.querySelector('[data-aichad-confirm-delete]').addEventListener('click', () => {
    detachKey();
    const btn = overlay.querySelector('[data-aichad-confirm-delete]');
    if (btn) btn.disabled = true;
    chrome.storage.local.get(STORAGE_KEYS.PENDING_CONFIRM).then(({ [STORAGE_KEYS.PENDING_CONFIRM]: p }) => {
      if (!p?.chatIds?.length) {
        if (btn) btn.disabled = false;
        onError('No pending chats to delete.');
        return;
      }
      closePendingDeletionModal(doc);
      onModalCleanup?.();
      chrome.runtime.sendMessage(
        { type: 'CONFIRM_DELETE', tabId: p.tabId, chatIds: p.chatIds },
        async (res) => {
          if (chrome.runtime.lastError) {
            onError(chrome.runtime.lastError.message);
            return;
          }
          if (res?.error) {
            onError(res.error);
            return;
          }
          if (afterConfirmSuccess) await afterConfirmSuccess(res ?? {});
        }
      );
    });
  });
}
