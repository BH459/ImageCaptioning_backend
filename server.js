require("dotenv").config();
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { getSubtitles } = require("youtube-captions-scraper");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Multer setup for file uploads
const upload = multer({ dest: "uploads/" });

// Compress image to target size (in KB)
async function compressToTargetSize(inputPath, outputPath, targetKB = 200) {
  let quality = 80;
  let buffer = await sharp(inputPath).jpeg({ quality }).toBuffer();

  while (buffer.length / 1024 > targetKB && quality > 10) {
    quality -= 5;
    buffer = await sharp(inputPath).jpeg({ quality }).toBuffer();
  }

  await sharp(buffer).toFile(outputPath);
  return buffer;
}

// API route to handle image upload and caption generation
app.post("/api/caption", upload.single("image"), async (req, res) => {
  try {
    const inputPath = req.file.path;
    // const outputPath = `uploads/compressed-${req.file.filename}.jpeg`;
    const outputPath = path.join('/tmp', `compressed-${req.file.filename}.jpeg`);

    const buffer = await compressToTargetSize(inputPath, outputPath, 200);
    const base64Image = buffer.toString("base64");

    const promptText = `
      You are a top-tier social media strategist with a flair for viral content.

      Given an image, write exactly two highly engaging captions (1–2 sentences each), optimized for Instagram or Twitter.

      Each caption must:
      - Be playful and catchy using witty, humorous, or clever language.
      - Include relevant and expressive emojis to enhance visual appeal.
      - Use 2–3 trending or niche hashtags.
      - Match the tone of the platform:
      - Instagram: aesthetic, aspirational
      - Twitter: punchy, conversational
      - Encourage audience interaction using questions, calls-to-action, or relatable humor.
      Format the output clearly so each caption is easy to copy-paste for social media.
    `;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: base64Image,
              },
            },
            {
              text: promptText,
            },
          ],
        },
      ],
    };

    const response = await axios.post(
      `${process.env.GEMINI_API1_LINK}?key=${process.env.GEMINI_API_KEY}`,
      body,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const caption = response.data.candidates?.[0]?.content?.parts?.[0]?.text;

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    if (caption) {
      res.json({ success: true, caption });
    } else {
      res.status(500).json({ success: false, message: "No caption returned." });
    }
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// Function to summarize YouTube video
async function summarizeYouTubeVideo(videoId) {
  try {
    console.log(`🎥 Processing video ID: ${videoId}`);

    let transcriptData;
    let usedLanguage;

    try {
      console.log("Attempting to fetch Hindi transcript...");
      transcriptData = await getSubtitles({ videoID: videoId, lang: "hi" });
      usedLanguage = "Hindi";
      console.log("✅ Hindi transcript found");
    } catch {
      console.log("❌ Hindi transcript not available, trying English...");
      try {
        transcriptData = await getSubtitles({ videoID: videoId, lang: "en" });
        usedLanguage = "English";
        console.log("✅ English transcript found");
      } catch {
        console.log("❌ English transcript also not available, trying auto-generated...");
        transcriptData = await getSubtitles({ videoID: videoId });
        usedLanguage = "Auto-detected";
        console.log("✅ Auto-generated transcript found");
      }
    }

    if (!transcriptData?.length) throw new Error("No transcript available.");

    const transcriptText = transcriptData.map(item => item.text).join(" ");

    let prompt = usedLanguage === "Hindi"
      ? `Summarize the following Hindi transcript of a YouTube video in Hindi:\n\n${transcriptText}`
      : `Summarize the following English transcript of a YouTube video:\n\n${transcriptText}`;

    console.log("🤖 Generating summary with Gemini...");

    const modelNames = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro"];
    let geminiResponse;
    let usedModel;

    for (const modelName of modelNames) {
      try {
        console.log(`Trying model: ${modelName}`);
        geminiResponse = await axios.post(
          `${process.env.GEMINI_API2_LINK}/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            contents: [
              {
                parts: [{ text: prompt }]
              }
            ]
          },
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
        usedModel = modelName;
        console.log(`✅ Successfully used model: ${modelName}`);
        break;
      } catch (error) {
        if (error.response?.status === 404) {
          console.log(`❌ Model ${modelName} not found, trying next...`);
        } else {
          throw error;
        }
      }
    }

    if (!geminiResponse) throw new Error("All Gemini models failed");

    const summary = geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text || "No summary generated.";

    return {
      summary,
      transcriptLanguage: usedLanguage,
      modelUsed: usedModel
    };

  } catch (error) {
    console.error("❌ Error summarizing video:", error.message || error);
    throw error;
  }
}

// API endpoint for summarizing
app.post("/api/summarize", async (req, res) => {
  try {
    const { videoId } = req.body;

    if (!videoId) return res.status(400).json({ error: "videoId is required" });

    const result = await summarizeYouTubeVideo(videoId);

    res.json({
      videoId,
      summary: result.summary,
      transcriptLanguage: result.transcriptLanguage,
      modelUsed: result.modelUsed,
      success: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message, success: false });
  }
});

app.get('/', (req, res) => {
  res.send('Hello from Express.js!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

module.exports = app;