// No webpage listeners, clipboard polling, credentials, or in-memory capture queue.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
