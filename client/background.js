const API_BASE_URL = "http://localhost:8787";
const UPLOAD_INTERVAL_MS = 5000;
const DEFAULT_SETTINGS = {
  studentLabel: "",
};

// In-memory cache for speed, but synced with storage
let sessions = new Map();
let pendingUploads = new Map();
let initializationPromise = null;

const loadState = async () => {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      const { persistentSessions = {}, persistentPending = {} } = await chrome.storage.session.get([
        "persistentSessions",
        "persistentPending",
      ]);
      sessions = new Map(Object.entries(persistentSessions).map(([k, v]) => [Number(k), v]));
      pendingUploads = new Map(Object.entries(persistentPending).map(([k, v]) => [Number(k), v]));
    } catch (e) {
      console.error("Failed to load state:", e);
    }
  })();

  return initializationPromise;
};

const saveState = async () => {
  try {
    const persistentSessions = Object.fromEntries(sessions);
    const persistentPending = Object.fromEntries(pendingUploads);
    await chrome.storage.session.set({ persistentSessions, persistentPending });
  } catch (e) {
    console.warn("Storage session limit might be reached, some state might not persist.");
  }
};

const RECORDED_TYPES = new Set([
  "hook-installed",
  "get-user-media-called",
  "stream-captured",
  "video-frame",
  "audio-samples",
  "audio-recording",
  "media-recorder-started",
  "media-recording",
  "media-recording-error",
  "media-recorder-error",
  "media-recorder-unsupported",
  "video-frame-error",
  "audio-unsupported",
  "video-unsupported",
]);

const uuid = () => {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const makeSessionId = (tabId) => {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `meet-raw-data-${timestamp}-tab-${tabId}`;
};

const sanitizeSegment = (value, fallback) => {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);

  return sanitized || fallback;
};

const getStoredStudentId = async () => {
  const current = await chrome.storage.local.get({ studentId: null });

  if (current.studentId) {
    return current.studentId;
  }

  const studentId = `anon-${uuid()}`;

  await chrome.storage.local.set({ studentId });

  return studentId;
};

const getStoredSettings = async () => {
  const current = await chrome.storage.local.get(DEFAULT_SETTINGS);

  return {
    studentLabel: String(current.studentLabel || "").trim(),
  };
};

const setStoredSettings = async (updates) => {
  await chrome.storage.local.set(updates);
};

const parseMeetingId = (pageUrl) => {
  try {
    const url = new URL(pageUrl);
    const pathSegment = url.pathname.split("/").filter(Boolean)[0];
    const ignoredSegments = new Set(["landing", "new", "about", "terms", "privacy"]);

    if (url.hostname === "meet.google.com" && pathSegment && !ignoredSegments.has(pathSegment)) {
      // Basic check for meeting code format (e.g., aaa-bbbb-ccc)
      // Meeting codes are usually 10+ chars including hyphens
      if (pathSegment.includes("-") || pathSegment.length >= 9) {
          return sanitizeSegment(pathSegment, "unknown-meeting");
      }
    }
  } catch {
    return "unknown-meeting";
  }

  return "unknown-meeting";
};

const getSession = async (tabId, pageUrl) => {
  await loadState();

  if (!sessions.has(tabId)) {
    const studentId = await getStoredStudentId();
    const settings = await getStoredSettings();
    const sessionId = makeSessionId(tabId);
    const meetingId = parseMeetingId(pageUrl);

    // Clear local storage when a brand new session starts for this tab
    await chrome.storage.local.set({ events: [], sessionSummary: null });
    console.log(`[SESSION] New session starting for tab ${tabId}, cleared local storage.`);

    sessions.set(tabId, {
      id: sessionId,
      sessionId,
      studentId,
      studentLabel: settings.studentLabel,
      meetingId,
      identity: {
        meetingCode: meetingId,
        studentLabel: settings.studentLabel,
      },
      startedAt: new Date().toISOString(),
      endedAt: null,
      pageUrl,
      formatVersion: 1,
      notes: [
        "PoC capture file. Video frames are sampled RGBA previews, not continuous full raw video.",
        "Audio samples are sampled Float32 preview chunks, not continuous full PCM recording.",
      ],
      events: [],
      stats: {
        eventCount: 0,
        estimatedStoredBytes: 0,
        estimatedRawBytes: 0,
      },
      upload: {
        apiBaseUrl: API_BASE_URL,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastError: null,
        uploadedEventCount: 0,
        nextAttemptDelay: 0
      },
    });
    await saveState();
  }

  const session = sessions.get(tabId);
  const settings = await getStoredSettings();

  if (pageUrl && pageUrl !== session.pageUrl) {
    session.pageUrl = pageUrl;
    session.meetingId = parseMeetingId(pageUrl);
    session.identity.meetingCode = session.meetingId;
    await saveState();
  }

  if (settings.studentLabel !== session.studentLabel) {
    session.studentLabel = settings.studentLabel;
    session.identity.studentLabel = settings.studentLabel;
    await saveState();
  }

  return session;
};

