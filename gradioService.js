import { Client, handle_file } from "@gradio/client";
import sharp from "sharp";
import { fetch as undiciFetch, Agent } from "undici";
import { findFastestProxy, applyProxy, proxyState } from "./proxyManager.js";
import fs from "fs";

export async function connectClientWithRetry(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[Proxy] Bắt đầu quá trình chọn proxy để kết nối tới Gradio (Thử lần ${attempt}/${maxRetries})...`);
    const proxy = await findFastestProxy(8); // Lấy 8 proxy ngẫu nhiên để đua

    if (!proxy) {
      console.log("⚠️ Không tìm thấy proxy nào hoạt động. Đang thử lại...");
      continue;
    }

    applyProxy(proxy);

    try {
      console.log(`[Proxy] Khởi tạo Client...`);
      const client = await Client.connect("selfit-camera/omni-image-editor", {
        events: ["data", "status", "log", "update", "generating"]
      });
      console.log(`✅ Kết nối Gradio client thành công!`);
      return client;
    } catch (err) {
      console.error(`❌ Kết nối thất bại với proxy ${proxy}:`, err.message);
      if (!proxyState.bannedProxies.includes(proxy)) {
        proxyState.bannedProxies.push(proxy);
        console.log(`[Proxy] 🚫 Đã đưa ${proxy} vào danh sách đen do khởi tạo Client thất bại.`);
      }

      if (attempt === maxRetries) {
        console.error("❌ Đã hết số lần thử kết nối Gradio bằng Proxy.");
        throw err;
      }
    }
  }
}

let gradioClient = null;
export async function getGradioClient() {
  if (!gradioClient) {
    gradioClient = await connectClientWithRetry();
  }
  return gradioClient;
}

export function resetGradioClient() {
  gradioClient = null;
}

export async function generateImageFromGradio(file, imageUrl, prompt, attempt, maxRetries) {
  const client = await getGradioClient();

  let imageInput;
  let origWidth = null;
  let origHeight = null;

  try {
    let inputBuffer;
    if (file) {
      inputBuffer = fs.readFileSync(file.path);
    } else if (imageUrl) {
      const fetchRes = await undiciFetch(imageUrl);
      inputBuffer = Buffer.from(await fetchRes.arrayBuffer());
    }

    if (inputBuffer) {
      const metadata = await sharp(inputBuffer).metadata();
      origWidth = metadata.width;
      origHeight = metadata.height;
    }
  } catch (err) {
    console.error("⚠️ Không thể đọc kích thước ảnh gốc:", err.message);
  }

  if (file) {
    const fileBuffer = fs.readFileSync(file.path);
    const fileObj = new File([fileBuffer], file.originalname || "upload.jpg", { type: file.mimetype || "image/jpeg" });
    imageInput = handle_file(fileObj);
  } else {
    imageInput = handle_file(imageUrl);
  }

  console.log(`⏳ [Thử lần ${attempt}/${maxRetries}] Đang gửi dữ liệu sang Hugging Face Space... Vui lòng đợi...`);

  let finalImageUrl = null;
  let finalStatus = null;

  for await (const msg of client.submit("/edit_image_interface", [imageInput, prompt])) {
    if (["status", "update", "generating"].includes(msg.type)) {
      const stage = msg.stage || msg.status?.stage;
      const progress_data = msg.progress_data || msg.status?.progress_data;
      const queue_index = msg.queue_index ?? msg.status?.queue?.position ?? 0;

      if (progress_data && progress_data[0]) {
        const progress = progress_data[0];
        if (progress.length > 0) {
          console.log(`⚡ Đang tạo ảnh: ${Math.round((progress.index / progress.length) * 100)}% (${progress.unit || 'bước'}) - ${progress.desc || ''}`);
        } else if (progress.desc) {
          console.log(`⚡ ${progress.desc}`);
        }
      } else if (stage === "pending") {
        console.log(`⌛ Đang trong hàng chờ (Queue position: ${queue_index})`);
      } else if (stage === "generating") {
        console.log("⚡ Đang tạo ảnh...");
      } else if (stage === "error") {
        const message = msg.message || msg.status?.message || "Model trả về trạng thái lỗi";
        console.error(`❌ Lỗi từ AI Model trong quá trình tạo: ${message}`);
        throw new Error(message);
      }
    } else if (msg.type === "data") {
      console.log("✨ Đã nhận phản hồi thành công từ AI Model!");
      if (msg.data && Array.isArray(msg.data)) {
        const htmlOutput = msg.data[0];
        finalStatus = msg.data[2] || msg.data[1];

        const srcMatch = htmlOutput?.match(/src=["'](.*?)["']/);
        finalImageUrl = srcMatch ? srcMatch[1] : null;
        if (finalImageUrl) {
          console.log("✅ Lấy link ảnh trực tiếp thành công:", finalImageUrl);
        }
      } else {
        console.error("⚠️ Payload data không đúng định dạng:", msg);
      }
    }
  }

  return { finalImageUrl, finalStatus };
}
