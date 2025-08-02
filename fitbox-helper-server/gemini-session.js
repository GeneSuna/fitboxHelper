// gemini-session.js
import WebSocket from 'ws'; // Use the same WebSocket library for consistency
import { v4 as uuidv4 } from 'uuid';

/**
 * Manages a single WebSocket connection to the Gemini Live API.
 * Handles message proxying and session lifecycle.
 */
export class GeminiSession {
    constructor(clientWs, initialContext) {
        this.sessionId = uuidv4();
        this.clientWs = clientWs; // WebSocket connection to the Chrome extension client
        this.geminiWs = null;     // WebSocket connection to the Gemini API
        this.initialContext = initialContext || "You are a helpful voice assistant.";
        this.isConnectedToGemini = false;

        console.log(`[GeminiSession ${this.sessionId}] Created.`);

        // === DEBUGGING: Log environment variables inside GeminiSession constructor ===
        console.log(`[GeminiSession ${this.sessionId}] Constructor Check:`);
        console.log('  - process.env.GEMINI_API_HOST Exists:', !!process.env.GEMINI_API_HOST);
        console.log('  - process.env.GEMINI_API_KEY Exists:', !!process.env.GEMINI_API_KEY);
        // === END DEBUGGING ===

        if (!process.env.GEMINI_API_HOST || !process.env.GEMINI_API_KEY) {
            console.error(`[GeminiSession ${this.sessionId}] ERROR: Gemini API Host or Key not configured in environment variables.`);
            this._sendErrorToClient('Gemini API connection details are missing.');
            this.close();
            return;
        }

        console.log(`[GeminiSession ${this.sessionId}] Connecting to Gemini at ${process.env.GEMINI_API_HOST}...`);
        this._connectToGemini();
    }

    _connectToGemini() {
        // Construct the Gemini WebSocket URL using the correct path from Python example
        const host = process.env.GEMINI_API_HOST; // Should be wss://generativelanguage.googleapis.com
        const apiKey = process.env.GEMINI_API_KEY;
        const path = '/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'; // Use dot separator
        const modelName = 'gemini-2.0-flash-exp'; // Revert to experimental model, as 1.5-flash is not compatible with v1alpha endpoint

        if (!host || !apiKey) {
             console.error(`[GeminiSession ${this.sessionId}] ERROR: Cannot connect, Host or Key missing after check.`);
             // This shouldn't happen if the constructor check passed, but good practice
             this.close(); 
             return;
        }

        // Use API key in query parameter (worked in minimal test)
        const geminiUrl = `${host}${path}?key=${apiKey}`;

        try {
            console.log(`[GeminiSession ${this.sessionId}] Attempting WebSocket connection to: ${host}${path}`); // Log host and path separately for clarity
            this.geminiWs = new WebSocket(geminiUrl);
            const self = this; // Capture the correct 'this' context

            this.geminiWs.on('open', () => {
                console.log(`[GeminiSession ${self.sessionId}] Gemini WebSocket connection opened.`);
                self.isConnectedToGemini = true;

                // Send the required setup message
                // Example from potential docs - adjust based on actual v1alpha spec!
                const setupMessage = {
                    "setup": {
                       "model": "models/gemini-2.0-flash-exp", // Check if correct model name for live audio
                        "generationConfig": {
                            "responseModalities": ["TEXT", "AUDIO"]
                        }
                    }
                };
                console.log(`[GeminiSession ${self.sessionId}] Sending setup message:`, JSON.stringify(setupMessage));
                self.geminiWs.send(JSON.stringify(setupMessage));

                // Notify our client (extension) that we're ready
                console.log(`[GeminiSession ${self.sessionId}] Sending initial context/ready message to client.`);
                self.sendToClient({ type: 'ai_ready', context: self.initialContext });
            });

            this.geminiWs.on('message', (data) => {
                // Attempt to parse the data as JSON
                let message;
                try {
                    // Data might be Buffer, convert to string first
                    message = JSON.parse(data.toString());
                    console.log(`[GeminiSession ${self.sessionId}] Received Gemini message:`, JSON.stringify(message, null, 2));
                } catch (e) {
                    console.error(`[GeminiSession ${self.sessionId}] Failed to parse Gemini message:`, e);
                    console.error(`[GeminiSession ${self.sessionId}] Raw data received:`, data);
                    // Decide how to handle non-JSON data or parsing errors
                    // Maybe forward raw data if expecting binary (audio)?
                    // For now, just log error and maybe inform client.
                    self._sendErrorToClient('Received malformed data from AI service.');
                    return; // Stop processing this message
                }

                // Handle different message types from Gemini
                if (message.setupComplete) {
                    console.log(`[GeminiSession ${self.sessionId}] Setup complete confirmed by Gemini.`);
                    // Now safe to send user input / audio etc.
                    self._sendQueuedClientMessages(); // Send any messages queued before setup was complete

                } else if (message.serverContent) {
                    // Process content (text, audio) received from the server
                    self._proxyMessageToClient({ type: 'serverContent', content: message.serverContent });

                } else if (message.toolCall) {
                    // Handle function/tool calls if implemented
                    console.warn(`[GeminiSession ${self.sessionId}] Received unhandled tool call:`, message.toolCall);
                    // Send an error or default response back?

                } else if (message.toolCallCancellation) {
                    // Handle tool call cancellations if implemented
                    console.warn(`[GeminiSession ${self.sessionId}] Received unhandled tool call cancellation:`, message.toolCallCancellation);
                
                } else if (message.error) {
                    // Handle explicit errors from Gemini API (distinct from WS errors)
                    console.error(`[GeminiSession ${self.sessionId}] Received error message from Gemini:`, message.error);
                    self._sendErrorToClient(`AI service error: ${message.error.message || 'Unknown error'}`);

                } else {
                    console.warn(`[GeminiSession ${self.sessionId}] Received unknown message structure from Gemini:`, message);
                }
            });

            this.geminiWs.on('error', (error) => {
                // Log the specific error from the WebSocket connection attempt
                console.error(`[GeminiSession ${self.sessionId}] Gemini WebSocket error:`, error);
                self.isConnectedToGemini = false;
                // Send a more specific error message if possible
                const errorMessage = error?.message || 'Unknown AI service connection error';
                self._sendErrorToClient(`AI service connection error: ${errorMessage}`);
                // No need to call close() here, 'close' event will handle it
            });

            this.geminiWs.on('close', (code, reason) => {
                const reasonString = reason?.toString() || 'No reason provided';
                console.log(`[GeminiSession ${self.sessionId}] Gemini WebSocket closed. Code: ${code}, Reason: ${reasonString}`);
                self.isConnectedToGemini = false;
                self.geminiWs = null;
                // Notify the client, unless it was closed intentionally by the client already
                if (self.clientWs && self.clientWs.readyState === WebSocket.OPEN) {
                    // Avoid sending error if the closure was expected (e.g., code 1000)
                    if (code !== 1000) {
                         self._sendErrorToClient(`AI service connection closed unexpectedly. Code: ${code}`);
                    }
                } 
                 // Trigger session cleanup in index.js via the main close method
                 self.close(); // Ensure resources are released
            });

        } catch (error) {
            console.error(`[GeminiSession ${this.sessionId}] Failed to create Gemini WebSocket:`, error);
            this.isConnectedToGemini = false;
            this._sendErrorToClient('Failed to initiate AI service connection.');
            this.close();
        }
    }

