const saveIdentityButton = document.querySelector("#save-identity");
const syncNowButton = document.querySelector("#sync-now");
const studentLabelInput = document.querySelector("#student-label");
const consentGrantedInput = document.querySelector("#consent-granted");
const researchRawModeInput = document.querySelector("#research-raw-mode");
const eventsElement = document.querySelector("#events");
const statusElement = document.querySelector("#status");
const summaryElement = document.querySelector("#summary");
const clearButton = document.querySelector("#clear");
const exportButton = document.querySelector("#export");
const viewerButton = document.querySelector("#viewer");
const serverStatusElement = document.querySelector("#server-status");
const pendingCountElement = document.querySelector("#pending-count");

const checkServer = async () => {
    try {
        const result = await chrome.runtime.sendMessage({ type: "check-server" });
        if (result?.connected) {
            serverStatusElement.textContent = "Connected";
            serverStatusElement.className = "value online";
        } else {
            serverStatusElement.textContent = "Offline";
            serverStatusElement.className = "value offline";
        }
    } catch (e) {
        serverStatusElement.textContent = "Error";
        serverStatusElement.className = "value offline";
    }
};

setInterval(checkServer, 5000);
checkServer();

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const summarizeEvent = (event) => {
  if (event.type === "video-frame") {
    return `Video frame ${event.payload.displayWidth}x${event.payload.displayHeight}, ${event.payload.format}, checksum ${event.payload.checksum}`;
  }

  if (event.type === "audio-samples") {
    return `Audio samples ${event.payload.sampleCount} @ ${event.payload.sampleRate}Hz, peak ${event.payload.peak}`;
  }

  if (event.type === "stream-captured") {
    return `Captured ${event.payload.tracks.length} local track(s)`;
  }

  return event.type;
};

const render = async () => {
  const {
    events = [],
    sessionSummary = null,
    studentLabel = "",
    consentGranted = false,
    researchRawMode = false,
  } = await chrome.storage.local.get({
    events: [],
    sessionSummary: null,
    studentLabel: "",
    consentGranted: false,
    researchRawMode: false,
  });

  if (document.activeElement !== studentLabelInput) {
    studentLabelInput.value = studentLabel;
  }
  consentGrantedInput.checked = consentGranted;
  researchRawModeInput.checked = researchRawMode && consentGranted;
  researchRawModeInput.disabled = !consentGranted;

  summaryElement.textContent = sessionSummary
    ? `${sessionSummary.eventCount || events.length} event(s) | stored ${formatBytes(sessionSummary.estimatedStoredBytes)} | raw est. ${formatBytes(sessionSummary.estimatedRawBytes)}${sessionSummary.meetingId ? ` | meeting ${sessionSummary.meetingId}` : ""}${sessionSummary.studentLabel ? ` | ${sessionSummary.studentLabel}` : ""}`
    : `${events.length} event(s) captured locally`;

  if (!consentGranted) {
    statusElement.textContent =
      "Enable consent above to allow capture. If Meet already has camera/mic, toggle them off/on or rejoin after enabling consent.";
  } else if (events.length) {
    statusElement.textContent = summarizeEvent(events[0]);
  } else {
    statusElement.textContent = "Open Google Meet, allow camera/mic, then open this popup again.";
  }

  eventsElement.textContent = "";

  for (const event of events) {
    const row = document.createElement("article");
    row.className = "event";

    const title = document.createElement("div");
    title.className = "event-title";

    const type = document.createElement("span");
    type.textContent = event.type;

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = new Date(event.at).toLocaleTimeString();

    const payload = document.createElement("pre");
    const payloadForDisplay = { ...event.payload };
    const thumbnailDataUrl = payloadForDisplay.thumbnailDataUrl;

    delete payloadForDisplay.thumbnailDataUrl;
    delete payloadForDisplay.dataUrl;
    delete payloadForDisplay.rgbaDataUrl;
    delete payloadForDisplay.samples;
    delete payloadForDisplay.previewBytes;

    payload.textContent = JSON.stringify(payloadForDisplay, null, 2);

    title.append(type, time);
    row.append(title);

    if (thumbnailDataUrl) {
      const image = document.createElement("img");
      image.className = "thumbnail";
      image.src = thumbnailDataUrl;
      image.alt = "Video frame preview";
      row.append(image);
    }

    row.append(payload);
    eventsElement.append(row);
  }
};

