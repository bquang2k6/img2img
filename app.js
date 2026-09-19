import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { generateImageFromGradio, resetGradioClient } from "./gradioService.js";
import { proxyState } from "./proxyManager.js";

// Override console.log và console.error để in kèm thời gian và khoảng cách (giây) giữa các lần log
let lastLogTime = Date.now();
const origLog = console.log;
const origError = console.error;

function formatLogTime() {
  const now = Date.now();
  const diff = ((now - lastLogTime) / 1000).toFixed(1);
  lastLogTime = now;
  const timeStr = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  return `[${timeStr} | +${diff}s]`;
}

console.log = (...args) => origLog(formatLogTime(), ...args);
console.error = (...args) => origError(formatLogTime(), ...args);

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Cấu hình lưu file tạm khi người dùng upload lên
const upload = multer({ dest: "uploads/" });

// Trả về filters.json để frontend hiển thị UI
app.get("/api/data", (req, res) => {
  res.sendFile(path.join(process.cwd(), "filters.json"));
});

app.post("/api/generate", upload.single("image"), async (req, res) => {
  const file = req.file;
  const imageUrl = req.body.image_url;
  const prompt = req.body.prompt;

  if ((!file && !imageUrl) || !prompt) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "Yêu cầu phải có file ảnh (hoặc image_url) và prompt" });
  }

  console.log("\n--------------------------------------------------");
  console.log("🎨 Nhận yêu cầu tạo ảnh mới...");

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { finalImageUrl, finalStatus } = await generateImageFromGradio(file, imageUrl, prompt, attempt, maxRetries);

      res.json({
        success: true,
        output: finalImageUrl,
        status: finalStatus,
      });
      break; // Kết thúc vòng lặp nếu thành công
    } catch (err) {
      console.error(`❌ Lỗi khi xử lý request (lần ${attempt}):`, err.message);

      if (proxyState.currentActiveProxy && !proxyState.bannedProxies.includes(proxyState.currentActiveProxy)) {
        proxyState.bannedProxies.push(proxyState.currentActiveProxy);
        console.log(`[Proxy] 🚫 Đã đưa ${proxyState.currentActiveProxy} vào danh sách đen do lỗi mất kết nối giữa chừng.`);
      }

      resetGradioClient();
      proxyState.currentActiveProxy = null;

      if (attempt === maxRetries) {
        res.status(500).json({ error: `Đã thử ${maxRetries} lần nhưng vẫn thất bại: ${err.message}` });
      } else {
        console.log(`⚠️ Hệ thống tự động tìm proxy mới và thử lại lần ${attempt + 1}...`);
      }
    }
  }

  // Xóa file sau khi đã xử lý xong
  if (file && fs.existsSync(file.path)) {
    fs.unlinkSync(file.path);
  }
});

server.listen(PORT, () => {
  console.log(`Server đang chạy tại http://localhost:${PORT}`);
});