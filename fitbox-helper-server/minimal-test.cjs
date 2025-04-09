// minimal-test.js
const WebSocket = require('ws');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

const host = process.env.GEMINI_API_HOST; // Should be wss://generativelanguage.googleapis.com
const apiKey = process.env.GEMINI_API_KEY; // Use the key from your billed project (...j-XE)
const path = '/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'; // Use dot separator
const modelName = 'gemini-2.0-flash-exp'; // Use the experimental model name from Python example

if (!host || !apiKey) {
    console.error("ERROR: GEMINI_API_HOST or GEMINI_API_KEY missing in .env file.");
    process.exit(1);
}

// Construct URL with API key as query parameter
const url = `${host}${path}?key=${apiKey}`;
console.log(`Attempting WebSocket connection to: ${host}${path}`); // Log base path for clarity
// console.log(`Full URL (with key): ${url}`); // Uncomment to log full URL if needed

let ws;
try {
    // Attempt connection
    ws = new WebSocket(url);

    ws.on('open', () => {
        console.log('WebSocket connection opened successfully!');
        console.log(`Sending setup message with model: ${modelName}`);
        const setupMessage = {
            setup: {
                model: `models/${modelName}`, // Ensure 'models/' prefix
                generationConfig: {
                    responseModalities: ["TEXT", "AUDIO"]
                }
            }
        };
        ws.send(JSON.stringify(setupMessage));
        console.log('Setup message sent.');
    });

    ws.on('message', (data) => {
        console.log('Received message from Gemini:');
        try {
            const message = JSON.parse(data.toString());
            console.log(JSON.stringify(message, null, 2)); // Pretty print JSON
             // Add logic here to handle setupComplete, serverContent, etc.
             if (message.setupComplete && message.setupComplete.success) {
                console.log("Gemini setup complete!");
             } else if (message.serverContent) {
                console.log("Received server content (text/audio).");
             } else if (message.error) {
                 console.error("Received error message from Gemini:", message.error.message || message.error);
             }

        } catch (e) {
            console.error('Error parsing message:', e);
            console.log('Raw data:', data.toString());
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        // The 'Unexpected server response: 400' will trigger here
    });

    ws.on('close', (code, reason) => {
        console.log(`WebSocket closed. Code: ${code}, Reason: ${reason ? reason.toString() : 'No reason provided'}`);
    });

} catch (e) {
    console.error("Error creating WebSocket:", e);
}
