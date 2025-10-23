// server.js
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;
const M3U_URL = 'https://cwdiptvb.github.io/tv_channels.m3u';
const SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes
const STREAM_TIMEOUT = 12000; // 12 seconds per stream test
const STREAMS_FILE = path.join(__dirname, 'streams.json');

// Store current working streams
let workingStreams = {};
let browser = null;

// Initialize browser
async function initBrowser() {
  if (!browser) {
    console.log('Launching headless browser...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    console.log('Browser launched');
  }
  return browser;
}

// Initialize streams file
async function initStreamsFile() {
  try {
    const data = await fs.readFile(STREAMS_FILE, 'utf8');
    workingStreams = JSON.parse(data);
    console.log('Loaded existing streams:', Object.keys(workingStreams).length);
  } catch (error) {
    console.log('No existing streams file, starting fresh');
    workingStreams = {};
    await saveStreams();
  }
}

// Save streams to file
async function saveStreams() {
  await fs.writeFile(STREAMS_FILE, JSON.stringify(workingStreams, null, 2));
  console.log('Saved streams to file');
}

// Parse M3U file
async function parseM3U() {
  try {
    const response = await axios.get(M3U_URL);
    const lines = response.data.split('\n');
    const streams = [];
    let currentEntry = {};

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXTINF:')) {
        const tvgIdMatch = line.match(/tvg-id="([^"]+)"/);
        const tvgNameMatch = line.match(/tvg-name="([^"]+)"/);
        
        if (tvgIdMatch) {
          currentEntry.tvgId = tvgIdMatch[1];
          currentEntry.name = tvgNameMatch ? tvgNameMatch[1] : tvgIdMatch[1];
        }
      } else if (line.includes('moveonjoy.com') && currentEntry.tvgId) {
        currentEntry.url = line;
        streams.push({ ...currentEntry });
        currentEntry = {};
      }
    }

    console.log(`Parsed ${streams.length} moveonjoy streams from M3U`);
    return streams;
  } catch (error) {
    console.error('Error parsing M3U:', error.message);
    return [];
  }
}

// Test stream using video.js in headless browser
async function testStreamURL(url) {
  const browser = await initBrowser();
  let page = null;
  
  try {
    page = await browser.newPage();
    
    // Set user agent to simulate real browser
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Create HTML page with video.js
    const html = `
<!DOCTYPE html>
<html>
<head>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/video.js/7.20.3/video-js.min.css" rel="stylesheet">
  <style>body { margin: 0; background: #000; }</style>
</head>
<body>
  <video id="player" class="video-js" controls autoplay muted></video>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/video.js/7.20.3/video.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/videojs-contrib-hls/5.15.0/videojs-contrib-hls.min.js"></script>
  <script>
    window.testResult = { status: 'testing', error: null };
    
    const player = videojs('player', {
      autoplay: true,
      muted: true,
      html5: {
        vhs: {
          overrideNative: true
        },
        nativeAudioTracks: false,
        nativeVideoTracks: false
      }
    });
    
    let resolved = false;
    
    player.on('playing', () => {
      if (!resolved) {
        resolved = true;
        window.testResult = { status: 'success', error: null };
        console.log('STREAM_SUCCESS');
      }
    });
    
    player.on('error', (e) => {
      if (!resolved) {
        resolved = true;
        const error = player.error();
        window.testResult = { 
          status: 'error', 
          error: error ? error.message : 'Unknown error',
          code: error ? error.code : null
        };
        console.log('STREAM_ERROR:', JSON.stringify(window.testResult));
      }
    });
    
    player.src({
      src: '${url}',
      type: 'application/x-mpegURL'
    });
  </script>
</body>
</html>`;

    await page.setContent(html);
    
    // Wait for either success or error
    const result = await Promise.race([
      // Wait for playing event
      page.waitForFunction(
        () => window.testResult && window.testResult.status === 'success',
        { timeout: STREAM_TIMEOUT }
      ).then(() => ({ success: true })),
      
      // Wait for error
      page.waitForFunction(
        () => window.testResult && window.testResult.status === 'error',
        { timeout: STREAM_TIMEOUT }
      ).then(() => ({ success: false })),
      
      // Timeout
      new Promise(resolve => 
        setTimeout(() => resolve({ success: false }), STREAM_TIMEOUT)
      )
    ]);
    
    await page.close();
    return result.success;
    
  } catch (error) {
    if (page) await page.close().catch(() => {});
    return false;
  }
}

