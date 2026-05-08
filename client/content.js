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
    if (areaName === "local" && (changes.consentGranted || changes.researchRawMode || changes.studentLabel)) {
      console.log("[CONTENT] Settings changed, broadcasting to hook...");
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

  const showToast = (message) => {
    let container = document.querySelector("#meet-raw-data-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "meet-raw-data-toast-container";
      container.style.cssText = `
        position: fixed;
        bottom: 24px;
        left: 24px;
        z-index: 999999;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      `;
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.style.cssText = `
      background: #12b76a;
      color: white;
      padding: 12px 16px;
      border-radius: 8px;
      font-family: system-ui, sans-serif;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    `;
    toast.textContent = message;
    container.appendChild(toast);

    // Animate in
    setTimeout(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    }, 10);

    // Remove after 3 seconds
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-20px)";
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "upload-success") {
      showToast(`✅ Đã lưu ${message.count} dữ liệu về server`);
    }
  });

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