    _sendInitialContextToGemini() {
        // IMPORTANT: This depends heavily on the Gemini Live API protocol.
        // It might require sending a specific JSON structure, initial audio silence,
        // or just starting to send audio chunks immediately.
        // Assuming a simple text message for context for now.
        const initialMessage = {
            // Example structure - ADJUST BASED ON ACTUAL API
            type: 'context', 
            content: this.initialContext
        };
        try {
            console.log(`[GeminiSession ${this.sessionId}] Sending initial context to Gemini:`, JSON.stringify(initialMessage));
            this.geminiWs.send(JSON.stringify(initialMessage));
        } catch (error) {
             console.error(`[GeminiSession ${this.sessionId}] Failed to send initial context to Gemini:`, error);
             this._sendErrorToClient('Failed to initialize AI session.');
        }
    }

    // Method to handle messages received FROM the client (via index.js)
    handleClientMessage(message) {
        if (!this.isConnectedToGemini) {
            console.warn(`[GeminiSession ${this.sessionId}] Received client message but not connected to Gemini. Ignoring.`);
            return;
        }

        // Message can be a JSON object (for commands) or a Base64 string (for audio)
        if (typeof message === 'object' && message !== null && message.type) {
            // Handle JSON commands
            console.log(`[GeminiSession ${this.sessionId}] Received parsed JSON OBJECT from client:`, message);
            if (message.type === 'context') {
                console.log(`[GeminiSession ${this.sessionId}] Handling 'context' update: ${message.context}. (Note: This is for context only, not sent to Gemini Live)`);
                this.currentContext = message.context;
            } else {
                console.warn(`[GeminiSession ${this.sessionId}] Received unknown JSON message type from client: ${message.type}`);
            }
        } else if (typeof message === 'string') {
            // Handle Base64 encoded audio data string
            // console.log(`[GeminiSession ${this.sessionId}] Received BASE64 message (audio) from client, Length: ${message.length}`);
            this.handleAudioInput(message); // Pass the Base64 string directly
        } else {
            console.warn(`[GeminiSession ${this.sessionId}] Received message of unexpected type from client: ${typeof message}`);
        }
    }

