# Hướng dẫn kết nối & Tài liệu API — Img to Img (Kira 2.0 Image)

Dự án cung cấp hệ thống backend tạo và chỉnh sửa ảnh bằng AI (Image-to-Image / Text-to-Image) tích hợp mô hình **Kira 2.0 image (`kira-2.0-image`)** của [Kira AI](https://kiraai.vn/), hỗ trợ tự động nhận diện filter và cập nhật tiến trình qua Socket.IO.

---

## 1. Cài đặt & Cấu hình môi trường

### 1.1. Yêu cầu
Cài đặt [Rust & Cargo](https://rustup.rs/).

### 1.2. Thiết lập biến môi trường
Mở file `.env` và điền `KIRA_API_KEY` của bạn:
```env
PORT=4000
KIRA_API_KEY=your_actual_kira_api_key_here
KIRA_BASE_URL=https://kiraai.vn/api/v1
KIRA_MODEL=kira-2.0-image
```

### 1.3. Khởi chạy Server
```bash
cargo run
```
Hoặc build bản tối ưu:
```bash
cargo build --release
./target/release/img-to-img-server
```
Server sẽ chạy tại: `http://localhost:4000`

---

## 2. Danh sách Endpoints

### 2.1. Lấy danh sách Filter mẫu
* **Endpoint:** `GET /api/data`
* **Mô tả:** Trả về toàn bộ danh mục filter, icon, filter_id và prompt có sẵn trong file `filters.json`.
* **Phản hồi:**
```json
[
  {
    "id": "events",
    "title": "Events",
    "filters": [
      {
        "filter_id": "practical_magic_2",
        "filter_label": "Practical Magic 2",
        "prompt": "Preserve the original photo...",
        "icon_url": "https://..."
      }
    ]
  }
]
```

---

### 2.2. Tạo ảnh / Áp dụng Filter (`POST /api/generate`)
Hỗ trợ cả 2 định dạng: **`application/json`** (dùng URL ảnh) hoặc **`multipart/form-data`** (upload trực tiếp file ảnh).

#### Tham số truyền vào:
| Tham số | Kiểu | Bắt buộc | Mô tả |
| :--- | :--- | :--- | :--- |
| `prompt` | String | **Có** | Câu lệnh mô tả hiệu ứng muốn tạo hoặc chỉnh sửa. |
| `image_url` | String | Tùy chọn | Đường link ảnh gốc (khi gửi qua JSON). |
| `image` | File | Tùy chọn | File ảnh upload trực tiếp từ máy (khi gửi FormData). |
| `filter_id` | String | Tùy chọn | ID của filter (nếu không truyền, server sẽ tự quét `filters.json` dựa theo prompt). |

#### Phản hồi thành công (`200 OK`):
```json
{
  "success": true,
  "output": "https://storage.googleapis.com/.../result.png",
  "status": "completed"
}
```

#### Phản hồi lỗi (`4xx / 5xx`):
```json
{
  "error": "Mô tả chi tiết lỗi từ hệ thống hoặc Kira AI"
}
```

---

## 3. Mã nguồn mẫu kết nối API

### 3.1. JavaScript (Fetch API - Dùng link ảnh)
```javascript
const response = await fetch("http://localhost:4000/api/generate", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    image_url: "https://example.com/my-photo.jpg",
    prompt: "Show the persons with a realistic orange bob wig",
    filter_id: "okay_wig" // tùy chọn
  })
});

const data = await response.json();
if (data.success) {
  console.log("Ảnh kết quả:", data.output);
} else {
  console.error("Lỗi:", data.error);
}
```

---

### 3.2. JavaScript (Fetch API - Upload File ảnh trực tiếp)
```javascript
const formData = new FormData();
formData.append("image", fileInput.files[0]); // File từ thẻ <input type="file">
formData.append("prompt", "Show the persons with one front tooth missing");
formData.append("filter_id", "toothless");

const response = await fetch("http://localhost:4000/api/generate", {
  method: "POST",
  body: formData // Không đặt header Content-Type, trình duyệt tự xử lý boundary
});

const data = await response.json();
console.log(data.output);
```

---

### 3.3. cURL (Dòng lệnh)
**Dùng JSON:**
```bash
curl -X POST http://localhost:4000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://example.com/avatar.jpg",
    "prompt": "Show the persons with a realistic orange bob wig"
  }'
```

**Upload File:**
```bash
curl -X POST http://localhost:4000/api/generate \
  -F "image=@/duong/dan/toi/anh.jpg" \
  -F "prompt=Show the persons with a realistic orange bob wig"
```

---

### 3.4. Python
```python
import requests

url = "http://localhost:4000/api/generate"

# Cách 1: Gửi qua URL ảnh
payload = {
    "image_url": "https://example.com/my-photo.jpg",
    "prompt": "Show the person wearing hyperbolic influencer makeup"
}
res = requests.post(url, json=payload)
print(res.json())

# Cách 2: Upload file trực tiếp
files = {'image': open('my_photo.jpg', 'rb')}
data = {'prompt': 'Show the person wearing hyperbolic influencer makeup'}
res = requests.post(url, files=files, data=data)
print(res.json())
```

---

## 4. Kết nối Real-Time Log (Socket.IO)

Frontend có thể lắng nghe tiến trình tạo ảnh (đang gửi, đang nhận, hoàn tất) bằng Socket.IO client:

```html
<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io("http://localhost:4000");

  socket.on("connect", () => {
    console.log("Đã kết nối Socket.IO!");
  });

  socket.on("log", (data) => {
    // data có dạng: { time: "[16:30:10 | +1.2s]", message: "Tạo ảnh thành công!", type: "info" }
    console.log(`${data.time} ${data.message}`);
  });
</script>
```

