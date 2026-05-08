# Báo cáo Tiến độ: Hệ thống Ghi hình & Thu âm Raw (Student-side)

## 1. Mục tiêu & Yêu cầu (Requirements)
- **Audio:** Thu âm chất lượng gốc của cả Mentor và Học sinh.
- **Video:** Thu hình chất lượng Raw (Raw local camera) từ phía học sinh.
- **Triển khai:** Extension cài đặt phía học sinh, tự động upload về server cá nhân.
- **Testing:** Đưa ra phương hướng upload testing và rủi ro.

## 2. Kết quả triển khai Kỹ thuật

### Audio (Mentor & Student)
- **Cơ chế:** 
    - **Student Audio:** Hook trực tiếp vào `getUserMedia`, lấy luồng Float32 PCM qua Web Audio API.
    - **Mentor Audio:** Hook vào `RTCPeerConnection.onTrack`, bắt tất cả các remote audio tracks. Được gán nhãn "Remote Media (Mentor/Others)" trong hệ thống.
- **Định dạng:** Lưu trữ dưới dạng WebM (Opus) bitrate 128kbps liên tục và các mẫu PCM (.f32) để phân tích sâu.

### Video Raw Quality (Student)
- **Cơ chế:** Sử dụng `MediaStreamTrackProcessor` (WebCodecs) để truy cập trực tiếp vào từng VideoFrame trước khi bị nén bởi WebRTC của Meet.
- **Chất lượng:** 
    - Ghi hình WebM với bitrate cao (**2.5 Mbps**) đảm bảo độ sắc nét tương đương raw local.
    - Chế độ "Research Raw": Xuất frame ảnh RGBA thô mỗi 5 giây để kiểm định chất lượng pixel gốc.

### Hệ thống Upload & Server
- **Cơ chế:** Upload theo Batch (gom cụm mỗi 5 giây) để giảm số lượng request.
- **Độ tin cậy:** Sử dụng thuật toán **Exponential Backoff** để tự động retry khi server lag hoặc mất kết nối.
- **Server:** Node.js Express tự động bóc tách dữ liệu binary để tối ưu tốc độ ghi đĩa.

## 3. Phương hướng Upload Testing
- **Smoke Test:** Kiểm tra việc nhận file tại `http://localhost:8787/health`.
- **Integrity Test:** So sánh Checksum của dữ liệu tại Extension và dữ liệu sau khi lưu trên Server.
- **Latency Test:** Đo khoảng thời gian từ lúc capture đến lúc file xuất hiện trên disk.

## 4. Phân tích Rủi ro (Risk Analysis)
- **Rủi ro máy học sinh (Lag/Crash):** Xử lý bằng cách giới hạn tần suất lấy mẫu frame RGBA và sử dụng Web Worker.
- **Rủi ro mạng (Unstable):** Dữ liệu được lưu tạm trong bộ nhớ/Local Storage và upload lại ngay khi có mạng.
- **Rủi ro Server (Down):** Extension sẽ giữ dữ liệu và thử lại với thời gian chờ tăng dần (backoff).

## 5. Limit Testing (Khả năng chịu tải)
- **Phía Máy ghi (Học sinh):** Đã kiểm tra mức chiếm dụng CPU khi capture 720p 30fps. Khuyến nghị máy có tối thiểu 4GB RAM.
- **Phía Máy chủ (Server):** 
    - Quy mô 10-20 máy: Node.js xử lý tốt trên single-core.
    - Quy mô 40+ máy: Cần chuyển sang lưu trữ S3 trực tiếp từ Extension để bypass nghẽn băng thông server.

---
*Nội dung này dùng để cập nhật lên Notion và cung cấp context cho AI.*
