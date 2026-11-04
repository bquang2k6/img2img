import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { generateImageFromGradio, resetGradioClient } from "./gradioService.js";
import { proxyState } from "./proxyManager.js";

const app = express();
const server = http.createServer(app);

import { Server } from "socket.io";
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  origLog(`🔗 Client connected to Socket.IO: ${socket.id}`);

  socket.on("disconnect", () => {
    origLog(`🔗 Client disconnected: ${socket.id}`);
  });
});

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

function mapLogToClientMessage(msg) {
  if (msg.includes("🎨 Nhận yêu cầu tạo ảnh mới")) return "Đang nhận yêu cầu";
  if (msg.includes("[Proxy] Khởi tạo Client")) return "Đang khởi tạo";
  if (msg.includes("✅ Kết nối Gradio client thành công")) return "Kết nối thành công!";
  if (msg.includes("❌ Lỗi từ AI Model trong quá trình tạo")) return "Lỗi từ AI Model trong quá trình tạo";

  const uploadMatch = msg.match(/Thử lần (\d+).*Đang gửi dữ liệu sang Hugging Face Space/);
  if (uploadMatch) return `Đang gửi dữ liệu lên server lần ${uploadMatch[1]}`;

  const proxyMatch = msg.match(/Bắt đầu quá trình chọn proxy để kết nối tới Gradio \(Thử lần (\d+)/);
  if (proxyMatch) return `Thử lại lần ${proxyMatch[1]}`;

  if (msg.includes("⌛ Đang trong hàng chờ")) return "Đang trong hàng chờ";
  if (msg.includes("⚡ uploading image")) return "Upload ảnh";
  if (msg.includes("✅ Lấy link ảnh trực tiếp thành công")) return "User nhận link ảnh";

  // Những log muốn giữ nguyên nội dung
  if (msg.includes("⚡ submitting edit task")) return msg;
  if (msg.includes("⚡ task submitted")) return msg;
  if (msg.includes("⚡ 📋 Task status: queued")) return msg;
  if (msg.includes("⚡ Generating... Almost done")) return msg;
  if (msg.includes("✨ Đã nhận phản hồi thành công từ AI Model")) return msg;

  return null; // Không gửi về client những log khác
}

console.log = (...args) => {
  const formattedTime = formatLogTime();
  origLog(formattedTime, ...args);
  const msg = typeof args[0] === 'string' ? args.join(" ") : JSON.stringify(args);

  const mappedMsg = mapLogToClientMessage(msg);
  if (mappedMsg) {
    io.emit("log", { time: formattedTime, message: mappedMsg, type: "info" });
  }
};

console.error = (...args) => {
  const formattedTime = formatLogTime();
  origError(formattedTime, ...args);
  const msg = typeof args[0] === 'string' ? args.join(" ") : JSON.stringify(args);

  const mappedMsg = mapLogToClientMessage(msg);
  if (mappedMsg) {
    io.emit("log", { time: formattedTime, message: mappedMsg, type: "error" });
  }
};

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

// Trả về cấu hình AI theo từng gói thành viên
app.post("/api/generate-image", (req, res) => {
  const plan = req.headers["x-user-plan"] || "free";
  
  if (plan === "pro") {
    return res.json({
      success: true,
      fastModel: {
        model: "p-image-edit",
        generateUrl: "https://playground.pruna.ai/api/p-image-edit/generate",
        statusUrl: "https://playground.pruna.ai/api/generation-status?model=p-image-edit"
      },
      normalModel: {
        model: "upsampler-qwen-image-edit",
        joinUrl: "https://upsampler-qwen-image-edit.hf.space/gradio_api/queue/join?",
        dataUrl: "https://upsampler-qwen-image-edit.hf.space/gradio_api/queue/data?session_hash=${session_hash}",
        uploadUrl: "https://upsampler-qwen-image-edit.hf.space/gradio_api/upload"
      },
      slowModel: {
        generateUrl: "https://ai.locket-wan.top/api/generate",
        limit: 5
      }
    });
  } else if (plan === "lite") {
    return res.json({
      success: true,
      normalModel: {
        model: "upsampler-qwen-image-edit",
        joinUrl: "https://upsampler-qwen-image-edit.hf.space/gradio_api/queue/join?",
        dataUrl: "https://upsampler-qwen-image-edit.hf.space/gradio_api/queue/data?session_hash=${session_hash}",
        uploadUrl: "https://upsampler-qwen-image-edit.hf.space/gradio_api/upload"
      },
      slowModel: {
        generateUrl: "https://ai.locket-wan.top/api/generate",
        limit: 2
      }
    });
  } else {
    // FREE
    return res.json({
      success: true,
      normalModel: {
        model: "upsampler-qwen-image-edit",
        joinUrl: "https://upsampler-qwen-image-edit.hf.space/gradio_api/queue/join?",
        dataUrl: "https://upsampler-qwen-image-edit.hf.space/gradio_api/queue/data?session_hash=${session_hash}",
        uploadUrl: "https://upsampler-qwen-image-edit.hf.space/gradio_api/upload"
      }
    });
  }
});

app.post("/api/generate", upload.single("image"), async (req, res) => {
  const file = req.file;
  const imageUrl = req.body.image_url;
  let prompt = req.body.prompt;
  let filterId = req.body.filter_id;

  if (!filterId && prompt) {
    try {
      const filtersData = JSON.parse(fs.readFileSync(path.join(process.cwd(), "filters.json"), "utf8"));
      const normalize = (s) => {
        let str = String(s).replace(/\\n/g, " ").replace(/\n/g, " ");
        str = str.replace(/[^a-zA-Z0-9]/g, "");
        return str.toLowerCase();
      };
      const normalizedPrompt = normalize(prompt);

      for (const category of filtersData) {
        for (const filter of category.filters) {
          if (filter.prompt && normalizedPrompt.includes(normalize(filter.prompt))) {
            filterId = filter.filter_id;
            break;
          }
        }
        if (filterId) break;
      }
    } catch (err) {
      console.error("Lỗi khi đọc filters.json:", err.message);
    }
  }

  if (filterId) {
    prompt = `${prompt} ${filterId}`;
  }

  // Tự động gắn thêm yêu cầu giữ nguyên tỷ lệ 1:1 vào đầu prompt nếu chưa có
  if (!prompt.includes("1:1 aspect ratio")) {
    prompt = `Maintain a 1:1 aspect ratio, exact same zoom level, original camera distance, and perspective. Do not crop or change the object scale. ${prompt}`;
  }

  if ((!file && !imageUrl) || !prompt) {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "Yêu cầu phải có file ảnh (hoặc image_url) và prompt" });
  }

  console.log("\n--------------------------------------------------");
  console.log("🎨 Nhận yêu cầu tạo ảnh mới...");
  if (filterId) {
    console.log(`🎯 Đã nhận diện Filter ID: ${filterId}`);
  } else {
    console.log("⚠️ Không tìm thấy Filter ID nào khớp với prompt.");
  }

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