const compactEventForStorage = (event) => {
  const payload = { ...event.payload };

  if (payload.rawIncluded !== true) {
    delete payload.samples;
    delete payload.rgbaDataUrl;
    delete payload.previewBytes;
  }

  return {
    ...event,
    payload,
  };
};

const getPayloadForExport = (event) => compactEventForStorage(event);

const estimateStoredBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

const estimateRawBytes = (event) => {
  if (event.type === "video-frame") {
    return event.payload?.allocationSize || 0;
  }

  if (event.type === "audio-samples") {
    return (event.payload?.sampleCount || 0) * 4;
  }

  if (event.type === "audio-recording") {
    return (event.payload?.sampleCount || 0) * 4;
  }

  if (event.type === "media-recording") {
    return event.payload?.size || 0;
  }

  return 0;
};

const getPayloadForUpload = (event) => {
  return compactEventForStorage(event);
};

const downloadJson = async (session) => {
  if (!session || session.events.length === 0) {
    return { ok: false, reason: "No captured events for this tab yet." };
  }

  const endedAt = new Date().toISOString();
  const payload = {
    ...session,
    endedAt,
    exportedAt: endedAt,
    eventCount: session.events.length,
  };
  const json = JSON.stringify(payload, null, 2);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename: `${session.id}.json`,
    saveAs: false,
  });

  return { ok: true, filename: `${session.id}.json`, eventCount: session.events.length };
};