    // Receive message FROM Gemini and proxy TO the client (Chrome extension)
    _proxyMessageToClient(data) {
        // Ensure data is in the expected format before sending
        // Based on the new message handling, this might always be JSON now,
        // unless we explicitly handle raw audio buffers.
        if (this.clientWs && this.clientWs.readyState === WebSocket.OPEN) {
            try {
                let payload;
                if (Buffer.isBuffer(data)) {
                    // If it's raw audio buffer, might need specific handling/typing
                    // For now, assume JSON structure based on new message handler
                    console.warn(`[GeminiSession ${this.sessionId}] Attempting to send raw Buffer to client - check if client expects this.`);
                    payload = data; // Or convert/wrap appropriately
                } else if (typeof data === 'object') {
                    payload = JSON.stringify(data); // Assumes 'data' is the parsed message object
                } else {
                    payload = data.toString(); // Fallback for other data types
                }
                this.clientWs.send(payload);
            } catch (e) {
                console.error(`[GeminiSession ${this.sessionId}] Failed to proxy message to client:`, e);
            }
        } else {
            console.warn(`[GeminiSession ${this.sessionId}] Client WS not open, cannot proxy message.`);
        }
    }

    // Send a structured JSON message TO the client extension
    sendToClient(messageObject) {
         if (this.clientWs && this.clientWs.readyState === WebSocket.OPEN) {
             try {
                 const payload = JSON.stringify(messageObject);
                 console.log(`[GeminiSession ${this.sessionId}] Sending message to client:`, payload);
                 this.clientWs.send(payload);
             } catch (e) {
                 console.error(`[GeminiSession ${this.sessionId}] Failed to stringify or send message to client:`, e);
             }
         } else {
             console.warn(`[GeminiSession ${this.sessionId}] Client WS not open, cannot send message:`, messageObject);
         }
    }

    _sendQueuedClientMessages() {
        // Implement logic to send messages queued before setup complete
        // For now, just a placeholder
        console.log(`[GeminiSession ${this.sessionId}] Checking for queued client messages (implementation pending).`);
    }

    _sendErrorToClient(errorMessage) {
        if (this.clientWs && this.clientWs.readyState === WebSocket.OPEN) {
            try {
                 const errorPayload = JSON.stringify({ type: 'error', message: errorMessage });
                 console.log(`[GeminiSession ${this.sessionId}] Sent error to client: ${errorMessage}`);
                 this.clientWs.send(errorPayload);
            } catch (e) {
                 console.error(`[GeminiSession ${this.sessionId}] Failed to send error to client:`, e);
            }
        } else {
            console.warn(`[GeminiSession ${this.sessionId}] Client WS not open, cannot send error: ${errorMessage}`);
        }
    }

    /**
     * Handles incoming Base64-encoded audio data from the client.
     * Sends it to the Gemini API using the correct 'realtimeInput' payload structure.
     * @param {string} base64Audio The Base64 encoded PCM audio data.
     */
    handleAudioInput(base64Audio) {
        if (!this.geminiWs || this.geminiWs.readyState !== WebSocket.OPEN) {
            console.warn(`[GeminiSession ${this.sessionId}] Gemini WebSocket not open. Cannot send audio.`);
            return;
        }

        try {
            // The audio is already Base64 encoded PCM from index.js
            const audioMessage = {
                // Use realtimeInput structure based on documentation
                "realtimeInput": {
                    "media_chunks": [ base64Audio ]
                }
            };

            // console.log(`[GeminiSession ${this.sessionId}] Sending audio chunk (${base64Audio.length} chars) to Gemini.`);
            this.geminiWs.send(JSON.stringify(audioMessage));
        } catch (error) {
            console.error(`[GeminiSession ${this.sessionId}] Error processing/sending audio chunk:`, error);
        }
    }

    // Close connections gracefully
    close() {
        console.log(`[GeminiSession ${this.sessionId}] Closing session.`);
        if (this.geminiWs) {
            console.log(`[GeminiSession ${this.sessionId}] Closing Gemini WebSocket connection.`);
            this.geminiWs.close(1000, 'Session terminated by server'); // Use code 1000 for normal closure
            this.geminiWs = null;
        }
        this.isConnectedToGemini = false;
        // The client WS closure is typically handled by index.js when the session is removed
    }
}
