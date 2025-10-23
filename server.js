// server.js
const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const M3U_URL = 'https://cwdiptvb.github.io/tv_channels.m3u';
const SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes
const STREAM_TIMEOUT = 10000; // 10 seconds per stream test
const STREAMS_FILE = path.join(__dirname, 'streams.json');

// Store current working streams
let workingStreams = {};

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
        // Extract tvg-id
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

// Test stream by attempting to fetch and parse the m3u8 manifest
async function testStreamURL(url) {
  try {
    // First, try to fetch the manifest
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), STREAM_TIMEOUT);

    const response = await axios.get(url, {
      signal: controller.signal,
      timeout: STREAM_TIMEOUT,
      validateStatus: (status) => status === 200,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    clearTimeout(timeoutId);

    // Check if response looks like a valid m3u8 file
    const content = response.data;
    if (typeof content === 'string' && 
        (content.includes('#EXTM3U') || content.includes('#EXT-X-STREAM-INF') || content.includes('.ts'))) {
      
      // Additional validation: try to fetch the first segment URL if it's a master playlist
      if (content.includes('#EXT-X-STREAM-INF')) {
        // It's a master playlist, extract the first variant
        const lines = content.split('\n');
        for (let line of lines) {
          line = line.trim();
          if (line && !line.startsWith('#')) {
            // Found a variant playlist URL
            let variantUrl = line;
            if (!variantUrl.startsWith('http')) {
              // Relative URL, construct absolute
              const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
              variantUrl = baseUrl + variantUrl;
            }
            
            // Try to fetch the variant playlist
            try {
              const variantResponse = await axios.get(variantUrl, {
                timeout: 5000,
                validateStatus: (status) => status === 200,
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
              });
              
              // Check if variant playlist is valid
              if (typeof variantResponse.data === 'string' && 
                  variantResponse.data.includes('#EXTINF')) {
                return true;
              }
            } catch (e) {
              // Variant fetch failed, but manifest was valid
              return false;
            }
            break;
          }
        }
      }
      
      // Direct media playlist or successful validation
      return true;
    }

    return false;
  } catch (error) {
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
      // Remove from working streams if it exists
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

  // Redirect to the actual stream
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

// Manual scan trigger (for testing)
app.get('/scan', async (req, res) => {
  res.json({ message: 'Scan started', check: '/list for results' });
  scanStreams(); // Run in background
});

// Initialize and start
async function start() {
  await initStreamsFile();
  
  // Run initial scan
  console.log('Running initial scan...');
  await scanStreams();
  
  // Schedule periodic scans
  setInterval(scanStreams, SCAN_INTERVAL);
  console.log(`Scheduled scans every ${SCAN_INTERVAL / 1000 / 60} minutes`);
  
  // Start server
  app.listen(PORT, () => {
    console.log(`\nServer running on port ${PORT}`);
    console.log(`Stream endpoint: http://localhost:${PORT}/?id={tvg-id}`);
    console.log(`List streams: http://localhost:${PORT}/list`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}

start().catch(console.error);
