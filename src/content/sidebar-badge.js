/**
 * Sidebar badge — the extension's entire in-page surface on claude.ai.
 *
 * Replaces the former full-width top bar. Renders one quiet row under the
 * "Chats and tasks" sidebar label:
 *   - the row reports when chats were last actually deleted
 *   - clicking the row toggles a panel with detail plus Run now, Settings, and approval
 *
 * Hover deliberately does nothing but highlight: the panel is click-activated so it
 * never appears while the user is on their way to a chat.
 *
 * Loaded as a classic content script (no manifest "type": "module") so it parses in
 * every Chromium build; the ES module graph comes in via dynamic import().
 */
if (window.__aichadBadgeLoaded) {
  window.__aichadBadgeRefresh?.();
} else {
  window.__aichadBadgeLoaded = true;
  window.__aichadBadgeRefresh = () => {};

  (async () => {
    const [
      { openPendingDeletionModal, closePendingDeletionModal },
      { BADGE_ID, findBadgeInsertionPoint, isBadgeInPlace, insertBadge }
    ] = await Promise.all([
      import(chrome.runtime.getURL('src/shared/pending-deletion-modal.js')),
      import(chrome.runtime.getURL('src/shared/badge-insertion.js'))
    ]);

    (function () {
      'use strict';

      const STORAGE_KEYS = {
        SETTINGS: 'settings',
        DELETION_PROGRESS: 'deletion_progress',
        LAST_RUN: 'last_run',
        LAST_DELETION: 'last_deletion',
        ACTIVITY_HISTORY: 'activity_history',
        PENDING_CONFIRM: 'pending_confirm'
      };

      const PANEL_ID = 'aichad-badge-panel';
      const RUN_NOW_MODAL_ID = 'aichad-run-now-modal';
      const FULL_NAME = 'AI Chat History Auto-Delete';

      /** How long after a run the badge keeps showing that run's deleted count. */
      const SHOW_RECENT_MS = 5 * 60 * 1000;
      /** Transient status (run errors, integration tests) before reverting to live state. */
      const TRANSIENT_STATUS_MS = 6000;
      const DAY_MS = 24 * 60 * 60 * 1000;


      let badgeEl = null;
      let panelEl = null;
      let reinserting = false;
      let repositionTimer = null;
      let transientTimer = null;
      let viewportRaf = 0;
      let panelOpen = false;

      /** Overrides the panel body until it expires or state changes. */
      let transientStatus = null;
      /** Latest storage snapshot, so the panel can render without re-reading. */
      let snapshot = { last: null, lastDeletion: null, pending: null, progress: null, settings: {} };

      // ---------------------------------------------------------------- helpers

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      /**
       * Claude's theme lives on `.cds-root[data-mode]`. The panel and modals are
       * portalled to document.body, outside that scope, so we copy the mode across
       * rather than relying on prefers-color-scheme (which disagrees when the user
       * has picked a theme explicitly).
       */
      function claudeThemeClass() {
        const mode = document.querySelector('.cds-root[data-mode]')?.getAttribute('data-mode')
          || document.documentElement.getAttribute('data-mode');
        if (mode === 'dark') return 'aichad-dark';
        if (mode === 'light') return 'aichad-light';
        return '';
      }

      function plural(n, word) {
        return `${n} ${word}${n === 1 ? '' : 's'}`;
      }

      function openSettings(hash) {
        try {
          chrome.runtime.sendMessage(hash ? { type: 'OPEN_OPTIONS', hash } : { type: 'OPEN_OPTIONS' });
        } catch (_) { /* service worker asleep; nothing actionable */ }
      }

      /** Whole days elapsed, floored, using local midnights so "yesterday" is calendar-based. */
      function daysAgo(timestamp) {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const then = new Date(timestamp);
        then.setHours(0, 0, 0, 0);
        return Math.max(0, Math.round((startOfToday - then) / DAY_MS));
      }

      /**
       * The row's resting label. Reports the last run that actually removed chats —
       * not the last run, which is usually a no-op and would read as misleading.
       */
      function deletedAgoLabel(lastDeletion) {
        if (!lastDeletion?.timestamp) return 'Auto-deleted: never';
        const days = daysAgo(lastDeletion.timestamp);
        if (days === 0) return 'Auto-deleted: today';
        if (days === 1) return 'Auto-deleted: yesterday';
        return `Auto-deleted: ${days} days ago`;
      }

      /** Exact stamp for the panel; the row already carries the relative phrasing. */
      function formatStamp(timestamp) {
        const d = new Date(timestamp);
        const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        return `${date}, ${time}`;
      }

      function formatLastRun(last) {
        if (!last?.timestamp) return 'Never run';
        const count = last.deleted ?? 0;
        if (count > 0) return `Last run ${formatStamp(last.timestamp)} — deleted ${plural(count, 'chat')}`;
        return `Last run ${formatStamp(last.timestamp)} — nothing to delete`;
      }

      function isPendingActionable(pending) {
        if (!pending?.count) return false;
        if (pending.snoozedUntil && Date.now() < pending.snoozedUntil) return false;
        return true;
      }

      /**
       * Shows a short-lived message in the panel, and — for errors — on the row itself,
       * so a failed run is visible without opening anything.
       * `html` must already be escaped by the caller.
       */
      function setTransientStatus(html, tone = null) {
        transientStatus = { html, tone };
        clearTimeout(transientTimer);
        transientTimer = setTimeout(() => {
          transientStatus = null;
          void refreshState();
        }, TRANSIENT_STATUS_MS);
        renderPanelBody();
      }

      function clearTransientStatus() {
        clearTimeout(transientTimer);
        transientStatus = null;
      }

      // ------------------------------------------------------------ badge mount

      function createBadge() {
        if (badgeEl) return badgeEl;
        const point = findBadgeInsertionPoint(document);
        if (!point) return null;

        // A container wrapping a single button, so trailing affordances can be added later
        // as siblings — nesting interactive elements is invalid and breaks keyboard nav.
        badgeEl = document.createElement('div');
        badgeEl.id = BADGE_ID;
        badgeEl.setAttribute('data-state', 'idle');
        badgeEl.innerHTML = `
          <button type="button" class="aichad-badge__main" aria-expanded="false" aria-haspopup="true">
            <span class="aichad-badge__label"></span>
            <span class="aichad-badge__count" aria-hidden="true"></span>
          </button>
          <span class="aichad-badge__track" aria-hidden="true">
            <span class="aichad-badge__track-fill"></span>
          </span>`;

        badgeEl.querySelector('.aichad-badge__main').addEventListener('click', (e) => {
          e.stopPropagation();
          togglePanel();
        });

        insertBadge(point, badgeEl);
        return badgeEl;
      }

      function ensureBadgePosition() {
        if (!badgeEl) return;
        const point = findBadgeInsertionPoint(document);
        if (!point || isBadgeInPlace(badgeEl, point)) return;
        insertBadge(point, badgeEl);
      }

      /** Quiet flash when the toolbar icon is clicked and the badge is already mounted. */
      function pulseBadge() {
        if (!badgeEl) return;
        badgeEl.classList.remove('aichad-badge--attention');
        void badgeEl.offsetWidth;
        badgeEl.classList.add('aichad-badge--attention');
        badgeEl.addEventListener(
          'animationend',
          () => badgeEl?.classList.remove('aichad-badge--attention'),
          { once: true }
        );
      }

      // ----------------------------------------------------------- badge render

      function renderBadge({ state, label, count = '', pct = null, title }) {
        const badge = createBadge();
        if (!badge) return;

        badge.setAttribute('data-state', state);

        const main = badge.querySelector('.aichad-badge__main');
        if (main) main.setAttribute('aria-label', title);

        const labelEl = badge.querySelector('.aichad-badge__label');
        if (labelEl) labelEl.textContent = label;

        const countEl = badge.querySelector('.aichad-badge__count');
        if (countEl) countEl.textContent = count;

        const fill = badge.querySelector('.aichad-badge__track-fill');
        if (fill) fill.style.width = pct == null ? '0%' : `${pct}%`;

        renderPanelBody();
      }

      // ------------------------------------------------------------------ panel

      function createPanel() {
        if (panelEl?.isConnected) return panelEl;
        panelEl = document.createElement('div');
        panelEl.id = PANEL_ID;
        panelEl.setAttribute('role', 'dialog');
        panelEl.setAttribute('aria-label', FULL_NAME);
        panelEl.addEventListener('click', (e) => e.stopPropagation());
        document.body.appendChild(panelEl);
        return panelEl;
      }

      function panelBodyHtml() {
        const { last, lastDeletion, pending, progress } = snapshot;
        const lines = [];
        let approveAction = '';

        if (transientStatus) {
          const toneClass = transientStatus.tone ? ` aichad-panel__line--${transientStatus.tone}` : '';
          lines.push(`<p class="aichad-panel__line${toneClass}">${transientStatus.html}</p>`);
        } else if (progress) {
          const done = progress.deleted ?? progress.current ?? 0;
          lines.push(
            `<p class="aichad-panel__line aichad-panel__line--emphasis">Deleting chats — ${escapeHtml(String(done))} of ${escapeHtml(String(progress.total ?? 0))} done</p>`
          );
        } else if (isPendingActionable(pending)) {
          lines.push(
            `<p class="aichad-panel__line aichad-panel__line--emphasis">${escapeHtml(plural(pending.count, 'chat'))} ready to delete</p>`
          );
          approveAction = `<button type="button" class="aichad-panel__action aichad-panel__action--danger" data-aichad-approve>Review &amp; approve</button>`;
        } else {
          lines.push(
            lastDeletion?.timestamp
              ? `<p class="aichad-panel__line aichad-panel__line--emphasis">${escapeHtml(plural(lastDeletion.deleted ?? 0, 'chat'))} deleted ${escapeHtml(formatStamp(lastDeletion.timestamp))}</p>`
              : `<p class="aichad-panel__line aichad-panel__line--emphasis">No chats deleted yet</p>`
          );

          // Only mention the last run when it is a NEWER, empty-handed one. Otherwise it is
          // the same event as the line above, worded differently.
          const ranSinceWithNothingFound = last?.timestamp
            && (last.deleted ?? 0) === 0
            && (!lastDeletion?.timestamp || last.timestamp > lastDeletion.timestamp);
          if (ranSinceWithNothingFound) {
            lines.push(
              `<p class="aichad-panel__line">Checked ${escapeHtml(formatStamp(last.timestamp))} — nothing to delete</p>`
            );
          }

          if (pending?.count && pending.snoozedUntil && Date.now() < pending.snoozedUntil) {
            const until = new Date(pending.snoozedUntil).toLocaleTimeString(undefined, {
              hour: 'numeric',
              minute: '2-digit'
            });
            lines.push(
              `<p class="aichad-panel__line">${escapeHtml(plural(pending.count, 'chat'))} snoozed until ${escapeHtml(until)}.</p>`
            );
          }
        }

        const running = !!progress;
        return `
          ${lines.join('')}
          <div class="aichad-panel__footer">
            ${approveAction ? `<div class="aichad-panel__row">${approveAction}</div>` : ''}
            <div class="aichad-panel__row">
              <button type="button" class="aichad-panel__action" data-aichad-run-now ${running ? 'disabled' : ''}>Run now</button>
              <button type="button" class="aichad-panel__action aichad-panel__action--muted" data-aichad-settings>Settings</button>
            </div>
          </div>`;
      }

      function renderPanelBody() {
        if (!panelEl?.isConnected) return;
        panelEl.innerHTML = panelBodyHtml();
        panelEl.className = claudeThemeClass();
        panelEl.querySelector('[data-aichad-approve]')?.addEventListener('click', () => {
          closePanel();
          openApprovalModal(snapshot.pending);
        });
        panelEl.querySelector('[data-aichad-run-now]')?.addEventListener('click', () => {
          closePanel();
          promptRunNow();
        });
        panelEl.querySelector('[data-aichad-settings]')?.addEventListener('click', () => {
          closePanel();
          openSettings();
        });
      }

      /**
       * Fixed positioning against the row's viewport rect — the sidebar clips
       * (`overflow: clip`) and scrolls, so an in-flow popover would be hidden.
       */
      function positionPanel() {
        if (!panelEl || !badgeEl) return;
        const rect = badgeEl.getBoundingClientRect();
        const panelRect = panelEl.getBoundingClientRect();
        const gap = 8;
        const margin = 8;

        let left = rect.right + gap;
        if (left + panelRect.width > window.innerWidth - margin) {
          left = Math.max(margin, rect.left - panelRect.width - gap);
        }

        let top = rect.top - 4;
        if (top + panelRect.height > window.innerHeight - margin) {
          top = Math.max(margin, window.innerHeight - panelRect.height - margin);
        }

        panelEl.style.left = `${Math.round(left)}px`;
        panelEl.style.top = `${Math.round(top)}px`;
      }

      function openPanel() {
        if (!badgeEl?.isConnected) return;
        const panel = createPanel();
        renderPanelBody();
        panel.setAttribute('data-visible', 'true');
        badgeEl.setAttribute('data-open', 'true');
        badgeEl.querySelector('.aichad-badge__main')?.setAttribute('aria-expanded', 'true');
        panelOpen = true;
        positionPanel();
      }

      function closePanel() {
        panelOpen = false;
        panelEl?.removeAttribute('data-visible');
        badgeEl?.removeAttribute('data-open');
        badgeEl?.querySelector('.aichad-badge__main')?.setAttribute('aria-expanded', 'false');
      }

      function togglePanel() {
        if (panelOpen) closePanel();
        else openPanel();
      }

      /** The row scrolled out of its own scroll container, so the panel would dangle. */
      function badgeIsOutOfView() {
        if (!badgeEl?.isConnected) return true;
        const rect = badgeEl.getBoundingClientRect();
        if (rect.height === 0) return true;
        if (rect.bottom < 0 || rect.top > window.innerHeight) return true;
        const scroller = badgeEl.closest('.dframe-nav-scroll, .dframe-sidebar-body');
        if (!scroller) return false;
        const clip = scroller.getBoundingClientRect();
        return rect.bottom < clip.top || rect.top > clip.bottom;
      }

      /**
       * Claude scrolls its own containers constantly (the transcript auto-scroller in
       * particular), and those events reach window in the capture phase. Follow the row
       * rather than closing, so an open panel is not dismissed by background activity.
       */
      function onViewportChange() {
        if (!panelOpen || viewportRaf) return;
        viewportRaf = requestAnimationFrame(() => {
          viewportRaf = 0;
          if (!panelOpen) return;
          if (badgeIsOutOfView()) closePanel();
          else positionPanel();
        });
      }

      // ----------------------------------------------------------------- modals

      function applyModalTheme(overlayId) {
        const theme = claudeThemeClass();
        if (!theme) return;
        document.getElementById(overlayId)?.classList.add(theme);
      }

      function openApprovalModal(pending) {
        if (!pending) return;
        openPendingDeletionModal(pending, {
          afterSnooze: async () => { await refreshState(); },
          afterConfirmSuccess: async () => { await refreshState(); },
          onError: (msg) => {
            setTransientStatus(escapeHtml(msg), 'error');
            openPanel();
          }
        });
        applyModalTheme('aichad-pending-chats-modal');
      }

      function closeRunNowModal() {
        document.getElementById(RUN_NOW_MODAL_ID)?.remove();
      }

      function promptRunNow() {
        chrome.storage.local.get(STORAGE_KEYS.SETTINGS, (r) => {
          const settings = r[STORAGE_KEYS.SETTINGS] || {};
          const days = settings.daysThreshold || 30;
          const ignoreStarred = settings.ignoreStarred !== false;
          closeRunNowModal();

          const overlay = document.createElement('div');
          overlay.id = RUN_NOW_MODAL_ID;
          overlay.className = `aichad-modal-overlay ${claudeThemeClass()}`.trim();
          overlay.setAttribute('role', 'dialog');
          overlay.setAttribute('aria-modal', 'true');
          overlay.setAttribute('aria-labelledby', 'aichad-run-now-modal-title');
          overlay.innerHTML = `
            <div class="aichad-modal">
              <h2 id="aichad-run-now-modal-title" class="aichad-modal__title">Run cleanup now?</h2>
              <p class="aichad-modal__body">
                Chats older than the age below will be considered for deletion for <strong>this run only</strong>.
                Your saved settings stay the same.${ignoreStarred ? ' Starred chats are skipped.' : ''}
              </p>
              <div class="aichad-modal__field">
                <label for="aichad-run-now-days" class="aichad-modal__label">Delete chats older than (days)</label>
                <input type="number" id="aichad-run-now-days" class="aichad-modal__input" min="1" max="365" value="${days}" inputmode="numeric" />
              </div>
              <p class="aichad-modal__hint">Defaults to your saved threshold (${plural(days, 'day')}); change it for this run only.</p>
              <div class="aichad-modal__actions">
                <button type="button" class="aichad-modal__btn aichad-modal__btn--outline" data-aichad-cancel>Cancel</button>
                <button type="button" class="aichad-modal__btn aichad-modal__btn--primary" data-aichad-confirm>Run now</button>
              </div>
            </div>`;
          document.body.appendChild(overlay);

          const onKey = (e) => {
            if (e.key === 'Escape') {
              closeRunNowModal();
              document.removeEventListener('keydown', onKey);
            }
          };
          document.addEventListener('keydown', onKey);

          overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
              closeRunNowModal();
              document.removeEventListener('keydown', onKey);
            }
          });
          overlay.querySelector('[data-aichad-cancel]').addEventListener('click', () => {
            closeRunNowModal();
            document.removeEventListener('keydown', onKey);
          });
          overlay.querySelector('[data-aichad-confirm]').addEventListener('click', () => {
            const raw = parseInt(document.getElementById('aichad-run-now-days')?.value, 10);
            const daysOverride = Math.min(365, Math.max(1, Number.isFinite(raw) ? raw : days));
            closeRunNowModal();
            document.removeEventListener('keydown', onKey);
            executeRunNow(daysOverride);
          });

          document.getElementById('aichad-run-now-days')?.focus();
        });
      }

      function executeRunNow(daysOverride) {
        clearTransientStatus();
        renderBadge({
          state: 'progress',
          label: 'Scanning…',
          title: `${FULL_NAME}: scanning for old chats`
        });

        const options = { useSavedSettings: true };
        if (Number.isFinite(daysOverride)) options.daysOverride = daysOverride;

        chrome.runtime.sendMessage({ type: 'RUN_NOW', options }, (result) => {
          if (chrome.runtime.lastError) {
            setTransientStatus(escapeHtml(chrome.runtime.lastError.message), 'error');
            void refreshState();
            return;
          }
          if (result?.error) {
            setTransientStatus(escapeHtml(result.error), 'error');
            void refreshState();
            return;
          }
          if (result?.requiresConfirm) {
            const pending = {
              count: result.count,
              chatIds: result.chatIds || [],
              chats: result.chats || [],
              tabId: result.tabId,
              timestamp: Date.now()
            };
            // Storage write drives refreshState() via onChanged; open the modal
            // straight away so the click that started this flow lands somewhere.
            chrome.storage.local.set({ [STORAGE_KEYS.PENDING_CONFIRM]: pending }, () => {
              snapshot.pending = pending;
              openApprovalModal(pending);
            });
            return;
          }
          setTransientStatus('No chats old enough to delete.', 'ok');
          void refreshState();
        });
      }

      // ------------------------------------------------------------------ state

      /** Installs predating LAST_DELETION still have the answer in activity history. */
      function deriveLastDeletion(stored, history) {
        if (stored?.timestamp) return stored;
        const entry = (history || []).find((h) => (h.deletedCount ?? 0) > 0);
        if (!entry?.timestamp) return null;
        return { deleted: entry.deletedCount, timestamp: entry.timestamp };
      }

      async function refreshState() {
        const [progressWrap, lastWrap, deletionWrap, historyWrap, pendingWrap, settingsWrap] =
          await Promise.all([
            chrome.storage.local.get(STORAGE_KEYS.DELETION_PROGRESS),
            chrome.storage.local.get(STORAGE_KEYS.LAST_RUN),
            chrome.storage.local.get(STORAGE_KEYS.LAST_DELETION),
            chrome.storage.local.get(STORAGE_KEYS.ACTIVITY_HISTORY),
            chrome.storage.local.get(STORAGE_KEYS.PENDING_CONFIRM),
            chrome.storage.local.get(STORAGE_KEYS.SETTINGS)
          ]);

        const progress = progressWrap[STORAGE_KEYS.DELETION_PROGRESS];
        const last = lastWrap[STORAGE_KEYS.LAST_RUN];
        const pending = pendingWrap[STORAGE_KEYS.PENDING_CONFIRM];
        const settings = settingsWrap[STORAGE_KEYS.SETTINGS] || {};
        const lastDeletion = deriveLastDeletion(
          deletionWrap[STORAGE_KEYS.LAST_DELETION],
          historyWrap[STORAGE_KEYS.ACTIVITY_HISTORY]
        );

        snapshot = { last, lastDeletion, pending, progress, settings };

        // A failed run outranks live state: don't silently paint over it.
        if (transientStatus?.tone === 'error') {
          renderBadge({
            state: 'error',
            label: 'Run failed',
            title: `${FULL_NAME}: last run failed — open for details`
          });
          return;
        }

        if (progress) {
          const total = progress.total ?? 0;
          const current = progress.current ?? 0;
          const done = progress.deleted ?? current;
          renderBadge({
            state: 'progress',
            label: 'Deleting chats',
            count: `${done}/${total}`,
            pct: total > 0 ? Math.round((current / total) * 100) : 0,
            title: `${FULL_NAME}: deleting chats, ${done} of ${total} done`
          });
          return;
        }

        if (isPendingActionable(pending)) {
          renderBadge({
            state: 'pending',
            label: 'Ready to delete',
            count: String(pending.count),
            title: `${FULL_NAME}: ${plural(pending.count, 'chat')} ready to delete`
          });
          return;
        }

        const showRecent = settings.showDeletedCountAfterRun !== false;
        if (showRecent && last?.deleted > 0 && last.timestamp && Date.now() - last.timestamp < SHOW_RECENT_MS) {
          renderBadge({
            state: 'recent',
            label: 'Auto-deleted: just now',
            count: String(last.deleted),
            title: `${FULL_NAME}: deleted ${plural(last.deleted, 'chat')} just now`
          });
          return;
        }

        renderBadge({
          state: 'idle',
          label: deletedAgoLabel(lastDeletion),
          title: `${FULL_NAME}: ${formatLastRun(last)}`
        });
      }

      // -------------------------------------------------------------- listeners

      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        const watched = [
          STORAGE_KEYS.DELETION_PROGRESS,
          STORAGE_KEYS.LAST_RUN,
          STORAGE_KEYS.LAST_DELETION,
          STORAGE_KEYS.PENDING_CONFIRM,
          STORAGE_KEYS.SETTINGS
        ];
        if (watched.some((key) => key in changes)) {
          clearTransientStatus();
          void refreshState();
        }
      });

      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'SHOW_RECENT_DELETE' || msg.type === 'REFRESH_STATE') {
          void refreshStateAndMount(msg.type === 'REFRESH_STATE');
        }
      });

      const MOUNT_ATTEMPTS = 150;
      const MOUNT_DELAY_MS = 200;
      let mountGen = 0;

      /**
       * The toolbar icon can fire before Claude's sidebar exists (cold load, hard
       * refresh), when createBadge() would no-op. Retry until mounted or timeout.
       */
      async function refreshStateAndMount(pulse) {
        const gen = ++mountGen;
        for (let i = 0; i < MOUNT_ATTEMPTS && gen === mountGen; i++) {
          await refreshState();
          if (badgeEl?.isConnected) {
            if (pulse) pulseBadge();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, MOUNT_DELAY_MS));
        }
      }

      /** Mutations we caused ourselves must not trigger another reposition pass. */
      function isOwnMutation(record) {
        const target = record.target;
        if (!target) return false;
        if (panelEl && (target === panelEl || panelEl.contains(target))) return true;
        if (badgeEl && (target === badgeEl || badgeEl.contains(target))) return true;
        return false;
      }

      /**
       * Claude re-renders the sidebar on navigation and on recents updates, which can
       * drop or reorder our row. Re-insert when it disappears; nudge it back into
       * position otherwise.
       */
      function observeSidebar() {
        const observer = new MutationObserver((records) => {
          if (reinserting) return;
          if (records.every(isOwnMutation)) return;

          if (badgeEl && !badgeEl.isConnected) {
            reinserting = true;
            badgeEl = null;
            closePanel();
            if (createBadge()) void refreshState();
            reinserting = false;
            return;
          }

          // Moving the row while its panel is open would leave the panel misaligned.
          if (panelOpen) return;

          clearTimeout(repositionTimer);
          repositionTimer = setTimeout(() => {
            if (panelOpen) return;
            ensureBadgePosition();
          }, 300);
        });

        // Scope to the sidebar when we can: observing all of document.body means every
        // token streamed into the transcript wakes this callback.
        const scope = document.querySelector('.dframe-sidebar') || document.body;
        observer.observe(scope, { childList: true, subtree: true });

        // The sidebar element itself can be replaced on a cold navigation; if our scope
        // detaches, fall back to body so we can still recover the row.
        if (scope !== document.body) {
          new MutationObserver(() => {
            if (!scope.isConnected && badgeEl && !badgeEl.isConnected) {
              reinserting = true;
              badgeEl = null;
              closePanel();
              if (createBadge()) void refreshState();
              reinserting = false;
            }
          }).observe(document.body, { childList: true, subtree: true });
        }
      }

      /** Asks the background, which can read the install type; content scripts cannot. */
      async function isDevMode() {
        try {
          const res = await chrome.runtime.sendMessage({ type: 'IS_DEV_INSTALL' });
          return res?.dev === true;
        } catch {
          return false;
        }
      }

      /** Dev-only hook driven by scripts/integration-test.js via ?_autodelete_test=. */
      async function checkIntegrationTestParam() {
        const mode = new URLSearchParams(window.location.search).get('_autodelete_test');
        if (!mode || !(await isDevMode())) return;

        const url = new URL(window.location.href);
        url.searchParams.delete('_autodelete_test');
        history.replaceState(null, '', url.toString());

        const dryRun = mode !== 'delete';
        setTransientStatus(
          escapeHtml(`Integration test: ${dryRun ? 'finding oldest chat…' : 'finding & deleting oldest chat…'}`)
        );
        openPanel();

        chrome.runtime.sendMessage({ type: 'INTEGRATION_TEST', dryRun }, (result) => {
          if (chrome.runtime.lastError) {
            setTransientStatus(escapeHtml(chrome.runtime.lastError.message), 'error');
            return;
          }
          if (result?.error) {
            setTransientStatus(escapeHtml(result.error), 'error');
            return;
          }
          const name = result.chat?.name || '(unnamed)';
          const date = result.chat?.createdAt ? new Date(result.chat.createdAt).toLocaleString() : '—';
          const verb = dryRun ? 'Dry run OK — oldest' : 'Deleted';
          setTransientStatus(`✓ ${verb}: "${escapeHtml(name)}" (${escapeHtml(date)})`, 'ok');
          openPanel();
        });
      }

      function init() {
        if (!document.body) {
          setTimeout(init, 50);
          return;
        }
        if (!createBadge()) {
          setTimeout(init, 200);
          return;
        }

        void refreshState();
        observeSidebar();

        // Click-activated, so it needs the usual dismiss affordances.
        document.addEventListener('click', () => {
          if (panelOpen) closePanel();
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && panelOpen) closePanel();
        });

        window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });
        window.addEventListener('resize', onViewportChange, { passive: true });
        window.addEventListener('popstate', () => {
          closePanel();
          closePendingDeletionModal();
          closeRunNowModal();
          ensureBadgePosition();
          void refreshState();
        });

        void checkIntegrationTestParam();
      }

      init();

      window.__aichadBadgeRefresh = () => refreshStateAndMount(false);
    })();
  })();
}
