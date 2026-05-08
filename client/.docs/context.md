**1. Kết luận ngắn**

- Nếu cần **raw local camera/mic gốc của học sinh**, cách khả thi nhất là chạy code ở phía học sinh: Chrome extension, web app riêng, hoặc native app.
- Nếu chỉ cài extension ở phía mentor, **không lấy được raw data gốc của học sinh**. Mentor chỉ nhận được media đã đi qua Google Meet.
- Google Meet có Media API cho realtime media, nhưng không thay thế được raw local camera/mic gốc; API này cũng đang có điều kiện Developer Preview/Workspace/consent theo docs Google.

**2. Vì sao mentor không lấy được raw data học sinh**

Flow thực tế của Google Meet:

`Camera/mic học sinh
  -> Browser học sinh gọi getUserMedia()
  -> WebRTC encode/nén audio/video
  -> Google Meet server/SFU
  -> Browser mentor nhận stream đã xử lý/decoded`

Mentor-side extension chỉ đứng ở đoạn cuối:

`Browser mentor nhận/thấy/nghe gì thì extension mentor đọc được cái đó`

Nó không đứng ở máy học sinh, nên không thể đọc được:

`camera frame/audio sample trước encode trên máy học sinh`

Vì vậy mentor có thể lấy:

- video/audio remote mà mentor đang nhận trong Meet
- màn hình/tab composite của Meet
- decoded frame/audio sau pipeline Meet

Nhưng không lấy được:

- raw webcam frame local của học sinh
- raw mic PCM local của học sinh
- dữ liệu trước nén/encode WebRTC

**3. Các phương án khả thi**

| **Phương án** | **Cần học sinh cài/mở gì?** | **Lấy raw gốc?** | **Độ khả thi** | **Ghi chú** |
| --- | --- | --- | --- | --- |
| Student Chrome extension | Có, cài extension | Có, gần nguồn nhất | Cao | Hook getUserMedia(), lấy frame/audio local, upload server/S3 |
| Student web app riêng | Có, mở web app + cấp quyền | Có | Cao | Không cần extension nhưng UX kém hơn vì phải mở thêm app/tab |
| Native app học sinh | Có, cài app | Có | Cao kỹ thuật, nặng triển khai | Ổn định hơn browser nhưng chi phí cao |
| Mentor extension | Không | Không | Trung bình | Chỉ lấy remote decoded stream hoặc màn hình Meet |
| Google Meet Media API | Không cài extension | Không phải raw gốc | Trung bình/Thấp hiện tại | Hướng chính thức cho realtime media, nhưng có điều kiện Developer Preview/Workspace/consent |
| Meet REST API artifacts | Không | Không | Cao nếu chỉ cần sau meeting | Chỉ lấy recording/transcript/smart notes sau buổi học |
| Google Calendar API | Không | Không | Không phù hợp | Chỉ tạo/sửa event/link Meet |

Nguồn Google:

