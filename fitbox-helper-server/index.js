// index.js - Main WebSocket Server
import dotenv from 'dotenv';
dotenv.config(); // Load .env file variables

// === DEBUGGING: Log environment variables after dotenv.config() ===
console.log('[Index.js] After dotenv.config():');
console.log('  - GEMINI_API_KEY Loaded:', !!process.env.GEMINI_API_KEY); // Log true/false if loaded
console.log('  - GEMINI_API_HOST Loaded:', !!process.env.GEMINI_API_HOST);
// console.log('  - Key Preview:', process.env.GEMINI_API_KEY?.substring(0, 5) + '...'); // Avoid logging full key
// === END DEBUGGING ===

import { WebSocketServer } from 'ws';
import http from 'http';
import url from 'url';
import { GeminiSession } from './gemini-session.js';
import { getKnowledgeForScreen } from './knowledge.js';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import stream from 'stream';
import fs from 'fs'; // For potential temp file cleanup if streams fail

// Configure dotenv
dotenv.config();

// --- Set Ffmpeg Path ---
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
// --- End Ffmpeg Path ---

const PORT = process.env.PORT || 3001;

// Create a simple HTTP server. The WebSocket server will attach to it.
const server = http.createServer((req, res) => {
    // Basic health check endpoint
    if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Create WebSocket server and attach it to the HTTP server
const wss = new WebSocketServer({ server });

console.log(`WebSocket server starting on port ${PORT}...`);

// --- Transcoding Function ---
/**
 * Transcodes audio data (expected as a buffer, likely from WebM/Opus)
 * to raw PCM format (16-bit, 16kHz, mono) and returns it as a Base64 string.
 * @param {Buffer} inputBuffer The input audio data buffer.
 * @returns {Promise<string>} A promise that resolves with the Base64 encoded PCM audio data.
 */
function transcodeAudioToBase64Pcm(inputBuffer) {
    return new Promise((resolve, reject) => {
        console.log(`[Transcode] Starting transcoding for buffer of size: ${inputBuffer.length}`);
        const outputStream = new stream.PassThrough();
        const chunks = [];

        outputStream.on('data', (chunk) => {
            chunks.push(chunk);
        });

        outputStream.on('end', () => {
            const outputBuffer = Buffer.concat(chunks);
            console.log(`[Transcode] Transcoding finished. Output PCM buffer size: ${outputBuffer.length}`);
            const base64Pcm = outputBuffer.toString('base64');
            resolve(base64Pcm);
        });

        outputStream.on('error', (err) => {
            console.error('[Transcode] Output stream error:', err);
            reject(new Error(`Transcoding output stream error: ${err.message}`));
        });

        const command = ffmpeg(stream.Readable.from(inputBuffer)) // Input from buffer stream
            .inputFormat('webm') // Specify input format (adjust if necessary, e.g., 'ogg')
            .audioCodec('pcm_s16le') // Output codec: signed 16-bit little-endian PCM
            .audioChannels(1)        // Output channels: mono
            .audioFrequency(16000)   // Output sample rate: 16kHz
            .format('s16le')         // Output container format for raw PCM
            .on('start', (commandLine) => {
                console.log('[Transcode] FFmpeg command started:', commandLine);
            })
            .on('error', (err, stdout, stderr) => {
                console.error('[Transcode] FFmpeg Error:', err.message);
                console.error('[Transcode] FFmpeg stderr:', stderr);
                reject(new Error(`FFmpeg transcoding failed: ${err.message}`));
            })
            .pipe(outputStream, { end: true }); // Pipe output to our stream
    });
}
// --- End Transcoding Function ---

wss.on('connection', (ws, req) => {
    // Assign a unique ID to the client WebSocket for easier tracking
    ws.clientId = uuidv4().substring(0, 8); // Short ID for logging

    // Extract screen context from connection URL query parameters
    const queryParams = url.parse(req.url, true).query;
    const screenContext = queryParams.screen || 'initial'; // Default screen context

    console.log(`[Server] Client ${ws.clientId} connected. Request URL: ${req.url}, Screen Context: '${screenContext}'`);

    // Get initial knowledge based on screen context
    const initialKnowledge = getKnowledgeForScreen(screenContext);
    const initialPrompt = `${initialKnowledge}\n\nYou are a helpful, concise voice assistant for the fitbox application. Respond naturally for voice output.`;

    // Session is NOT created yet. Wait for 'start_ai_session' message.
    ws.geminiSession = null; // Initialize placeholder

    // Handle messages received FROM the specific client (Chrome extension)
    ws.on('message', async (message, isBinary) => {
        // Handle incoming messages (JSON control messages or binary audio)
        if (isBinary) {
            // Binary data (audio)
            console.log(`[WebSocket] Received BINARY message (audio chunk), Size: ${message.length} bytes`);
            // Pass the raw buffer directly
            if (ws.geminiSession) {
                ws.geminiSession.handleClientMessage(message); // <<< PASS RAW BUFFER
            } else {
                console.warn('[WebSocket] Received audio chunk for a non-existent session.');
            }
        } else {
            // Text data (should be JSON)
            const messageString = message.toString();
            console.log('[WebSocket] Received TEXT message:', messageString);
            try {
                const parsedMessage = JSON.parse(messageString);
                console.log('[WebSocket] Parsed JSON message:', parsedMessage);

                if (parsedMessage.type === 'start_ai_session') {
                    console.log(`[WebSocket] Received 'start_ai_session' message for client ${ws.clientId}.`);
                    console.log(`[Server] Client ${ws.clientId} requested AI session start.`);
                    if (!ws.geminiSession) {
                        console.log(`[Server] Creating Gemini session for client ${ws.clientId}...`);
                        ws.geminiSession = new GeminiSession(ws, initialPrompt);
                        // The GeminiSession constructor now handles connecting and sending ai_ready
                    } else {
                        console.warn(`[Server] Client ${ws.clientId} sent start_ai_session but session already exists.`);
                    }
                } else if (ws.geminiSession) {
                    // Pass the parsed JSON object to the existing session
                    ws.geminiSession.handleClientMessage(parsedMessage); // <<< PASS PARSED OBJECT
                } else {
                    console.warn(`[Server] Client ${ws.clientId} sent message before AI session started or unknown message type. Ignoring.`);
                }
            } catch (e) {
                console.error(`[WebSocket] Error parsing JSON message from client ${ws.clientId}:`, e);
                // Optionally close connection if protocol violation
            }
        }
    });

    // Handle client disconnection
    ws.on('close', (code, reason) => {
        const session = ws.geminiSession;
        const sessionId = session ? session.sessionId : 'unknown';
        console.log(`[Server] Client ${ws.clientId} disconnected. Session ID: ${sessionId}. Code: ${code}, Reason: ${reason?.toString()}`);

        if (session) {
            session.close(); // Gracefully close the Gemini connection for this session
            ws.geminiSession = null; // Clear reference
            console.log(`[Server] Cleaned up session ${sessionId} for client ${ws.clientId}.`);
        } else {
            console.log(`[Server] Client ${ws.clientId} disconnected without an active session to clean up.`);
        }
    });

    // Handle client WebSocket errors
    ws.on('error', (error) => {
        const session = ws.geminiSession;
        const sessionId = session ? session.sessionId : 'unknown';
        console.error(`[Server] WebSocket error for client ${ws.clientId} (Session ${sessionId}):`, error);

        // Attempt cleanup if a session exists
        if (session) {
            session.close();
            ws.geminiSession = null; // Clear reference
            console.log(`[Server] Cleaned up session ${sessionId} for client ${ws.clientId} due to client error.`);
        }
        // The 'close' event will usually fire after an error, handling final cleanup.
    });
});

// Handle WebSocket server-level errors
wss.on('error', (error) => {
    console.error('[Server] WebSocket Server Error:', error);
});

// Start the HTTP server (which the WebSocket server is attached to)
server.listen(PORT, () => {
    console.log(`[Server] HTTP and WebSocket server listening on http://localhost:${PORT}`);
});

// Graceful shutdown handling
process.on('SIGINT', () => {
    console.log('\n[Server] SIGINT received. Shutting down gracefully...');
    wss.close(() => {
        console.log('[Server] WebSocket server closed.');
        server.close(() => {
            console.log('[Server] HTTP server closed.');
            process.exit(0);
        });
    });

    // Force close sessions if needed after a delay
    setTimeout(() => {
        console.error('[Server] Forceful shutdown after timeout.');
        process.exit(1);
    }, 5000); // 5 seconds grace period
});