const uploadBatch = async (tabId, forceInit = false) => {
  const pending = pendingUploads.get(tabId) || [];

  if (pending.length === 0 && !forceInit) {
    return;
  }

  const session = sessions.get(tabId);

  if (!session) {
    return;
  }

  const batch = pending.splice(0, pending.length);

  session.upload.lastAttemptAt = new Date().toISOString();

  try {
    const payload = {
      meetingId: session.meetingId,
      studentId: session.studentId,
      studentLabel: session.studentLabel,
      sessionId: session.sessionId,
      pageUrl: session.pageUrl,
      userAgent: navigator.userAgent,
      events: batch.map(getPayloadForUpload),
    };

    console.log(`[UPLOAD] Sending request to ${API_BASE_URL}/api/capture/batch`, {
        meetingId: payload.meetingId,
        studentLabel: payload.studentLabel,
        eventCount: payload.events.length,
        forceInit
    });

    console.log(`[UPLOAD] Fetching: ${API_BASE_URL}/api/capture/batch with ${payload.events.length} events`);
    const response = await fetch(`${API_BASE_URL}/api/capture/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[UPLOAD] Server returned error: ${response.status}`, errorText);
      throw new Error(`Server error ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    console.log(`[UPLOAD] Success! Saved ${result.savedEventCount} events. Path: ${result.sessionPath}`);

    session.upload.lastSuccessAt = new Date().toISOString();
    session.upload.lastError = null;
    session.upload.uploadedEventCount += result.savedEventCount || batch.length;
    session.upload.nextAttemptDelay = 0;
    await saveState();

    // Notify the tab about successful upload
    chrome.tabs.sendMessage(tabId, {
        type: "upload-success",
        count: batch.length,
        sessionId: session.sessionId
    }).catch(() => {}); // Ignore errors if tab is closed

    console.log(`Successfully uploaded batch of ${batch.length} events for session ${session.sessionId}`);
  } catch (error) {
    console.error(`Upload failed: ${error.message}. Re-queueing batch.`);
    pending.unshift(...batch);
    session.upload.lastError = error.message;
    session.upload.nextAttemptDelay = Math.min((session.upload.nextAttemptDelay || 1000) * 2, 60000);
    await saveState();
  }
};

const queueUpload = async (tabId, event) => {
  if (!pendingUploads.has(tabId)) {
    pendingUploads.set(tabId, []);
  }

  pendingUploads.get(tabId).push(event);
  await saveState();
};

const refreshSessionStats = async (session, event) => {
  session.stats.eventCount += 1;
  session.stats.estimatedStoredBytes += estimateStoredBytes(event);
  session.stats.estimatedRawBytes += estimateRawBytes(event);
  await saveState();
};

chrome.alarms.create("upload-timer", { periodInMinutes: 0.1 }); // ~6 seconds

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "upload-timer") {
    await loadState();
    for (const tabId of pendingUploads.keys()) {
      const session = sessions.get(tabId);
      if (session && session.upload.nextAttemptDelay > 0) {
        session.upload.nextAttemptDelay -= 6000; // 6 seconds
        if (session.upload.nextAttemptDelay > 0) continue;
      }
      uploadBatch(tabId);
    }
  }
});

// Reliably detect when a Meet tab is closed to clear data
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadState();
  if (sessions.has(tabId)) {
    console.log(`[TAB] Tab ${tabId} closed. Cleaning up session data...`);
    const session = sessions.get(tabId);
    
    // Final attempt to upload if there's unsent data
    if (session.events.length > 0) {
      await uploadBatch(tabId).catch(() => {});
    }

    sessions.delete(tabId);
    pendingUploads.delete(tabId);
    
    // Reset local storage for the popup and turn OFF the capture switch
    await chrome.storage.local.set({ 
      events: [], 
      sessionSummary: null,
      consentGranted: false 
    });
    await saveState();
    console.log(`[TAB] Session data and Consent for tab ${tabId} cleared successfully.`);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Wrap in an async IIFE to allow await while returning true synchronously
  (async () => {
    try {
      if (message?.type === "raw-data-event" && sender.tab?.id !== undefined) {
        if (!RECORDED_TYPES.has(message.event.type)) {
          console.warn(`[BG] Ignoring event type: ${message.event.type}`);
          sendResponse({ ok: true, recorded: false });
          return;
        }

        const session = await getSession(sender.tab.id, message.event.pageUrl);
        const event = {
          ...message.event,
          meetingId: session.meetingId,
          studentId: session.studentId,
          studentLabel: session.studentLabel,
          sessionId: session.sessionId,
        };

        session.events.push(getPayloadForExport(event));
        await refreshSessionStats(session, event);
        await queueUpload(sender.tab.id, event);

        sendResponse({
          ok: true,
          recorded: true,
          eventCount: session.events.length,
          estimatedStoredBytes: session.stats.estimatedStoredBytes,
          estimatedRawBytes: session.stats.estimatedRawBytes,
          queuedUploadCount: pendingUploads.get(sender.tab.id)?.length || 0,
          meetingId: session.meetingId,
          studentId: session.studentId,
          studentLabel: session.studentLabel,
          sessionId: session.sessionId,
        });
      } else if (message?.type === "export-session") {
        const session = sessions.get(message.tabId);
        if (!session) {
          sendResponse({ ok: false, reason: "Không tìm thấy dữ liệu phiên cho tab này." });
        } else {
          const result = await downloadJson(session);
          sendResponse(result);
        }
      } else if (message?.type === "flush-upload") {
        await uploadBatch(message.tabId);
        const pending = pendingUploads.get(message.tabId) || [];
        sendResponse({ ok: true, pendingCount: pending.length });
      } else if (message?.type === "clear-session") {
        const tabId = message.tabId;
        if (sessions.has(tabId)) {
          const session = sessions.get(tabId);
          session.events = [];
          session.stats = { eventCount: 0, estimatedStoredBytes: 0, estimatedRawBytes: 0 };
          if (pendingUploads.has(tabId)) {
            pendingUploads.set(tabId, []);
          }
          await saveState();
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, reason: "Session not found" });
        }
      } else if (message?.type === "session-ended" && sender.tab?.id !== undefined) {
        const tabId = sender.tab.id;
        const session = sessions.get(tabId);
        
        if (session && session.events.length > 0) {
          console.log(`[SESSION] Session ended for tab ${tabId}. Performing final upload...`);
          session.endedAt = new Date().toISOString();
          await uploadBatch(tabId);
        }

        // Clear session from memory and storage
        sessions.delete(tabId);
        pendingUploads.delete(tabId);
        // Clear local storage so popup doesn't show old data and turn OFF the switch
        await chrome.storage.local.set({ 
          events: [], 
          sessionSummary: null,
          consentGranted: false 
        });
        
        await saveState();
        console.log(`[SESSION] Data and Consent cleared for ended session in tab ${tabId}`);
        
        sendResponse({ ok: true });
      } else if (message?.type === "save-identity") {
        const nextStudentLabel = String(message.studentLabel || "").trim();

        const tab = await chrome.tabs.get(message.tabId).catch(() => null);
        if (tab?.url) {
          await getSession(message.tabId, tab.url);
        }

        await setStoredSettings({ studentLabel: nextStudentLabel });

        let updatedCount = 0;
        for (const session of sessions.values()) {
          session.studentLabel = nextStudentLabel;
          if (!session.identity) {
            session.identity = {};
          }
          session.identity.studentLabel = nextStudentLabel;
          updatedCount++;
        }

        if (message.tabId && pendingUploads.has(message.tabId)) {
          const pending = pendingUploads.get(message.tabId);
          for (const event of pending) {
            event.studentLabel = nextStudentLabel;
          }
        }

        if (updatedCount > 0) {
          await saveState();
        }

        if (message.tabId) {
          // Trigger upload in background without awaiting, to prevent popup timeout
          uploadBatch(message.tabId, true).catch(err => console.error("[BG] Initial upload failed:", err));
        }

        sendResponse({ ok: true, studentLabel: nextStudentLabel, updatedSessions: updatedCount });
      } else if (message?.type === "check-server") {
        try {
          const res = await fetch(`${API_BASE_URL}/health`);
          const data = await res.json();
          sendResponse({ ok: true, connected: true, data });
        } catch (err) {
          sendResponse({ ok: true, connected: false, reason: err.message });
        }
      } else {
        sendResponse({ ok: false, reason: "Unknown message type" });
      }
    } catch (error) {
      console.error("[BG] Message handling error:", error);
      sendResponse({ ok: false, reason: error.message });
    }
  })();

  return true; // Keep message channel open for async response
});
