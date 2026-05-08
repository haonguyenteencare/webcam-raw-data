# Risk Analysis & Mitigation Strategies

## 1. Technical Risks

| Scenario | Potential Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **High CPU/Lag on Student Machine** | Browser slows down, Google Meet quality drops. | - Throttle frame sampling rate based on system load.<br>- Use `MediaStreamTrackProcessor` (WebCodecs) for efficient frame access.<br>- Offload heavy tasks to Background Worker or use `OffscreenCanvas`. |
| **Network Instability** | Uploads fail or time out. | - Queue data in `chrome.storage.local` or memory.<br>- Use Exponential Backoff for retries.<br>- Upload in smaller chunks if needed. |
| **Browser Crash** | Data in memory is lost. | - Periodically flush data to `chrome.storage.local`.<br>- Use `chrome.storage.session` for transient session state. |
| **Server Overload** | 40+ students uploading raw data simultaneously. | - Use a buffer/queue on the server (e.g., Redis).<br>- Horizontal scaling of API instances.<br>- Use S3 for direct uploads to bypass API bottlenecks. |
| **Google Meet Changes** | Hooking `getUserMedia` or `RTCPeerConnection` breaks. | - Implement robust fallback (e.g., capture tab/window as a last resort).<br>- Monitor for Meet UI/API updates. |

## 2. Privacy & Compliance

| Scenario | Potential Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **Unauthorized Recording** | Legal/Ethical issues. | - Mandatory Consent UI before recording starts.<br>- Visual indicator (e.g., extension icon change) when recording is active.<br>- Clear disclosure of what data is collected. |
| **Data Leak** | Sensitive student media exposed. | - Encrypt data during transit (HTTPS).<br>- Secure storage with access control (IAM/S3).<br>- Periodic data deletion policy. |

## 3. Data Integrity

| Scenario | Potential Impact | Mitigation Strategy |
| :--- | :--- | :--- |
| **Partial Uploads** | Missing video/audio segments. | - Implement sequence numbers for batches.<br>- Server-side validation of manifest against received chunks.<br>- Auto-retry of missing sequences at session end. |
| **Storage Full** | Cannot save more data. | - Monitor disk space on server.<br>- Automatically offload older captures to cold storage (Glacier). |
