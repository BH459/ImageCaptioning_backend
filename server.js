require("dotenv").config();
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const cors = require('cors');
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cluster = require('cluster');
const os = require('os');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { getSubtitles } = require("youtube-captions-scraper");

// Performance optimizations
const app = express();
const PORT = process.env.PORT || 3000;
const numCPUs = os.cpus().length;

// Enable clustering for multiple users
if (cluster.isMaster && process.env.NODE_ENV === 'production') {
  console.log(`🚀 Master process ${process.pid} is running`);
  
  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }
  
  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died. Restarting...`);
    cluster.fork();
  });
} else {
  startServer();
}

function startServer() {
  // Middleware for performance
  app.use(compression()); // Enable gzip compression
  
  // Rate limiting to prevent abuse
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
      error: 'Too many requests from this IP, please try again later.'
    }
  });
  app.use(limiter);

  // Specific rate limits for heavy operations
  const heavyOperationLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // Limit to 10 heavy operations per 5 minutes
    message: {
      error: 'Too many processing requests, please wait before trying again.'
    }
  });

  // CORS with specific origins for better security
  app.use(cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true
  }));
  
  app.use(express.json({ limit: '10mb' }));

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      pid: process.pid 
    });
  });

  app.get('/', (req, res) => {
    res.json({ message: 'Express.js API Server', version: '2.0.0' });
  });

  // Optimized multer setup with memory storage for better performance
  const upload = multer({ 
    storage: multer.memoryStorage(), // Use memory instead of disk
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB limit
      files: 1
    },
    fileFilter: (req, file, cb) => {
      // Only allow image files
      if (file.mimetype.startsWith('image/')) {
        cb(null, true);
      } else {
        cb(new Error('Only image files are allowed'), false);
      }
    }
  });

  // Cache for API responses (simple in-memory cache)
  const responseCache = new Map();
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // Cache middleware
  const cacheMiddleware = (keyGenerator) => {
    return (req, res, next) => {
      const key = keyGenerator(req);
      const cached = responseCache.get(key);
      
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`📦 Cache hit for key: ${key}`);
        return res.json(cached.data);
      }
      
      // Override res.json to cache the response
      const originalJson = res.json;
      res.json = function(data) {
        if (res.statusCode === 200) {
          responseCache.set(key, {
            data,
            timestamp: Date.now()
          });
          
          // Clean up old cache entries
          if (responseCache.size % 100 === 0) {
            cleanupCache();
          }
        }
        originalJson.call(this, data);
      };
      
      next();
    };
  };

  // Cache cleanup function
  const cleanupCache = () => {
    const now = Date.now();
    for (const [key, value] of responseCache.entries()) {
      if (now - value.timestamp > CACHE_TTL) {
        responseCache.delete(key);
      }
    }
  };

  // Optimized image compression with streaming
  async function compressImageFromBuffer(buffer, targetKB = 200) {
    try {
      const image = sharp(buffer);
      const metadata = await image.metadata();
      
      // Calculate optimal dimensions
      let { width, height } = metadata;
      const maxDimension = 1920; // Max width/height
      
      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      
      let quality = 85;
      let compressedBuffer;
      
      // Binary search for optimal quality
      let minQuality = 10;
      let maxQuality = 95;
      
      while (minQuality <= maxQuality) {
        quality = Math.floor((minQuality + maxQuality) / 2);
        
        compressedBuffer = await image
          .resize(width, height)
          .jpeg({ quality, progressive: true })
          .toBuffer();
        
        const sizeKB = compressedBuffer.length / 1024;
        
        if (sizeKB <= targetKB) {
          minQuality = quality + 1;
        } else {
          maxQuality = quality - 1;
        }
        
        // Break if we're close enough
        if (Math.abs(sizeKB - targetKB) < 10) break;
      }
      
      return compressedBuffer;
    } catch (error) {
      console.error("Error in image compression:", error);
      throw error;
    }
  }

  // Optimized caption generation with concurrency control
  const captionQueue = [];
  let activeCaptionRequests = 0;
  const MAX_CONCURRENT_CAPTIONS = 5;

  async function processCaptionQueue() {
    while (captionQueue.length > 0 && activeCaptionRequests < MAX_CONCURRENT_CAPTIONS) {
      const task = captionQueue.shift();
      activeCaptionRequests++;
      
      try {
        await task.process();
      } catch (error) {
        task.reject(error);
      } finally {
        activeCaptionRequests--;
      }
    }
  }

  // Caption API with queue management
  app.post("/caption", heavyOperationLimiter, upload.single("image"), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: "No image file uploaded" 
      });
    }

    // Add to queue
    const queuePromise = new Promise((resolve, reject) => {
      captionQueue.push({
        process: async () => {
          try {
            const startTime = Date.now();
            
            // Compress image from memory buffer
            const compressedBuffer = await compressImageFromBuffer(req.file.buffer, 200);
            const base64Image = compressedBuffer.toString("base64");

            const promptText = `
              You are a top-tier social media strategist with a flair for viral content.
              Given an image, write exactly two highly engaging captions (1–2 sentences each), optimized for Instagram or Twitter.
              Each caption must:
              - Be playful and catchy using witty, humorous, or clever language.
              - Include relevant and expressive emojis to enhance visual appeal.
              - Use 2–3 trending or niche hashtags.
              - Match the tone of the platform: Instagram: aesthetic, aspirational; Twitter: punchy, conversational
              - Encourage audience interaction using questions, calls-to-action, or relatable humor.
              Format the output clearly so each caption is easy to copy-paste for social media.
            `;

            const body = {
              contents: [{
                role: "user",
                parts: [
                  {
                    inline_data: {
                      mime_type: "image/jpeg",
                      data: base64Image,
                    },
                  },
                  { text: promptText }
                ],
              }],
            };

            const response = await axios.post(
              `${process.env.GEMINI_API1_LINK}?key=${process.env.GEMINI_API_KEY}`,
              body,
              {
                headers: { "Content-Type": "application/json" },
                timeout: 15000 // Reduced timeout
              }
            );

            const caption = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            const processingTime = Date.now() - startTime;

            if (caption) {
              resolve({ 
                success: true, 
                caption,
                processingTime: `${processingTime}ms`
              });
            } else {
              reject(new Error("No caption returned from AI service"));
            }
          } catch (error) {
            reject(error);
          }
        },
        reject
      });
    });

    try {
      processCaptionQueue();
      const result = await queuePromise;
      res.json(result);
    } catch (error) {
      console.error("❌ Error in /caption:", error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message || "Caption generation failed"
      });
    }
  });

  // Optimized YouTube summarization with caching
  async function summarizeYouTubeVideo(videoId) {
    const startTime = Date.now();
    
    try {
      console.log(`🎥 Processing video ID: ${videoId}`);
      
      // Try multiple transcript languages with timeout
      const transcriptPromises = [
        { lang: 'hi', name: 'Hindi' },
        { lang: 'en', name: 'English' },
        { lang: null, name: 'Auto-detected' }
      ];

      let transcriptData;
      let usedLanguage;

      for (const { lang, name } of transcriptPromises) {
        try {
          console.log(`Trying ${name} transcript...`);
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout')), 10000);
          });
          
          const transcriptPromise = lang ? 
            getSubtitles({ videoID: videoId, lang }) : 
            getSubtitles({ videoID: videoId });
          
          transcriptData = await Promise.race([transcriptPromise, timeoutPromise]);
          usedLanguage = name;
          console.log(`✅ ${name} transcript found`);
          break;
        } catch (error) {
          console.log(`❌ ${name} transcript failed:`, error.message);
          continue;
        }
      }

      if (!transcriptData || transcriptData.length === 0) {
        throw new Error('No transcript available for this video');
      }

      const transcriptText = transcriptData.map(item => item.text).join(' ');
      
      // Truncate very long transcripts for faster processing
      const maxLength = 8000;
      const finalTranscript = transcriptText.length > maxLength ? 
        transcriptText.substring(0, maxLength) + '...' : transcriptText;

      console.log(`✅ Using ${usedLanguage} transcript: ${finalTranscript.length} characters`);

      const prompt = `Provide a concise summary of this YouTube video transcript in 3-4 key points:\n\n${finalTranscript}`;

      // Use the most reliable model first
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            maxOutputTokens: 500, // Limit response length
            temperature: 0.3
          }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000
        }
      );

      const summary = response.data.candidates?.[0]?.content?.parts?.[0]?.text || 'No summary generated.';
      const processingTime = Date.now() - startTime;

      return {
        summary,
        transcriptLanguage: usedLanguage,
        processingTime: `${processingTime}ms`
      };

    } catch (error) {
      console.error('❌ Error summarizing video:', error.message);
      throw error;
    }
  }

  // YouTube summary API with caching
  app.post('/summarize', 
    heavyOperationLimiter,
    cacheMiddleware(req => `summary_${req.body.videoId}`),
    async (req, res) => {
      try {
        const { videoId } = req.body;
        
        if (!videoId) {
          return res.status(400).json({ error: 'videoId is required' });
        }

        // Basic validation for YouTube video ID format
        if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          return res.status(400).json({ error: 'Invalid YouTube video ID format' });
        }

        const result = await summarizeYouTubeVideo(videoId);
        
        res.json({
          videoId,
          summary: result.summary,
          transcriptLanguage: result.transcriptLanguage,
          processingTime: result.processingTime,
          success: true
        });
        
      } catch (error) {
        console.error('❌ Summarize error:', error.message);
        res.status(500).json({
          error: error.message,
          success: false
        });
      }
    }
  );

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('📴 SIGTERM received, shutting down gracefully');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('📴 SIGINT received, shutting down gracefully');
    process.exit(0);
  });

  app.listen(PORT, () => {
    console.log(`🚀 Worker ${process.pid} running at http://localhost:${PORT}`);
    console.log(`📊 Server optimized for ${numCPUs} CPU cores`);
  });
}

module.exports = app;