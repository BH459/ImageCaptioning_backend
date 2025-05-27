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

// Multer setup for file uploads - use /tmp directory for serverless
const upload = multer({ 
  dest: "/tmp/uploads/",
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Ensure /tmp/uploads directory exists
const ensureUploadDir = () => {
  const uploadDir = "/tmp/uploads";
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
};

// Compress image to target size (in KB)
async function compressToTargetSize(inputPath, outputPath, targetKB = 200) {
  try {
    let quality = 80;
    let buffer = await sharp(inputPath).jpeg({ quality }).toBuffer();

    while (buffer.length / 1024 > targetKB && quality > 10) {
      quality -= 5;
      buffer = await sharp(inputPath).jpeg({ quality }).toBuffer();
    }

    // Write to output path
    await fs.promises.writeFile(outputPath, buffer);
    return buffer;
  } catch (error) {
    console.error("Error in image compression:", error);
    throw error;
  }
}

// Safe file cleanup
const cleanupFile = async (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  } catch (error) {
    console.warn(`Warning: Could not delete file ${filePath}:`, error.message);
  }
};

// API route to handle image upload and caption generation
app.post("/api/caption", upload.single("image"), async (req, res) => {
  let inputPath = null;
  let outputPath = null;

  try {
    // Ensure upload directory exists
    ensureUploadDir();

    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: "No image file uploaded" 
      });
    }

    inputPath = req.file.path;
    outputPath = path.join('/tmp', `compressed-${req.file.filename}.jpeg`);

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

    if (!process.env.GEMINI_API1_LINK || !process.env.GEMINI_API_KEY) {
      throw new Error("Missing required environment variables: GEMINI_API1_LINK or GEMINI_API_KEY");
    }

    const response = await axios.post(
      `${process.env.GEMINI_API1_LINK}?key=${process.env.GEMINI_API_KEY}`,
      body,
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 30000 // 30 second timeout
      }
    );

    const caption = response.data.candidates?.[0]?.content?.parts?.[0]?.text;

    // Clean up files
    await cleanupFile(inputPath);
    await cleanupFile(outputPath);

    if (caption) {
      res.json({ success: true, caption });
    } else {
      res.status(500).json({ 
        success: false, 
        message: "No caption returned from AI service" 
      });
    }
  } catch (err) {
    console.error("❌ Error in /api/caption:", err.response?.data || err.message);
    
    // Clean up files in case of error
    if (inputPath) await cleanupFile(inputPath);
    if (outputPath) await cleanupFile(outputPath);

    const errorMessage = err.response?.data?.error?.message || err.message || "Unknown error occurred";
    res.status(500).json({ 
      success: false, 
      error: errorMessage 
    });
  }
});

// Function to summarize YouTube video
async function summarizeYouTubeVideo(videoId) {
  try {
    console.log(`🎥 Processing video ID: ${videoId}`);

    if (!videoId || typeof videoId !== 'string') {
      throw new Error("Invalid video ID provided");
    }

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
        try {
          transcriptData = await getSubtitles({ videoID: videoId });
          usedLanguage = "Auto-detected";
          console.log("✅ Auto-generated transcript found");
        } catch (transcriptError) {
          throw new Error(`No transcript available for video ID: ${videoId}. Error: ${transcriptError.message}`);
        }
      }
    }

    if (!transcriptData?.length) {
      throw new Error("No transcript data available for this video");
    }

    const transcriptText = transcriptData
      .map(item => item.text)
      .join(" ")
      .trim();

    if (transcriptText.length < 10) {
      throw new Error("Transcript too short to summarize");
    }

    let prompt = usedLanguage === "Hindi"
      ? `Summarize the following Hindi transcript of a YouTube video in Hindi. Provide a comprehensive summary covering the main points:\n\n${transcriptText}`
      : `Summarize the following English transcript of a YouTube video. Provide a comprehensive summary covering the main points:\n\n${transcriptText}`;

    console.log("🤖 Generating summary with Gemini...");

    if (!process.env.GEMINI_API2_LINK || !process.env.GEMINI_API_KEY) {
      throw new Error("Missing required environment variables: GEMINI_API2_LINK or GEMINI_API_KEY");
    }

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
            },
            timeout: 30000 // 30 second timeout
          }
        );
        usedModel = modelName;
        console.log(`✅ Successfully used model: ${modelName}`);
        break;
      } catch (error) {
        console.log(`❌ Error with model ${modelName}:`, error.response?.data || error.message);
        if (error.response?.status === 404) {
          console.log(`Model ${modelName} not found, trying next...`);
        } else if (modelNames.indexOf(modelName) === modelNames.length - 1) {
          // Last model, throw the error
          throw error;
        }
      }
    }

    if (!geminiResponse) {
      throw new Error("All Gemini models failed to generate summary");
    }

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

    if (!videoId) {
      return res.status(400).json({ 
        error: "videoId is required",
        success: false 
      });
    }

    const result = await summarizeYouTubeVideo(videoId);

    res.json({
      videoId,
      summary: result.summary,
      transcriptLanguage: result.transcriptLanguage,
      modelUsed: result.modelUsed,
      success: true
    });
  } catch (error) {
    console.error("❌ Error in /api/summarize:", error.message);
    res.status(500).json({ 
      error: error.message,
      success: false 
    });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'AI Caption & Summarizer API is running!',
    timestamp: new Date().toISOString(),
    endpoints: [
      'POST /api/caption - Generate captions for images',
      'POST /api/summarize - Summarize YouTube videos'
    ]
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('Global error handler:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

module.exports = app;