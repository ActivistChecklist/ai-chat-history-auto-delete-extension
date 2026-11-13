import { describe, it, expect } from 'vitest';
import { releaseFileNames } from '../../scripts/lib/release-files.mjs';

describe('releaseFileNames', () => {
  it('names every file after the store it is for', () => {
    expect(releaseFileNames('1.2.0')).toEqual({
      chromeZip: 'ai-chat-history-auto-delete-1.2.0-chrome.zip',
      chromeCrx: 'ai-chat-history-auto-delete-1.2.0-chrome.crx',
      firefoxZip: 'ai-chat-history-auto-delete-1.2.0-firefox.zip',
      firefoxSource: 'ai-chat-history-auto-delete-1.2.0-firefox-source.zip'
    });
  });

  it('keeps a malformed version from making odd file names', () => {
    expect(releaseFileNames('1.2/0 beta').chromeZip).toBe('ai-chat-history-auto-delete-1.2-0-beta-chrome.zip');
  });
});
