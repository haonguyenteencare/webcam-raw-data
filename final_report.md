**BÁO CÁO TRIỂN KHAI: HỆ THỐNG GHI VÀ TẢI DỮ LIỆU WEBCAM/AUDIO GỐC (RAW)**

## **1. Tổng quan kiến trúc (Architecture)**

Hệ thống được thiết kế theo mô hình **Client-Server** thời gian thực:

- **Client (Chrome Extension):** Cài đặt trên máy học sinh. Can thiệp (Hook) trực tiếp vào luồng dữ liệu của Google Meet để lấy dữ liệu gốc (Raw) từ Camera và Micro trước khi bị nén bởi trình duyệt.
- **Server (Node.js API):** Chạy trên máy chủ (hoặc máy cá nhân). Tiếp nhận các gói dữ liệu từ Extension, phân loại và lưu trữ vào ổ cứng theo cấu trúc thư mục định danh học sinh.

## **2. Chi tiết triển khai (Implementation Details)**

### **A. Phía Extension (Học sinh)**

- **Cơ chế Hooking (`hook.js`):** Ghi đè hàm `navigator.mediaDevices.getUserMedia` và `RTCPeerConnection`. Điều này cho phép "nhân bản" luồng video/audio mà không làm ảnh hưởng đến cuộc họp Meet hiện tại.
- **Xử lý dữ liệu Raw:**
    - **Video:** Trích xuất các khung hình (frames) dưới dạng ảnh JPEG chất lượng cao hoặc RGBA thô. Sử dụng cơ chế **Video Batching** (gộp 10 frames/batch) để tối ưu truyền tải.
    - **Audio:** Thu thập dữ liệu âm thanh thô thông qua công nghệ **AudioWorklet** (chạy trên luồng riêng) để đảm bảo hiệu năng cao nhất.
- **Truyền tải dữ liệu (`background.js`):**
    - Dữ liệu được gom thành các **Batch** (lô) và gửi định kỳ mỗi **6 giây** thông qua hệ thống Alarm.
    - **Tính bền bỉ (Resilience):** Sử dụng `chrome.storage.session` để duy trì phiên làm việc. Hỗ trợ tự động tiếp nối ghi hình (Resume) ngay cả khi học sinh nhấn F5 hoặc tải lại trang.
    - **Streaming Upload:** Video được chia thành các đoạn nhỏ (Chunks) có đánh chỉ mục (`chunkIndex`), gửi lên server theo thời gian thực để tránh mất dữ liệu.

### **B. Phía Server (Máy chủ lưu trữ)**

- **Cấu trúc thư mục thông minh:** Dữ liệu được lưu tại `captures/[MeetingID]_[StudentID]_[StudentName]/[SessionID]/`.
- **Hợp nhất thư mục (Folder Merging):** Tự động phát hiện và di chuyển dữ liệu từ thư mục `unknown` sang thư mục có mã phòng họp chính xác ngay khi nhận diện được cuộc họp.
- **Thành phần lưu trữ:**
    - `/frames/`: Chứa các file ảnh `.jpg` và `.rgba` (webcam học sinh).
    - `/recordings/`: Chứa các đoạn video WebM (`.webm`) được đánh số thứ tự.
    - `manifest.json`: File mục lục chứa toàn bộ timeline của buổi học, cho phép ghép nối lại dữ liệu sau này.

---

## **3. Phân tích rủi ro và Phương hướng giải quyết (Scenario Analysis)**

| **Kịch bản rủi ro** | **Ảnh hưởng** | **Giải pháp đã triển khai** |
| --- | --- | --- |
| **Máy học sinh lag/yếu** | Ảnh hưởng đến việc học | Sử dụng **AudioWorklet** và **Video Batching** để giảm tải CPU và Network I/O. |
| **Mất kết nối mạng / F5** | Mất dữ liệu ghi | **Session Persistence:** Trạng thái ghi được lưu vào storage. Hệ thống tự động Resume và đánh chỉ mục tiếp nối sau khi có kết nối lại. |
| **Học sinh tắt máy/đóng tab** | Mất dữ liệu cuối | **Final Flush:** Sử dụng sự kiện `beforeunload` và `keepalive: true` để ép gửi dữ liệu cuối cùng lên server. |
| **Phân mảnh thư mục** | Khó quản lý dữ liệu | **Server-side Merging:** Tự động di chuyển folder từ `unknown-meeting` sang mã phòng thật ngay khi vào họp. |
| **Sai lệch ID học sinh** | Nhầm lẫn dữ liệu | Bắt buộc nhập `Student Label` và nhấn **Save ID** để khởi tạo folder định danh trên server trước khi quay. |

---

## **4. Kiểm thử khả năng chịu tải (Scalability & Stress-test)**

### **Scenario 1: 10 - 20 máy (Quy mô lớp học nhỏ)**
- **Trạng thái:** Hoạt động tốt trên máy chủ PC cá nhân cấu hình trung bình.
- **Băng thông:** Tối ưu hóa nhờ cơ chế Batching, mỗi máy tiêu tốn băng thông cực thấp (~50-100KB/s).

### **Scenario 2: 40 - 100 máy (Lớp học lớn)**
- **Giải pháp nâng cấp:** Sử dụng Load Balancer, Cloud Storage (S3) và Redis làm hàng đợi đệm để xử lý ghi đĩa đồng thời.

---

## **5. Kết quả thu được (Key Deliverables)**

1. **Dữ liệu thô chất lượng cao:** Thu được Audio và Video frame gốc không bị nén quá mức.
2. **Hệ thống bền bỉ:** Khả năng tự phục hồi sau khi F5 và đảm bảo không mất dữ liệu giây cuối.
3. **Quản lý nhất quán:** Toàn bộ dữ liệu của một phiên được gom vào một thư mục duy nhất trên server.

---

**Kế hoạch tiếp theo (Next Steps):**
- Triển khai công cụ ghép nối dữ liệu (Re-assembler).
- Thực hiện Stress-test thực tế với quy mô lớn hơn.

**Repository:** [https://github.com/haonguyenteencare/webcam-raw-data.git](https://github.com/haonguyenteencare/webcam-raw-data.git)