- [**Meet Media API overview**](https://developers.google.com/workspace/meet/media-api/guides/overview)
- [**Meet REST API artifacts**](https://developers.google.com/workspace/meet/api/guides/artifacts)

**4. Phương án tối ưu nên làm**

Phương án tối ưu cho bài toán “cần raw data học sinh” là:

`Student Chrome Extension
  -> hook getUserMedia()
  -> lấy raw frame sample + audio PCM/WebM
  -> upload batch về backend
  -> backend lưu local/S3
  -> mentor dashboard xem lại hoặc realtime`

Lý do chọn:

- Lấy được data gần camera/mic gốc nhất.
- Không phụ thuộc vào mentor-side remote stream.
- Không cần reverse engineer sâu Google Meet RTC internals.
- Có thể mở rộng sang S3, dashboard, identity sau.
- PoC đã chứng minh được video frame và audio sample từ máy học sinh.

**5. Demo đã làm**

Đã có 2 phần:

- Extension: /Users/macbook/Documents/teen-care/extension-webcam
    - Hook getUserMedia().
    - Lấy video frame bằng MediaStreamTrackProcessor + VideoFrame.copyTo(RGBA).
    - Lấy audio sample bằng Web Audio API.
    - Tạo thumbnail, audio preview, WebM chunk.
    - Upload batch về API local.
- Local API: /Users/macbook/Documents/teen-care/meet-capture-api
    - Node Express chạy local tại http://localhost:8787.
    - Endpoint chính: POST /api/capture/batch.
    - Lưu file vào captures/{meetingId}/{studentId}/{sessionId}/.
    - Đã smoke test tạo được:
        - frames/*.jpg
        - frames/*.rgba
        - audio/*.json
        - audio/*.f32
        - recordings/*.webm
        - manifest.json

**6. Giới hạn hiện tại**

- Đây là PoC local, chưa có auth/identity thật.
- Chưa lưu S3, mới lưu local file.
- Raw video không lưu liên tục 30fps vì quá nặng; hiện sample raw RGBA mỗi 5 giây.
- Audio lưu PCM preview + WebM chunk, chưa phải hệ thống recording production.
- Cần consent rõ ràng nếu dùng thật, đặc biệt vì dữ liệu camera/mic học sinh rất nhạy cảm.

**7. Next step đề xuất**

- Thêm S3 upload vào API sau khi local flow ổn.
- Thêm dashboard mentor đọc manifest.json/S3 object.
- Thêm identity nhẹ: meeting code + student mapping.
- Thêm consent UI trong extension.
- Tối ưu payload: WebP/JPEG frame sample, WebM/Opus recording, chỉ gửi full raw khi cần research.

### **Mentor-side capture summary**

Nếu chỉ cài extension phía mentor, không lấy được raw camera/mic gốc của học sinh. Mentor chỉ lấy được dữ liệu mà browser mentor đã nhận từ Google Meet sau khi media của học sinh đã đi qua WebRTC/Meet pipeline.

Flow:

`Camera/mic học sinh
  -> browser học sinh
  -> WebRTC encode/nén
  -> Google Meet server/SFU
  -> browser mentor nhận/decoded/render
  -> mentor extension có thể capture`

Các cách mentor-side có thể thử:

| **Cách** | **Data nhận được** | **Ưu điểm** | **Giới hạn** |
| --- | --- | --- | --- |
| RTCPeerConnection hook | Remote MediaStreamTrack, decoded video/audio | Gần media layer nhất | Không phải raw gốc, khó map chắc chắn từng học sinh |
| chrome.tabCapture | Video/audio composite của tab Meet | Dễ làm, ổn định hơn | Không tách từng học sinh tốt |
| Capture <video> element / canvas | Pixel đang render trên UI | Dễ inspect hình hiển thị | Phụ thuộc DOM/layout Meet, dễ crop/ẩn/scale |

Dạng data mentor nhận được:

`Video: decoded remote frame -> VideoFrame/RGBA hoặc canvas pixels
Audio: decoded remote audio -> Float32 PCM samples hoặc WebM recording
Tab: composite stream -> WebM/frame image`

Kết luận:

![image.png](attachment:52b974f9-3892-493e-af67-ef26a5e48632:image.png)

`Mentor-side extension chỉ phù hợp để capture remote decoded media hoặc giao diện Meet.
Không phù hợp nếu yêu cầu là raw local camera/mic gốc của học sinh.
Muốn raw gốc thì cần code chạy phía học sinh: extension, web app, hoặc native app.`

### Kết quả thu được từ Poc extension xuất data raw từ máy học sinh

![image.png](attachment:f29575ce-101b-4996-898d-7c7f3d63d524:image.png)

#### Source code demo extension

[extension-webcam.zip](attachment:78e5bc03-a3cb-477b-8bb3-a31a62bb8156:extension-webcam.zip)

#### **Source code demo phần api nhận data raw**

[meet-capture-api.zip](attachment:31ffbd5d-1166-4bdd-8eb3-0fb8e93c0e53:meet-capture-api.zip)