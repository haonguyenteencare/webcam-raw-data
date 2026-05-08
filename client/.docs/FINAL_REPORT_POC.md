# Báo cáo Tổng kết: Hệ thống Ghi hình & Thu âm Raw (Student-side PoC)

## 1. Kết luận ngắn

- Nếu cần **raw local camera/mic gốc của học sinh**, cách khả thi nhất là chạy code ở phía học sinh: Chrome extension, web app riêng, hoặc native app.
- Nếu chỉ cài extension ở phía mentor, **không lấy được raw data gốc của học sinh**. Mentor chỉ nhận được media đã đi qua Google Meet.
- Google Meet có Media API cho realtime media, nhưng không thay thế được raw local camera/mic gốc; API này cũng đang có điều kiện Developer Preview/Workspace/consent theo docs Google.

## 2. Vì sao mentor không lấy được raw data học sinh

Flow thực tế của Google Meet:
`Camera/mic học sinh -> Browser học sinh gọi getUserMedia() -> WebRTC encode/nén audio/video -> Google Meet server/SFU -> Browser mentor nhận stream đã xử lý/decoded`

Mentor-side extension chỉ đứng ở đoạn cuối:
`Browser mentor nhận/thấy/nghe gì thì extension mentor đọc được cái đó`

Nó không đứng ở máy học sinh, nên không thể đọc được:
`camera frame/audio sample trước encode trên máy học sinh`

**Vì vậy mentor có thể lấy:**
- Video/audio remote mà mentor đang nhận trong Meet.
- Màn hình/tab composite của Meet.
- Decoded frame/audio sau pipeline Meet.

**Nhưng không lấy được:**
- Raw webcam frame local của học sinh.
- Raw mic PCM local của học sinh.
- Dữ liệu trước nén/encode WebRTC.

## 3. Các phương án khả thi

| **Phương án** | **Cần học sinh cài/mở gì?** | **Lấy raw gốc?** | **Độ khả thi** | **Ghi chú** |
| --- | --- | --- | --- | --- |
| Student Chrome extension | Có, cài extension | Có, gần nguồn nhất | Cao | Hook `getUserMedia()`, lấy frame/audio local, upload server/S3 |
| Student web app riêng | Có, mở web app + cấp quyền | Có | Cao | Không cần extension nhưng UX kém hơn vì phải mở thêm app/tab |
| Native app học sinh | Có, cài app | Có | Cao kỹ thuật | Ổn định hơn browser nhưng chi phí cao |
| Mentor extension | Không | Không | Trung bình | Chỉ lấy remote decoded stream hoặc màn hình Meet |
| Google Meet Media API | Không cài extension | Không phải raw gốc | Trung bình/Thấp | Hướng chính thức cho realtime media, nhưng có điều kiện |
| Meet REST API artifacts | Không | Không | Cao | Chỉ lấy recording/transcript/smart notes sau buổi học |

## 4. Phương án tối ưu đề xuất

`Student Chrome Extension -> hook getUserMedia() -> lấy raw frame sample + audio PCM/WebM -> upload batch về backend -> backend lưu local/S3 -> mentor dashboard xem lại hoặc realtime`

**Lý do chọn:**
- Lấy được data gần camera/mic gốc nhất.
- Không phụ thuộc vào mentor-side remote stream.
- Không cần reverse engineer sâu Google Meet RTC internals.
- Đã chứng minh được tính khả thi qua bản PoC.

## 5. Kết quả triển khai PoC

### Extension
- Hook `getUserMedia()`.
- Lấy video frame bằng `MediaStreamTrackProcessor` + `VideoFrame.copyTo(RGBA)`.
- Lấy audio sample bằng Web Audio API.
- Tạo thumbnail, audio preview, WebM chunk.
- Upload batch về API local mỗi 5 giây.

### Local API (Backend)
- Node Express chạy tại `http://localhost:8787`.
- Endpoint: `POST /api/capture/batch`.
- Lưu file vào: `captures/{meetingId}/{studentId}/{sessionId}/`.
- Cấu trúc file lưu trữ:
    - `frames/*.jpg` (Thumbnails)
    - `frames/*.rgba` (Raw data)
    - `audio/*.json` (Metadata)
    - `audio/*.f32` (Raw samples)
    - `recordings/*.webm` (Compressed media)
    - `manifest.json` (Tổng hợp session)

## 6. Giới hạn & Bước tiếp theo

**Giới hạn hiện tại:**
- PoC chạy local, chưa có Auth/S3 integration.
- Video raw sample 5s/lần để tránh quá tải (không phải 30fps liên tục).
- Cần sự đồng ý (consent) của người dùng do dữ liệu nhạy cảm.

**Đề xuất tiếp theo:**
- Tích hợp Upload S3.
- Xây dựng Dashboard cho Mentor để xem lại từ file `manifest.json`.
- Tối ưu Payload (WebP cho ảnh, Opus cho audio).
- Thêm giao diện quản lý Consent trong extension.