clearButton.addEventListener("click", async () => {
  if (!confirm("Bạn có chắc chắn muốn xóa toàn bộ dữ liệu phiên này?")) {
    return;
  }
  
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  await chrome.storage.local.set({ events: [], sessionSummary: null });
  
  if (tab?.id) {
    await chrome.runtime.sendMessage({ type: "clear-session", tabId: tab.id });
  }
  
  await render();
});

saveIdentityButton.addEventListener("click", async () => {
  const studentLabel = studentLabelInput.value.trim();

  if (!studentLabel) {
    alert("Vui lòng nhập tên học sinh trước khi lưu!");
    return;
  }

  const originalText = saveIdentityButton.textContent;
  saveIdentityButton.disabled = true;
  saveIdentityButton.textContent = "Đang lưu...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.storage.local.set({ studentLabel });

    let statusMsg = `Đã lưu tên: ${studentLabel}. `;

    if (tab?.id) {
      const result = await chrome.runtime.sendMessage({
        type: "save-identity",
        studentLabel,
        tabId: tab.id,
      });

      if (!result.ok) {
        statusMsg += `(Lưu ý: Lỗi đồng bộ server: ${result.reason})`;
      } else if (result.updatedSessions === 0) {
        statusMsg += `(Lưu ý: Không tìm thấy phiên Meet đang chạy để khởi tạo folder)`;
      }
    }

    alert(`${statusMsg}\nExtension sẽ chạy ngầm ngay bây giờ.`);
    window.close();
  } catch (error) {
    console.error("Save identity failed:", error);
    alert(`Lỗi khi lưu: ${error.message}`);
  } finally {
    saveIdentityButton.disabled = false;
    saveIdentityButton.textContent = originalText;
  }
});

syncNowButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  syncNowButton.disabled = true;
  const originalText = syncNowButton.textContent;
  syncNowButton.textContent = "Syncing...";

  try {
    const result = await chrome.runtime.sendMessage({ type: "flush-upload", tabId: tab.id });
    if (result.ok) {
      pendingCountElement.textContent = result.pendingCount || "0";
      alert("Đã gửi lệnh đồng bộ dữ liệu!");
    } else {
      alert("Lỗi đồng bộ: " + result.reason);
    }
  } catch (e) {
    alert("Không thể kết nối với background script.");
  } finally {
    syncNowButton.disabled = false;
    syncNowButton.textContent = originalText;
  }
});

exportButton.addEventListener("click", async () => {
  const originalText = exportButton.textContent;
  exportButton.disabled = true;
  exportButton.textContent = "Exporting...";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      alert("Không tìm thấy tab Google Meet đang hoạt động.");
      return;
    }

    const result = await chrome.runtime.sendMessage({ type: "export-session", tabId: tab.id });

    if (result.ok) {
      statusElement.textContent = `Downloaded ${result.filename} with ${result.eventCount} event(s).`;
    } else {
      alert(`Export thất bại: ${result.reason}`);
      statusElement.textContent = `Export failed: ${result.reason}`;
    }
  } catch (error) {
    console.error("Export error:", error);
    alert(`Lỗi khi export: ${error.message}. Bạn có thể thử Export từ trang Viewer.`);
  } finally {
    exportButton.disabled = false;
    exportButton.textContent = originalText;
  }
});

viewerButton.addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});

consentGrantedInput.addEventListener("change", async () => {
  const consentGranted = consentGrantedInput.checked;
  let researchRawMode = researchRawModeInput.checked;

  if (!consentGranted) {
    researchRawMode = false;
  }

  await chrome.storage.local.set({ consentGranted, researchRawMode });
  await render();
});

researchRawModeInput.addEventListener("change", async () => {
  if (!consentGrantedInput.checked) {
    researchRawModeInput.checked = false;

    return;
  }

  await chrome.storage.local.set({ researchRawMode: researchRawModeInput.checked });
  await render();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.events) {
    render().catch(() => {});
  }

  if (
    areaName === "local" &&
    (changes.studentLabel || changes.sessionSummary || changes.consentGranted || changes.researchRawMode)
  ) {
    render().catch(() => {});
  }
});

render().catch(() => {});
