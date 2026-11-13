import { getSettings, saveSettings, setOnboardingComplete, isOnboardingComplete } from '../shared/storage.js';
import { syncAlarmFromSettings } from '../shared/alarms.js';
import { mountRunFrequencyFieldset, getSelectedRunFrequency } from '../shared/run-frequency-fieldset.js';
import { STORAGE_KEYS } from '../shared/constants.js';
import { el } from '../shared/dom.js';

const FREQ = 'onboardFrequency';

const PAGE_SUBTITLE_DEFAULT = 'Privacy: All your data stays on your device.';

let pendingDeletion = null;
let previewRunId = 0;

function goBackToStep1() {
  previewRunId++;
  pendingDeletion = null;
  document.getElementById('step2Panel').classList.add('hidden');
  document.getElementById('step1Panel').classList.remove('hidden');
  document.getElementById('pageTitle').textContent = 'Welcome';
  const sub = document.getElementById('pageSubtitle');
  sub.textContent = PAGE_SUBTITLE_DEFAULT;
  sub.classList.remove('hidden');
  document.getElementById('step2Back').disabled = false;
}

function showSuccess() {
  document.getElementById('step1Panel').classList.add('hidden');
  document.getElementById('step2Panel').classList.add('hidden');
  document.getElementById('pageTitle').textContent = 'All done';
  document.getElementById('pageSubtitle').classList.add('hidden');
  document.getElementById('successPanel').classList.remove('hidden');
}

async function persistStep1(partial) {
  const settings = await getSettings();
  const next = { ...settings, ...partial, autoConfirm: false };
  await saveSettings(next);
  syncAlarmFromSettings(next);
}

async function finishOnboarding() {
  await setOnboardingComplete(true);
  showSuccess();
}

function isNoClaudeTabError(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return /no claude tab is open/i.test(msg);
}

function isLoginError(msg) {
  if (!msg || typeof msg !== 'string') return false;
  if (isNoClaudeTabError(msg)) return false;
  return /log\s*in|sign\s*in|401|not logged|logged in/i.test(msg);
}

function hideStep2States() {
  ['step2Loading', 'step2Problem', 'step2Empty', 'step2Preview', 'step2Deleting'].forEach((id) => {
    document.getElementById(id).classList.add('hidden');
  });
}

async function runPreview() {
  const runId = ++previewRunId;
  hideStep2States();
  document.getElementById('step2Loading').classList.remove('hidden');
  document.getElementById('step2ProgressWrap').classList.add('hidden');
  pendingDeletion = null;

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: 'RUN_NOW',
      options: { useSavedSettings: true }
    });
  } catch (e) {
    result = { error: e?.message || 'Something went wrong' };
  }

  document.getElementById('step2Loading').classList.add('hidden');
  if (runId !== previewRunId) return;

  if (result?.error) {
    const noTab = isNoClaudeTabError(result.error);
    const login = isLoginError(result.error);
    const showOpenClaude = noTab || login;
    document.getElementById('step2ProblemTitle').textContent = noTab
      ? 'Open Claude in a tab'
      : login
        ? 'Log in to Claude'
        : 'Couldn’t load chats';
    document.getElementById('step2ProblemBody').textContent = result.error;
    document.getElementById('step2OpenClaude').classList.toggle('hidden', !showOpenClaude);
    document.getElementById('step2Problem').classList.remove('hidden');
    return;
  }

  if (result?.deleted === 0) {
    if (runId !== previewRunId) return;
    document.getElementById('step2Empty').classList.remove('hidden');
    return;
  }

  if (result?.requiresConfirm && result.chats?.length) {
    if (runId !== previewRunId) return;
    pendingDeletion = {
      tabId: result.tabId,
      chatIds: result.chatIds,
      chats: result.chats
    };
    const n = result.chats.length;
    document.getElementById('step2Summary').textContent =
      `${n} chat${n === 1 ? '' : 's'} will be deleted (older than your threshold):`;
    const listEl = document.getElementById('step2List');
    listEl.replaceChildren(...result.chats.map((c) => {
      const name = c.name || '(unnamed)';
      const display = name.length > 72 ? `${name.slice(0, 69)}…` : name;
      const last =
        typeof c.lastEditAt === 'number' && c.lastEditAt > 0
          ? new Date(c.lastEditAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
          : '';
      return el('li', { title: name },
        display,
        last && ' ',
        last && el('span', { class: 'text-slate-400' }, `· ${last}`));
    }));
    document.getElementById('step2Preview').classList.remove('hidden');
    return;
  }

  if (runId !== previewRunId) return;
  document.getElementById('step2ProblemTitle').textContent = 'Something went wrong';
  document.getElementById('step2ProblemBody').textContent = 'Unexpected response from the extension.';
  document.getElementById('step2OpenClaude').classList.add('hidden');
  document.getElementById('step2Problem').classList.remove('hidden');
}

