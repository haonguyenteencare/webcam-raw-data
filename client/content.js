(() => {
  const MAX_EVENTS = 80;

  const broadcastCaptureSettings = async () => {
    const { consentGranted = false, researchRawMode = false, studentLabel = "" } = await chrome.storage.local.get({
      consentGranted: false,
      researchRawMode: false,
      studentLabel: "",
    });

    window.postMessage(
      {
        source: "meet-raw-data-poc-settings",
        consentGranted,
        researchRawMode,
        studentLabel: String(studentLabel || "").trim(),
      },
      "*",
    );
  };

  void broadcastCaptureSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes.consentGranted || changes.researchRawMode)) {
      void broadcastCaptureSettings();
    }
  });

  const updateStorage = async (event) => {
    const response = await chrome.runtime.sendMessage({ type: "raw-data-event", event });

    if (event.type === "media-recording" || event.type === "audio-recording") {
      await chrome.storage.local.set({
        sessionSummary: response?.ok
          ? {
              eventCount: response.eventCount,
              estimatedStoredBytes: response.estimatedStoredBytes,
              estimatedRawBytes: response.estimatedRawBytes,
              meetingId: response.meetingId,
              studentId: response.studentId,
              studentLabel: response.studentLabel,
              sessionId: response.sessionId,
            }
          : null,
      });

      return;
    }

    const current = await chrome.storage.local.get({ events: [] });
    const eventForStorage = {
      ...event,
      payload: {
        ...event.payload,
      },
    };

    if (eventForStorage.payload.rawIncluded !== true) {
      delete eventForStorage.payload.rgbaDataUrl;
      delete eventForStorage.payload.samples;
    }

    const events = [eventForStorage, ...current.events].slice(0, MAX_EVENTS);
    await chrome.storage.local.set({
      events,
      latestEvent: eventForStorage,
      sessionSummary: response?.ok
        ? {
            eventCount: response.eventCount,
            estimatedStoredBytes: response.estimatedStoredBytes,
            estimatedRawBytes: response.estimatedRawBytes,
            meetingId: response.meetingId,
            studentId: response.studentId,
            studentLabel: response.studentLabel,
            sessionId: response.sessionId,
          }
        : null,
    });
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    if (!event.data || event.data.source !== "meet-raw-data-poc") {
      return;
    }

    updateStorage({
      type: event.data.type,
      payload: event.data.payload,
      at: event.data.at,
      pageUrl: window.location.href,
    }).catch(() => {});
  });

  window.addEventListener("pagehide", () => {
    chrome.runtime.sendMessage({ type: "session-ended" }).catch(() => {});
  });
})();
