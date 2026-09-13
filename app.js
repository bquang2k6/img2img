import "dotenv/config";
import express from "express";
import Replicate from "replicate";

const app = express();
const PORT = 3000;

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

app.use(express.json());
app.use(express.static("public"));

app.post("/api/generate", async (req, res) => {
  const { image_url, prompt } = req.body;
  if (!image_url || !prompt) {
    return res.status(400).json({ error: "image_url and prompt are required" });
  }

  try {
    const prediction = await replicate.predictions.create({
      model: "black-forest-labs/flux-kontext-pro",
      input: { input_image: image_url, prompt },
    });
    const result = await replicate.wait(prediction);
    res.json({ output: result.output });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
