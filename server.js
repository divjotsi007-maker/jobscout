import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { runJobScoutPipeline } from './pipeline.js';
import tinyfish from './tinyfish.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple In-Memory Rate Limiter
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS_PER_WINDOW = 60; // 60 searches per 15 mins

function rateLimiter(req, res, next) {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();

  const record = rateLimitMap.get(clientIp) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + RATE_LIMIT_WINDOW_MS;
  } else {
    record.count += 1;
  }

  rateLimitMap.set(clientIp, record);

  res.setHeader('X-RateLimit-Limit', MAX_REQUESTS_PER_WINDOW);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, MAX_REQUESTS_PER_WINDOW - record.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetAt / 1000));

  if (record.count > MAX_REQUESTS_PER_WINDOW) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
      retryAfter
    });
  }

  next();
}

/**
 * Health Check API
 */
app.get('/api/health', (req, res) => {
  const hasKey = tinyfish.hasValidApiKey();
  res.json({
    status: 'ok',
    service: 'JobScout DTU Bounty Server',
    tinyFishConfigured: hasKey,
    mode: hasKey ? 'live' : 'fallback-demo',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

/**
 * Config / Key status
 */
app.get('/api/config', (req, res) => {
  res.json({
    tinyFishConfigured: tinyfish.hasValidApiKey(),
    llmConfigured: Boolean(process.env.LLM_API_KEY && process.env.LLM_API_KEY.trim()),
    provider: process.env.LLM_PROVIDER || 'anthropic'
  });
});

/**
 * Handle SSE Search Execution
 */
async function handleSearchSSE(req, res, searchParams) {
  // Set SSE Headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Flush initial handshake
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', timestamp: Date.now() })}\n\n`);

  let isClientConnected = true;
  req.on('close', () => {
    isClientConnected = false;
  });

  const emit = (eventData) => {
    if (!isClientConnected) return;
    try {
      res.write(`event: progress\ndata: ${JSON.stringify(eventData)}\n\n`);
    } catch (err) {
      console.warn('[SSE] Failed to write to stream:', err.message);
    }
  };

  try {
    const result = await runJobScoutPipeline(searchParams, emit);

    if (isClientConnected) {
      res.write(`event: complete\ndata: ${JSON.stringify(result)}\n\n`);
      res.end();
    }
  } catch (error) {
    console.error('[SSE Error]', error);
    if (isClientConnected) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: error.message || 'Pipeline execution failed' })}\n\n`);
      res.end();
    }
  }
}

/**
 * POST /api/search - Main SSE Search endpoint
 */
app.post('/api/search', rateLimiter, (req, res) => {
  const searchParams = req.body || {};
  handleSearchSSE(req, res, searchParams);
});

/**
 * GET /api/search - Alternative SSE endpoint for EventSource
 */
app.get('/api/search', rateLimiter, (req, res) => {
  const searchParams = {
    role: req.query.role,
    location: req.query.location,
    skills: req.query.skills ? req.query.skills.split(',') : [],
    minSalary: req.query.minSalary ? parseInt(req.query.minSalary, 10) : 0,
    experienceLevel: req.query.experienceLevel || 'Any',
    jobType: req.query.jobType || 'Any',
    workplaceType: req.query.workplaceType || 'Any',
    useAgentFallback: req.query.useAgentFallback !== 'false',
    useDemoData: req.query.useDemoData === 'true'
  };

  handleSearchSSE(req, res, searchParams);
});

// Fallback route for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 JobScout DTU Bounty Server is running!`);
  console.log(`📍 Local URL: http://localhost:${PORT}`);
  console.log(`🔑 TinyFish API Key: ${tinyfish.hasValidApiKey() ? '✅ Configured (Live)' : '⚠️  Not set (Mock/Demo mode active)'}`);
  console.log(`====================================================`);
});
