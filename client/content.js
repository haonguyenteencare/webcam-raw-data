(() => {
  const MAX_EVENTS = 80;

  let meetingReady = false;
  let pendingRecord = false;

  const inMeetingUrl = () => /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.href);

  const checkMeetingReady = () => {
    const micButton = document.querySelector('[data-is-muted], [aria-label*="microphone"], [aria-label*="micro"]');
    return inMeetingUrl() && !!micButton;
  };

  const broadcastCaptureSettings = async () => {
    const { consentGranted = false, researchRawMode = false, studentLabel = "" } = await chrome.storage.local.get({
      consentGranted: false,
      researchRawMode: false,
      studentLabel: "",
    });

    const { recordingState } = await chrome.storage.session.get("recordingState");
    const isReady = checkMeetingReady();

    if (consentGranted && !isReady) {
      if (!pendingRecord) {
        pendingRecord = true;
        showToast("⏳ Sẽ tự động ghi hình khi vào cuộc họp...");
      }
    }

    if (consentGranted && isReady) {
      if (pendingRecord) {
        pendingRecord = false;
        showToast("🔴 Đang bắt đầu ghi hình cuộc họp...");
      }
      meetingReady = true;
    }

    window.postMessage(
      {
        source: "meet-raw-data-poc-settings",
        consentGranted,
        researchRawMode,
        studentLabel: String(studentLabel || "").trim(),
        lastIndices: recordingState?.lastIndices || {},
      },
      "*",
    );
  };

  const checkAndResumeRecording = async () => {
    const { recordingState } = await chrome.storage.session.get("recordingState");
    
    if (recordingState?.wasRecording) {
      const sameMeeting = location.href.includes(recordingState.meetingCode);
      if (sameMeeting && inMeetingUrl()) {
        console.log("[CONTENT] Resuming session after reload...");
        showToast("🔄 Đang tiếp tục ghi hình sau khi tải lại...");
        await chrome.storage.local.set({ consentGranted: true });
        // Giữ lại recordingState để broadcastCaptureSettings có thể dùng lastIndices
      } else {
        await chrome.storage.session.remove("recordingState");
      }
    }
  };

  const startReadyObserver = () => {
    const observer = new MutationObserver(() => {
      const isReady = checkMeetingReady();
      if (isReady && !meetingReady) {
        console.log("[CONTENT] Observer detected meeting is ready.");
        void broadcastCaptureSettings();
      } else if (!isReady && meetingReady) {
        meetingReady = false;
      }
    });
    observer.observe(document.body, { subtree: true, childList: true });
  };

  void checkAndResumeRecording().then(() => {
    void broadcastCaptureSettings();
    startReadyObserver();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && (changes.consentGranted || changes.researchRawMode || changes.studentLabel)) {
      console.log("[CONTENT] Settings changed, broadcasting to hook...");
      void broadcastCaptureSettings();
    }
  });

  const updateStorage = async (event) => {
    const response = await chrome.runtime.sendMessage({ type: "raw-data-event", event });
    
    // Lưu trạng thái để resume nếu F5
    const { recordingState } = await chrome.storage.session.get("recordingState");
    let nextState = recordingState || null;

    if (event.type === "stream-captured") {
        nextState = {
            wasRecording: true,
            meetingCode: response?.meetingId || "unknown",
            at: Date.now(),
            lastIndices: (recordingState?.lastIndices || {})
        };
    }

    if (nextState && (event.type === "media-recording" || event.type === "audio-recording")) {
        nextState.lastIndices = nextState.lastIndices || {};
        if (event.payload.streamId && event.payload.chunkIndex !== undefined) {
            nextState.lastIndices[event.payload.streamId] = event.payload.chunkIndex;
        }
    }

    if (nextState) {
        await chrome.storage.session.set({ recordingState: nextState });
    }

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

  // Theo dõi kết thúc cuộc họp qua URL
  let previousUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== previousUrl) {
      const oldUrl = previousUrl;
      previousUrl = location.href;
      
      const wasInMeeting = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(oldUrl);
      const inMeeting = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(location.href);
      
      if (wasInMeeting && !inMeeting) {
        console.log("[CONTENT] Meeting ended (URL change). Stopping recording...");
        chrome.runtime.sendMessage({ type: "session-ended" }).catch(() => {});
        window.postMessage({ source: "meet-raw-data-poc-stop" }, "*");
      }
    }
  });

  urlObserver.observe(document, { subtree: true, childList: true });

  window.addEventListener("pagehide", () => {
    // Chỉ dừng hook ở mức trang, không kết thúc session ở background để F5 có thể resume
    window.postMessage({ source: "meet-raw-data-poc-stop" }, "*");
  });
})();