// Find working stream (try current, then fl1-99)
async function findWorkingStream(tvgId, name, originalUrl) {
  console.log(`Testing ${name} (${tvgId})...`);

  // First try the current working stream if we have one
  if (workingStreams[tvgId]) {
    console.log(`  Trying current: ${workingStreams[tvgId]}`);
    const works = await testStreamURL(workingStreams[tvgId]);
    if (works) {
      console.log(`  ✓ Current stream still works`);
      return workingStreams[tvgId];
    }
    console.log(`  ✗ Current stream failed, trying original...`);
  }

  // Try the original URL from M3U
  console.log(`  Trying original: ${originalUrl}`);
  const works = await testStreamURL(originalUrl);
  if (works) {
    console.log(`  ✓ Original URL works`);
    return originalUrl;
  }

  console.log(`  ✗ Original failed, scanning fl1-99...`);

  // Scan through fl1-99
  const baseUrl = originalUrl.replace(/fl\d+\.moveonjoy\.com/, 'fl{N}.moveonjoy.com');
  
  for (let i = 1; i <= 99; i++) {
    const testUrl = baseUrl.replace('fl{N}', `fl${i}`);
    
    console.log(`  Testing fl${i}...`);
    
    const works = await testStreamURL(testUrl);
    if (works) {
      console.log(`  ✓ Found working stream: fl${i}`);
      return testUrl;
    }
  }

  console.log(`  ✗ No working stream found for ${name}`);
  return null;
}

// Main scan function
async function scanStreams() {
  console.log('\n=== Starting stream scan ===');
  console.log(new Date().toISOString());

  const streams = await parseM3U();
  if (streams.length === 0) {
    console.log('No streams to scan');
    return;
  }

  let updated = 0;
  let failed = 0;
  let unchanged = 0;

  for (const stream of streams) {
    const workingUrl = await findWorkingStream(stream.tvgId, stream.name, stream.url);
    
    if (workingUrl) {
      if (workingStreams[stream.tvgId] !== workingUrl) {
        console.log(`  → Updated ${stream.tvgId}: ${workingUrl}`);
        updated++;
      } else {
        unchanged++;
      }
      workingStreams[stream.tvgId] = workingUrl;
    } else {
      failed++;
      if (workingStreams[stream.tvgId]) {
        delete workingStreams[stream.tvgId];
        console.log(`  → Removed ${stream.tvgId} (no working stream found)`);
      }
    }

    // Small delay between streams
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  await saveStreams();
  
  console.log(`\n=== Scan complete ===`);
  console.log(`Working: ${Object.keys(workingStreams).length}`);
  console.log(`Updated: ${updated}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Failed: ${failed}`);
  console.log('========================\n');
}

// API endpoint to get stream by tvg-id
app.get('/', (req, res) => {
  const tvgId = req.query.id;
  
  if (!tvgId) {
    return res.status(400).json({ 
      error: 'Missing id parameter',
      usage: '/?id={tvg-id}',
      available: Object.keys(workingStreams).length,
      example: `/?id=${Object.keys(workingStreams)[0] || 'boomerang'}`
    });
  }

  const streamUrl = workingStreams[tvgId];
  
  if (!streamUrl) {
    return res.status(404).json({ 
      error: 'Stream not found or not working',
      tvgId: tvgId,
      available: Object.keys(workingStreams).length
    });
  }

  res.redirect(302, streamUrl);
});

// API endpoint to list all working streams
app.get('/list', (req, res) => {
  res.json({
    count: Object.keys(workingStreams).length,
    streams: workingStreams,
    lastUpdate: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    workingStreams: Object.keys(workingStreams).length,
    uptime: process.uptime()
  });
});

// Manual scan trigger
app.get('/scan', async (req, res) => {
  res.json({ message: 'Scan started', check: '/list for results' });
  scanStreams();
});

// Cleanup on exit
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

// Initialize and start
async function start() {
  await initBrowser();
  await initStreamsFile();
  
  console.log('Running initial scan...');
  await scanStreams();
  
  setInterval(scanStreams, SCAN_INTERVAL);
  console.log(`Scheduled scans every ${SCAN_INTERVAL / 1000 / 60} minutes`);
  
  app.listen(PORT, () => {
    console.log(`\nServer running on port ${PORT}`);
    console.log(`Stream endpoint: http://localhost:${PORT}/?id={tvg-id}`);
    console.log(`List streams: http://localhost:${PORT}/list`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

start().catch(console.error);
