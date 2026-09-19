import { Client, handle_file } from "@gradio/client";
import sharp from "sharp";
import { fetch as undiciFetch, Agent } from "undici";
import { findFastestProxy, applyProxy, proxyState } from "./proxyManager.js";
import fs from "fs";

export async function connectClientWithRetry() {
  console.log(`[Proxy] Bắt đầu quá trình chọn proxy để kết nối tới Gradio...`);
  const proxy = await findFastestProxy(8); // Lấy 8 proxy ngẫu nhiên để đua

  applyProxy(proxy);

  try {
    console.log(`[Proxy] Khởi tạo Client...`);
    const client = await Client.connect("selfit-camera/omni-image-editor", {
      events: ["data", "status", "log", "update", "generating"]
    });
    console.log(`✅ Kết nối Gradio client thành công!`);
    return client;
  } catch (err) {
    console.error(`❌ Kết nối thất bại với proxy ${proxy || 'direct'}:`, err.message);
    if (proxy) {
      if (!proxyState.bannedProxies.includes(proxy)) {
        proxyState.bannedProxies.push(proxy);
        console.log(`[Proxy] 🚫 Đã đưa ${proxy} vào danh sách đen do khởi tạo Client thất bại.`);
      }
      console.log("⚠️ Thử lại bằng kết nối trực tiếp (Direct IP)...");
      applyProxy(null);
      const client = await Client.connect("selfit-camera/omni-image-editor", {
        events: ["data", "status", "log", "update", "generating"]
      });
      console.log(`✅ Kết nối Gradio client (Direct IP) thành công!`);
      proxyState.currentActiveProxy = null;
      return client;
    } else {
      throw err;
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
          console.log(`📏 Đang tải và thu nhỏ ảnh về tối đa 500px...`);
          try {
            const imgRes = await undiciFetch(finalImageUrl, {
              dispatcher: new Agent(),
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              }
            });
            
            if (!imgRes.ok) {
                throw new Error(`HTTP ${imgRes.status} ${imgRes.statusText}`);
            }
            
            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
            
            const resizedBuffer = await sharp(imgBuffer)
              .resize({ width: 500, height: 500, fit: 'inside' })
              .jpeg({ quality: 85 })
              .toBuffer();
              
            finalImageUrl = `data:image/jpeg;base64,${resizedBuffer.toString("base64")}`;
            console.log("✅ Đã bóp nhỏ và nén Base64 thành công!");
          } catch (resizeErr) {
            console.error("⚠️ Lỗi khi resize ảnh:", resizeErr.message);
          }
        }
      } else {
        console.error("⚠️ Payload data không đúng định dạng:", msg);
      }
    }
  }

  return { finalImageUrl, finalStatus };
}