function wireStep2() {
  document.getElementById('step2Back').addEventListener('click', () => {
    goBackToStep1();
  });
  document.getElementById('step2OpenClaude').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://claude.ai/', active: true });
  });
  document.getElementById('step2Retry').addEventListener('click', () => {
    runPreview();
  });
  document.getElementById('step2FinishEmpty').addEventListener('click', () => {
    finishOnboarding();
  });
  document.getElementById('step2SkipDelete').addEventListener('click', () => {
    finishOnboarding();
  });

  document.getElementById('step2ConfirmDelete').addEventListener('click', async () => {
    if (!pendingDeletion) return;
    const btn = document.getElementById('step2ConfirmDelete');
    const skipBtn = document.getElementById('step2SkipDelete');
    btn.disabled = true;
    skipBtn.disabled = true;
    document.getElementById('step2Back').disabled = true;
    document.getElementById('step2Preview').classList.add('hidden');
    document.getElementById('step2Deleting').classList.remove('hidden');
    const { tabId, chatIds } = pendingDeletion;
    const progressWrap = document.getElementById('step2ProgressWrap');
    progressWrap.classList.add('hidden');
    document.getElementById('step2ProgressBar').style.width = '0%';
    const progressBar = document.getElementById('step2ProgressBar');
    const progressCount = document.getElementById('step2ProgressCount');

    const progressListener = (changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEYS.DELETION_PROGRESS]) return;
      const prog = changes[STORAGE_KEYS.DELETION_PROGRESS]?.newValue;
      if (!prog) return;
      progressWrap.classList.remove('hidden');
      const pct = prog.total > 0 ? Math.round((prog.current / prog.total) * 100) : 0;
      progressBar.style.width = `${pct}%`;
      progressCount.textContent = `${prog.deleted ?? prog.current} / ${prog.total}`;
    };
    chrome.storage.onChanged.addListener(progressListener);

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'CONFIRM_DELETE',
        tabId,
        chatIds
      });
      chrome.storage.onChanged.removeListener(progressListener);
      if (res?.error) {
        document.getElementById('step2Deleting').classList.add('hidden');
        document.getElementById('step2ProblemTitle').textContent = 'Delete failed';
        document.getElementById('step2ProblemBody').textContent = res.error;
        document.getElementById('step2OpenClaude').classList.add('hidden');
        document.getElementById('step2Problem').classList.remove('hidden');
        btn.disabled = false;
        skipBtn.disabled = false;
        document.getElementById('step2Back').disabled = false;
        return;
      }
      await finishOnboarding();
    } catch (err) {
      chrome.storage.onChanged.removeListener(progressListener);
      document.getElementById('step2Deleting').classList.add('hidden');
      document.getElementById('step2ProblemTitle').textContent = 'Delete failed';
      document.getElementById('step2ProblemBody').textContent = err?.message || 'Unknown error';
      document.getElementById('step2OpenClaude').classList.add('hidden');
      document.getElementById('step2Problem').classList.remove('hidden');
      btn.disabled = false;
      skipBtn.disabled = false;
      document.getElementById('step2Back').disabled = false;
    }
  });
}

document.getElementById('onboardingContinue').addEventListener('click', async () => {
  const errEl = document.getElementById('onboardError');
  const days = parseInt(document.getElementById('onboardDays').value, 10);
  if (!days || days < 1 || days > 365) {
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  await persistStep1({
    daysThreshold: days,
    runFrequency: getSelectedRunFrequency(FREQ)
  });
  document.getElementById('step1Panel').classList.add('hidden');
  document.getElementById('step2Panel').classList.remove('hidden');
  document.getElementById('pageTitle').textContent = 'Almost there';
  document.getElementById('pageSubtitle').textContent = 'Preview what a cleanup would remove.';
  document.getElementById('pageSubtitle').classList.remove('hidden');
  await runPreview();
});

document.getElementById('onboardingLater').addEventListener('click', async () => {
  document.getElementById('onboardError').classList.add('hidden');
  const days = parseInt(document.getElementById('onboardDays').value, 10);
  const partial = { runFrequency: 'manual' };
  if (days >= 1 && days <= 365) partial.daysThreshold = days;
  await persistStep1(partial);
  await finishOnboarding();
});

document.getElementById('closeTab').addEventListener('click', () => {
  window.close();
});

wireStep2();

(async function init() {
  const done = await isOnboardingComplete();
  const settings = await getSettings();
  document.getElementById('onboardDays').value = settings.daysThreshold;
  mountRunFrequencyFieldset(document.getElementById('runFrequencyMount'), {
    inputName: FREQ,
    selectedValue: done ? settings.runFrequency : 'daily',
    fieldsetClass: 'space-y-2 border-0 p-0 m-0'
  });
})();
