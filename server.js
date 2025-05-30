require("dotenv").config();
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const cors = require("cors");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { getSubtitles } = require("youtube-captions-scraper");

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiter for all requests
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  message: { error: "Too many requests, please try again later." },
});
app.use(limiter);

// Rate limiter for heavy ops like caption and summarize
const heavyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 10,
  message: { error: "Too many heavy requests, wait and try again." },
});

// CORS config - adjust your allowed origins in env (comma separated)

app.use(cors({
  origin: "*",
  credentials: false,
}));


app.use(express.json({ limit: "10mb" }));

// Multer setup with memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"), false);
  },
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", pid: process.pid, time: new Date() });
});

app.get("/", (req, res) => {
  res.json({ message: "Vercel Express API Server", version: "2.0.0" });
});

// Image compression helper
async function compressImageFromBuffer(buffer, targetKB = 200) {
  const image = sharp(buffer);
  const metadata = await image.metadata();

  let { width, height } = metadata;
  const maxDim = 1920;
  if (width > maxDim || height > maxDim) {
    const ratio = Math.min(maxDim / width, maxDim / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  let quality = 85;
  let compressedBuffer;
  let minQ = 10,
    maxQ = 95;

  while (minQ <= maxQ) {
    quality = Math.floor((minQ + maxQ) / 2);

    compressedBuffer = await image
      .resize(width, height)
      .jpeg({ quality, progressive: true })
      .toBuffer();

    const sizeKB = compressedBuffer.length / 1024;

    if (sizeKB <= targetKB) minQ = quality + 1;
    else maxQ = quality - 1;

    if (Math.abs(sizeKB - targetKB) < 10) break;
  }

  return compressedBuffer;
}

// POST /caption - generate captions from uploaded image
app.post("/caption", heavyLimiter, upload.single("image"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, message: "No image uploaded" });

  try {
    const compressedBuffer = await compressImageFromBuffer(req.file.buffer, 200);
    const base64Image = compressedBuffer.toString("base64");

    const promptText = `
      You are a top-tier social media strategist with a flair for viral content.
      Given an image, write exactly two highly engaging captions (1–2 sentences each), optimized for Instagram or Twitter.
      Each caption must:
      - Be playful and catchy using witty, humorous, or clever language.
      - Include relevant and expressive emojis.
      - Use 2–3 trending or niche hashtags.
      - Match the platform tone: Instagram (aesthetic, aspirational), Twitter (punchy, conversational).
      - Encourage audience interaction with questions or calls-to-action.
      Format captions clearly for easy copy-paste.
    `;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { inline_data: { mime_type: "image/jpeg", data: base64Image } },
            { text: promptText },
          ],
        },
      ],
    };

    const response = await axios.post(
      `${process.env.GEMINI_API1_LINK}?key=${process.env.GEMINI_API_KEY}`,
      body,
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );

    const caption = response.data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!caption) throw new Error("No caption returned");

    res.json({ success: true, caption });
  } catch (error) {
    console.error("Error in /caption:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper to get YouTube transcript & summarize
async function summarizeYouTubeVideo(videoId) {
  try {
    // Try subtitles in Hindi, English, or auto
    const langs = [
      { code: "hi", name: "Hindi" },
      { code: "en", name: "English" },
      { code: null, name: "Auto" },
    ];

    let transcript = null;
    let usedLang = null;

    for (const lang of langs) {
      try {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000));
        const fetchTranscript = lang.code
          ? getSubtitles({ videoID: videoId, lang: lang.code })
          : getSubtitles({ videoID: videoId });

        transcript = await Promise.race([fetchTranscript, timeout]);
        usedLang = lang.name;
        break;
      } catch {
        continue;
      }
    }

    if (!transcript || transcript.length === 0) {
      throw new Error("No transcript available");
    }

    const transcriptText = transcript.map((t) => t.text).join(" ");
    const maxLen = 8000;
    const finalTranscript =
      transcriptText.length > maxLen ? transcriptText.substring(0, maxLen) + "..." : transcriptText;

    const prompt = `Provide a concise summary of this YouTube video transcript in 3-4 key points:\n\n${finalTranscript}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 500, temperature: 0.3 },
      },
      { headers: { "Content-Type": "application/json" }, timeout: 15000 }
    );

    const summary = response.data.candidates?.[0]?.content?.parts?.[0]?.text || "No summary generated.";

    return { summary, transcriptLanguage: usedLang };
  } catch (error) {
    throw error;
  }
}

// POST /summarize - summarize YouTube video by ID
app.post("/summarize", heavyLimiter, async (req, res) => {
  const { videoId } = req.body;

  if (!videoId)
    return res.status(400).json({ success: false, error: "videoId is required" });

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId))
    return res.status(400).json({ success: false, error: "Invalid videoId format" });

  try {
    const result = await summarizeYouTubeVideo(videoId);

    res.json({
      success: true,
      videoId,
      summary: result.summary,
      transcriptLanguage: result.transcriptLanguage,
    });
  } catch (error) {
    console.error("Error in /summarize:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

module.exports = app;
