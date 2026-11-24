# Privacy Policy: AI Chat History Auto-Delete

**Canonical public copy (HTTPS, for store listings):** [activistchecklist.github.io/ai-chat-history-auto-delete-extension/privacy.html](https://activistchecklist.github.io/ai-chat-history-auto-delete-extension/privacy.html)

AI Chat History Auto-Delete, a browser extension for Chrome and Firefox

**Effective date:** November 23, 2026

## The short version

This extension runs in your browser and only talks to claude.ai, using your login there to find and delete your old chats. Nothing about you or your chats is sent to us. We don't run any servers or analytics for it, so we don't have anything to turn over if we get a legal demand.

## What the extension does

It deletes your Claude (claude.ai) chats once they haven't been updated for a number of days you choose (30 by default). It can run on a schedule you set or when you click Run now, but only while you have claude.ai open in a tab.

## What it saves in your browser

The extension saves a few things in your browser's built-in extension storage, on your computer:

- Your settings (such as the number of days, the schedule, and whether to skip starred chats)
- How many chats were deleted on each run and when (not which ones). The log shows the last 30 days, but older entries can stay in storage until the next time it deletes chats. You can turn the log off or clear it in the settings (either one deletes it right away). Even with the log off, it keeps the date and count from the most recent run so it can show them on claude.ai.
- The ID of your Claude organization, so it can check that one first on the next run (if your account has more than one)
- The list of chats waiting for your approval (their titles, IDs and last-updated dates). It saves this every time you click Run now, and on scheduled runs if you have it ask before deleting. The list stays until you approve the deletion or a later run replaces or clears it (snoozing or closing the window doesn't clear it).

None of this is sent to us or anyone else, other than the chat and organization IDs it sends back to claude.ai to delete your chats. Uninstalling the extension deletes all of it.

## Third parties

The extension only connects to claude.ai, to list your chats and delete the ones past your limit. (Anthropic, the company behind Claude, can see those requests like anything else you do on claude.ai.)

## Permissions

The extension asks your browser for these permissions:

- Access to claude.ai, so it can list and delete your chats and show its status on the page
- Storage, for the settings and records listed above
- Alarms, so it can run on your schedule
- Tabs and scripting, so it can find your open claude.ai tab and send its requests (listing and deleting chats) from there. (Your browser may describe the tabs permission as reading your browsing history, but the extension only looks for claude.ai tabs.)
- Notifications, so it can let you know when chats are waiting for your approval (the notification only shows how many)

## Changes to this policy

If this policy changes, we'll post the updated version here and change the effective date above.

## Contact

If you have questions about this privacy policy, you can email us at <contact@activistchecklist.org>. If you'd like, you can also review the code on [GitHub](https://github.com/ActivistChecklist/ai-chat-history-auto-delete-extension).
