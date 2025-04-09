// background.js - Service Worker

// --- Configuration ---
// Make sure this matches the PORT in your server/.env file
const SERVER_URL = 'ws://localhost:3001'; 

// --- Global State ---
let ws = null;
let connectionState = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'error'
let retryTimeout = null;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const MAX_RETRY_DELAY = 30000; // 30 seconds
let currentRetryDelay = INITIAL_RETRY_DELAY;
let connectionInitiatedByUser = false; // Track if connection was started by user action
let currentScreenContext = 'Unknown'; // Context from fitbox tab
const FITBOX_PATTERN = /^https?:\/\/([a-zA-Z0-9-]+\.)*fitbox\.iq\//i;
let currentMicrophoneLabel = "-"; // Add state variable for the label

// Offscreen document configuration
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let creatingOffscreenDocument = false; // Flag to prevent race conditions
let offscreenReady = false; // Track if offscreen document has signaled readiness
let backgroundToOffscreenPort = null; // Port FROM Background TO Offscreen

// --- Utility Functions ---
async function getCurrentFitboxTab() {
    try {
        // Prioritize active tab in current window
        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && FITBOX_PATTERN.test(tab.url)) {
            return tab;
        }
        // If active tab isn't fitbox, check other tabs in the *current* window
        let allTabs = await chrome.tabs.query({ currentWindow: true });
        let fitboxTab = allTabs.find(t => t.url && FITBOX_PATTERN.test(t.url));
        return fitboxTab; // Returns the first found fitbox tab or undefined
    } catch (error) {
        console.error("Error querying tabs:", error);
        return undefined;
    }
}

// --- WebSocket Management ---
function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("WebSocket already open.");
        setConnectionState('connected', 'Already connected'); // Re-notify state
        return;
    }
    if (connectionState === 'connecting') {
        console.log("WebSocket connection already in progress.");
        return;
    }

    setConnectionState('connecting', 'Attempting connection...');

    // Note: Offscreen setup is now initiated by setConnectionState('connected') or from popup
    // Get context *before* connecting
    getCurrentFitboxTab().then(tab => {
            let context = 'Unknown'; // Default context
            if (tab && tab.url) {
                try {
                    const url = new URL(tab.url);
                    context = url.pathname.substring(1).replace(/[^a-zA-Z0-9_-]/g, '_') || 'Dashboard';
                } catch { context = 'Fitbox_Tab'; }
                currentScreenContext = context;
                console.log(`Fitbox context updated: ${currentScreenContext}`);
            } else {
                currentScreenContext = 'Non-Fitbox_Tab'; 
                console.warn("Connecting without an active fitbox tab context.");
            }

           // Proceed with connection after context update
           console.log(`Attempting to connect WebSocket to ${SERVER_URL}...`);
           try {
               ws = new WebSocket(SERVER_URL); // URL defined globally

               ws.onopen = () => {
                   console.log('[WebSocket] Connection opened.');
                   retryCount = 0; // Reset retry count on successful connection
                   console.log('[WebSocket] Open. Triggering offscreen document setup...');
                   setupOffscreenDocument();
               };

               ws.onmessage = (event) => {
                   if (!ws) {
                       console.warn("Received WebSocket message after connection was closed or cleared.");
                       return;
                   }

                   // Log raw data and parsed message for debugging
                   console.log("[WebSocket] Raw server data:", event.data);

                   try {
                       const message = JSON.parse(event.data);
                       console.log("[WebSocket] Parsed server message:", message);

                       console.debug(`[WebSocket] Received message:`, message); // Original debug log

                       // Ignore internally generated messages (basic check)
                       if (message.type === 'internal') return;

                       handleServerMessage(message);
                   } catch (error) {
                       console.error("Error parsing WebSocket message:", error);
                       console.error("Original data:", event.data);
                   }
               };

               ws.onerror = (error) => {
                   console.error('WebSocket error:', error);
                   // Don't transition state here directly, wait for onclose to decide on retry
               };

               ws.onclose = (event) => {
                   console.log(`WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}, Clean: ${event.wasClean}`);
                   const oldWs = ws; // Capture the closing ws instance
                   ws = null; // Clear the global instance

                   // Check if this closure is for the *current* connection attempt and not manual
                   if (oldWs && connectionState !== 'disconnected') { 
                       const errorMessage = event.reason ? `Connection closed: ${event.reason}` : `Connection lost (Code: ${event.code})`;
                       // Use sendErrorToPopup which also sets state to 'error'
                       sendErrorToPopup(errorMessage); 

                       // Only attempt retry if the connection was initially started by the user
                       if (connectionInitiatedByUser) {
                           scheduleReconnect(); // Schedule retry
                       }
                   } else {
                        console.log("WebSocket closed cleanly or already handled.");
                   }
               };

           } catch (error) {
               console.error("WebSocket instantiation failed:", error);
               const errorMsg = `Failed to connect: ${error.message}`;
               sendErrorToPopup(errorMsg); // This sets state to error
               // Attempt retry if connection was previously user-initiated
               if (connectionInitiatedByUser) {
                   scheduleReconnect(); // Schedule retry
               }
           }
       }).catch(tabError => {
           // Error during getCurrentFitboxTab
           console.error("Failed to get tab context before WebSocket connection:", tabError);
           const errorMsg = "Error determining fitbox context.";
           sendErrorToPopup(errorMsg); // This sets state to error
           // Don't retry automatically if we can't even get context
           connectionInitiatedByUser = false; // Prevent retries if initial context fails
       });
}

function closeWebSocket(manualDisconnect = true) {
    console.log(`Closing WebSocket. Manual: ${manualDisconnect}`);
    clearTimeout(retryTimeout);
    retryTimeout = null;
    currentRetryDelay = INITIAL_RETRY_DELAY; // Reset delay for next manual connection attempt

    // If closed manually by user, prevent auto-reconnect
    if (manualDisconnect) {
        connectionInitiatedByUser = false; 
    }

    const wsToClose = ws; // Capture current ws instance
    ws = null; // Clear global ref immediately to prevent race conditions

    if (wsToClose) {
        console.log("Calling ws.close() on instance...");
        // Prevent onclose handler from triggering retries if we are closing deliberately
        wsToClose.onclose = null; 
        wsToClose.onerror = null; 
        wsToClose.onmessage = null;
        wsToClose.onopen = null;
        wsToClose.close(1000, manualDisconnect ? "Client disconnected" : "Closing connection"); 
    }

     // Ensure state reflects disconnection immediately ONLY if manual
     // If closing due to error, setConnectionState('error') or sendErrorToPopup() handles it
     if (manualDisconnect && connectionState !== 'disconnected') {
         setConnectionState('disconnected', 'Helper disconnected'); // This triggers offscreen/audio stop
     } else {
        console.log("WebSocket instance cleared. State handled by caller or prior error.");
        // Ensure audio/offscreen are stopped if not a manual disconnect
        // (setConnectionState handles this, but call for safety if needed)
        // stopOffscreenAudioCapture();
        // closeOffscreenDocument();
     }
}

/**
 * Processes messages received from the backend WebSocket server.
 * @param {object} message - The already parsed message object from the server.
 */
function handleServerMessage(message) {
    console.debug("[handleServerMessage] Processing:", message); // Log the received object

    // Input validation: Ensure message is an object and has a type
    if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
        console.error("[handleServerMessage] Received invalid message format:", message);
        // Optionally send an error back or handle appropriately
        return;
    }

    switch (message.type) {
        case 'tts':
            if (typeof message.text === 'string') {
                console.log("Received TTS request from server:", message.text.substring(0, 50) + "...");
                // Use Chrome's TTS engine
                chrome.tts.speak(message.text, { 'rate': 1.0 });
            } else {
                console.error("[handleServerMessage] Invalid 'tts' message format:", message);
            }
            break;

        case 'audio_response':
            // Placeholder: Handle raw audio data if the server sends it
            console.log("Received audio response from server (size/type check needed). Handling not implemented.");
            // Example: If data is Base64 encoded in message.payload
            // const audioBlob = base64ToBlob(message.payload, 'audio/webm'); // Need a utility function
            // playAudioBlob(audioBlob); // Need a utility function
            break;

        case 'status': // e.g., { type: 'status', message: 'AI connection ready.' }
             if (typeof message.message === 'string') {
                 console.log("Status update from server:", message.message);
                 // Potentially update UI or internal state based on status
             } else {
                 console.error("[handleServerMessage] Invalid 'status' message format:", message);
             }
            break;

        case 'error':
            const errorMsg = message.message || message.error || 'Unknown server error'; // Handle message or error property
            console.error(`[handleServerMessage] Received error from server: ${errorMsg}`);
            sendErrorToPopup(`Server error: ${errorMsg}`);
            setConnectionState('error', `Server error: ${errorMsg}`);
            // Optionally close the connection on critical errors
            closeWebSocket(false); // Don't auto-reconnect on server-reported errors
            break;

        case 'ai_ready': // Server confirms Gemini session is setup and ready
            console.log("[handleServerMessage] AI session is ready.");
            // Optional: Update UI or trigger other actions now that AI is confirmed ready
            // Example: updatePopupState('AI Ready');
            break;

        default:
            console.warn(`[handleServerMessage] Received unhandled message type: ${message.type}`, message);
    }
}

function sendMessageToServer(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log(`[Background] (sendMessageToServer) Preparing to send type: ${message.type}...`); // <<< ADDED LOG
        try {
            const messageString = JSON.stringify(message);
            // console.log("Sending message to server:", messageString); 
            ws.send(messageString);
        } catch (error) {
            console.error("Failed to stringify or send JSON message:", error);
            sendErrorToPopup("Failed to send data to server.", false);
        }
        console.log(`[Background] (sendMessageToServer) ...type ${message.type} sent.`); // <<< ADDED LOG
    } else {
        console.warn(`[Background] Cannot send message type ${message.type}: WebSocket not open.`);
    }
}

function sendAudioChunkToServer(audioBlob) {
    console.log("[sendAudioChunkToServer] Function entered."); // <<< Log entry
    
    // Check WebSocket state before sending
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log(`[sendAudioChunkToServer] WebSocket is OPEN. Attempting to send Blob of size: ${audioBlob.size}`); // <<< Log before send
        try {
            ws.send(audioBlob);
            console.log("[sendAudioChunkToServer] ws.send() executed successfully."); // <<< Log after send
        } catch (error) {
            console.error("[sendAudioChunkToServer] Error during ws.send():", error);
        }
    } else {
        console.warn(
            `[sendAudioChunkToServer] Attempted to send audio chunk, but WebSocket is not open. State: ${ws ? readyStateToString(ws.readyState) : 'null'}`
        );
    }
}

// --- Text-to-Speech --- 
function speakText(text) {
    if (!text) return;
    chrome.tts.speak(text, { 
        lang: 'en-US', // Adjust language as needed
        rate: 1.0, 
        pitch: 1.0,
        onEvent: (event) => {
            if (event.type === 'error') {
                console.error('TTS Error:', event.errorMessage);
            }
            // console.log('TTS Event:', event.type);
        }
    }, () => {
         if (chrome.runtime.lastError) {
             console.error("TTS Speak failed:", chrome.runtime.lastError.message);
         }
    });
}

// --- Offscreen Document Management ---
async function hasOffscreenDocument(path) {
  if (chrome.runtime.getContexts) { // Manifest V3 check
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(path)]
    });
    return contexts.length > 0;
  } else { // Manifest V2 fallback (though we are V3)
    const views = chrome.extension.getViews({ type: 'OFFSCREEN_DOCUMENT' });
    return views.some(view => view.location.href === chrome.runtime.getURL(path));
  }
}

async function setupOffscreenDocument() {
    console.log("Checking if offscreen document setup is needed...");
    if (creatingOffscreenDocument) {
        console.log("Offscreen document creation already in progress.");
        return;
    }
     const path = OFFSCREEN_DOCUMENT_PATH;
     // Ensure the existing document is still functioning, might need re-connection logic
    if (await hasOffscreenDocument(path)) {
        console.log("Offscreen document already exists.");
        // --- Try reconnecting port if it exists but port is null ---
        if (!backgroundToOffscreenPort) {
            console.log("Offscreen exists but port is not connected. Attempting to connect port...");
            connectPortToOffscreen();
        }
        // --- End reconnect logic ---
        else if (!offscreenReady) {
             console.log("Offscreen document exists and port connected, but hasn't reported ready. Waiting...");
        } else {
            // If it exists, port is connected, and is ready, ensure audio capture starts if needed
            if(connectionState === 'connected') {
                 console.log("[Background] Offscreen already set up and ready. Triggering capture start.");
                 startOffscreenAudioCapture(); // Trigger capture if needed
            }
        }
        return;
    }

    creatingOffscreenDocument = true;
    try {
        console.log("Creating offscreen document...");
        await chrome.offscreen.createDocument({
            url: path,
            reasons: [chrome.offscreen.Reason.USER_MEDIA],
            justification: 'Microphone access for real-time voice commands to fitbox helper.',
        });
        console.log("Offscreen document creation initiated.");

        // --- Connect the port AFTER creation is initiated ---
        connectPortToOffscreen();
        // --- End Connect Port ---

    } catch (error) {
        console.error("Error creating offscreen document:", error);
        sendErrorToPopup(`Failed to initialize audio capture: ${error.message}`);
        setConnectionState('error', 'Audio setup failed');
        closeWebSocket(false); // Close connection if audio setup fails crucially
    } finally {
        creatingOffscreenDocument = false;
    }
}

// Function to establish the port connection to the offscreen document
function connectPortToOffscreen() {
    if (backgroundToOffscreenPort) {
        console.log("[Background] Port to offscreen already exists or connection attempt in progress.");
        return;
    }
    console.log("[Background] Attempting to connect port to offscreen document...");
    backgroundToOffscreenPort = chrome.runtime.connect({ name: 'offscreen-audio-port' });

    backgroundToOffscreenPort.onMessage.addListener(handleOffscreenMessage);

    backgroundToOffscreenPort.onDisconnect.addListener(() => {
        console.warn("[Background] Port to offscreen disconnected.");
        backgroundToOffscreenPort = null;
        offscreenReady = false; // Assume offscreen is no longer ready
        // Handle potential need to recreate offscreen or reconnect
        if (connectionState !== 'disconnected' && connectionState !== 'error') {
             console.log("[Background] Offscreen port disconnected unexpectedly. Attempting to re-setup offscreen document.");
             setConnectionState('connecting', 'Re-initializing audio...'); // Indicate intermediate state
             setupOffscreenDocument(); // Attempt to recreate/reconnect
        }
    });
     console.log("[Background] Port connection attempt to offscreen initiated.");
}

// Function to send a message TO the offscreen document via the port
function sendToOffscreen(action, payload = null) {
    if (backgroundToOffscreenPort) {
        try {
            console.log(`[Background] Sending action '${action}' to offscreen.`);
            backgroundToOffscreenPort.postMessage({ action, payload });
        } catch (error) {
            console.error(`[Background] Error sending message to offscreen: ${error}`);
            // Handle error, maybe the port disconnected?
            if (backgroundToOffscreenPort && backgroundToOffscreenPort.error) {
                 console.error("[Background] Port error:", backgroundToOffscreenPort.error);
            }
        }
    } else {
        console.warn(`[Background] Cannot send action '${action}' to offscreen: Port not connected.`);
        // If trying to start capture but port isn't connected, attempt setup again
        if (action === 'startAudioCapture') {
            console.log("[Background] Attempting to setup offscreen document because port was missing for start command.");
            setupOffscreenDocument();
        }
    }
}

// Handle messages FROM the Offscreen Document via Port
function handleOffscreenMessage(message) {
    console.log("[Background Port Listener] Received from Offscreen:", message?.action);
    if (!message || !message.action) {
        console.warn("[Background Port Listener] Invalid message format from offscreen.");
        return;
    }

    switch (message.action) {
        case 'offscreenReady':
            console.log("[Background] Received 'offscreenReady' message from offscreen."); // <<< ADDED LOG
            console.log("[Background] Offscreen document reported ready.");
            offscreenReady = true;
            // Now that offscreen is ready AND WS should be open (since setup was triggered by onOpen)
            if (ws && ws.readyState === WebSocket.OPEN) {
                 console.log("[Background] Offscreen ready and WS Open. Setting state to connected.");
                 setConnectionState('connected', 'Helper connected');
 
                 console.log('[Background] Sending start_ai_session...');
                 sendStartAISession(); // Send START first
 
                 console.log('[Background] Sending context message...');
                 sendMessageToServer({ type: 'context', context: currentScreenContext }); // Send CONTEXT second
 
                 console.log('[Background] Starting offscreen audio capture...');
                 startOffscreenAudioCapture(); // Start CAPTURE last
            } else {
                 console.error("[Background] Offscreen ready, but WebSocket is unexpectedly not open! State:", ws?.readyState);
                 setConnectionState('error', 'WS connection lost before ready');
            }
            break;
        case 'audioChunk':
            // console.log("[Background] Received Base64 audio chunk from offscreen, length:", message.data?.length);
            if (ws && ws.readyState === WebSocket.OPEN && message.data) {
                 // Decode Base64 back to binary (ArrayBuffer/Buffer) before sending
                 const audioBuffer = base64ToArrayBuffer(message.data);
                 if (audioBuffer) {
                     // console.log(`[Background] Sending binary audio data (${audioBuffer.byteLength} bytes) to server.`);
                     ws.send(audioBuffer); // Send as binary
                 } else {
                      console.error("[Background] Failed to decode Base64 audio chunk from offscreen.");
                 }
            } else {
                 // console.warn("[Background] Received audio chunk but WebSocket not open or no data.");
            }
            break;
         case 'microphoneLabel': // Handle the new message
             console.log(`[Background] Received microphone label from offscreen: ${message.label}`);
             // Store it or send it directly to popup
             currentMicrophoneLabel = message.label; // Store it
             updatePopupState(); // Send updated state (including label) to popup
             break;
        case 'audioError':
            console.error("[Background] Received audio error from offscreen:", message.message);
            sendErrorToPopup(`Audio Capture Error: ${message.message}`);
            // Consider stopping the session or attempting restart?
             setConnectionState('error', 'Audio Capture Error');
             stopOffscreenAudioCapture(); // Stop capture attempt
            break;
         case 'offscreenError': // General errors from offscreen
              console.error("[Background] Received general error from offscreen:", message.error);
              sendErrorToPopup(`Offscreen Error: ${message.error}`);
              setConnectionState('error', 'Offscreen Error');
             stopOffscreenAudioCapture();
             break;
        default:
            console.warn("[Background] Received unknown action from offscreen port:", message.action);
    }
}

// --- Functions to control Offscreen Audio ---
function startOffscreenAudioCapture() {
    console.log("[Background] Requesting offscreen document to START audio capture...");
    sendToOffscreen('startAudioCapture');
}

function stopOffscreenAudioCapture() {
     console.log("[Background] Requesting offscreen document to STOP audio capture...");
     sendToOffscreen('stopAudioCapture');
}

// Close the offscreen document
async function closeOffscreenDocument() {
    console.log("Attempting to close offscreen document...");
     stopOffscreenAudioCapture(); // Tell it to stop capture first
    if (await hasOffscreenDocument(OFFSCREEN_DOCUMENT_PATH)) {
        await chrome.offscreen.closeDocument();
        console.log("Offscreen document closed.");
    } else {
        console.log("No active offscreen document to close.");
    }
    offscreenReady = false;
    if (backgroundToOffscreenPort) {
        backgroundToOffscreenPort.disconnect();
        backgroundToOffscreenPort = null;
    }
}

// --- Message Handling (from Popup, Offscreen) ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`Background received message: action='${message.action}'`, message);
    let isAsync = false;

    switch (message.action) {
        // --- Popup Interactions ---
        case 'initiateConnection':
             if (connectionState === 'connected' || connectionState === 'connecting') {
                 console.log("Connection already active or pending.");
                 setConnectionState(connectionState); // Re-send current state to popup
                 sendResponse({ success: true, message: "Connection already active or pending." });
             } else {
                 console.log("Popup requested connection initiation.");
                 connectionInitiatedByUser = true; // Mark intent
                 connectWebSocket(); // Start connection process
                 sendResponse({ success: true }); // Acknowledge request
             }
            break;

        case 'closeConnection':
             console.log("Popup requested connection close.");
             closeWebSocket(); // true = manual disconnect
             sendResponse({ success: true });
            break;

        case 'getBackgroundState':
            console.log("Popup requested background state.");
             isAsync = true; 
             getCurrentFitboxTab().then(tab => {
                 let context = 'Unknown'; // Default context
                 if (tab && tab.url) {
                     try {
                         const url = new URL(tab.url);
                         context = url.pathname.substring(1).replace(/[^a-zA-Z0-9_-]/g, '_') || 'Dashboard';
                     } catch { context = 'Fitbox_Tab'; }
                     currentScreenContext = context;
                     console.log("Sending state to popup:", { connectionState, currentScreenContext, currentMicrophoneLabel });
                     sendResponse({ 
                         success: true, 
                         connectionState: connectionState, 
                         screenContext: currentScreenContext,
                         microphoneLabel: currentMicrophoneLabel
                     });
                 } else {
                     currentScreenContext = 'Non-Fitbox_Tab'; 
                     console.log("Sending state to popup:", { connectionState, currentScreenContext, currentMicrophoneLabel });
                     sendResponse({ 
                         success: true, 
                         connectionState: connectionState, 
                         screenContext: currentScreenContext,
                         microphoneLabel: currentMicrophoneLabel
                     });
                 }
             }).catch(error => {
                 console.error("Error getting current tab for state request:", error);
                 // Send current state even on error, but indicate context issue
                 sendResponse({ success: false, error: "Failed to get tab context", connectionState: connectionState, screenContext: 'Error', microphoneLabel: currentMicrophoneLabel });
             });
            break;

        default:
            console.warn(`Background received unknown action: ${message.action}`);
            sendResponse({ success: false, error: 'Unknown action' });
    }

    return isAsync; // Return true if sendResponse will be called asynchronously
});

// Function to update the connection state and notify popup
function setConnectionState(newState, statusMessage = null) {
    const oldState = connectionState;
    connectionState = newState;
    // Default status message if null based on state
    let displayStatus = statusMessage;
    if (!displayStatus) {
        switch (newState) {
            case 'disconnected': displayStatus = 'Helper disconnected'; break;
            case 'connecting': displayStatus = 'Connecting...'; break;
            case 'connected': displayStatus = 'Helper connected'; break;
            case 'error': displayStatus = 'Connection error'; break;
            default: displayStatus = 'Unknown state';
        }
    }

    console.log(`Connection state changed: ${oldState} -> ${newState}${statusMessage ? ` (${statusMessage})` : ''}`);

    // Update popup UI if open
    chrome.runtime.sendMessage({ 
        action: 'updatePopupState',
        connectionState: newState, 
        statusMessage: displayStatus, // Send the resolved status message
        microphoneLabel: currentMicrophoneLabel
    }).catch(err => {
        // Ignore error if popup is not open
        if (!err.message.includes("Receiving end does not exist")) {
            console.warn("Could not send state update to popup:", err.message);
        }
    });

    // Handle side effects of state change
    if (newState === 'connected') {
        // Reset retry delay on successful connection
        currentRetryDelay = INITIAL_RETRY_DELAY;
        clearTimeout(retryTimeout);
        retryTimeout = null;
        // Attempt to start audio capture when connected and offscreen is ready
        if (offscreenReady) {
            console.log("[Background] Offscreen is ready and connected, capture should start automatically."); 
        } else {
            console.log("Connected, but waiting for offscreen document to be ready before starting audio capture.");
            // Ensure offscreen setup is initiated if not already
            // setupOffscreenDocument(); // Will be implemented later
        }
    } else if (newState === 'disconnected' || newState === 'error') {
        // Ensure offscreen document and audio capture are stopped
        // Stop audio capture (send message via port if connected)
        if (backgroundToOffscreenPort) {
            console.log("Sending stopAudioCapture message via port due to disconnect/error.");
            backgroundToOffscreenPort.postMessage({ action: 'stopAudioCapture' });
        } // If port isn't connected, offscreen should stop on its own or be closed.
        
        // Stop retrying if manually disconnected or fatal error
        if (connectionInitiatedByUser || newState === 'error') { 
            if (retryTimeout) {
                clearTimeout(retryTimeout);
                retryTimeout = null;
                console.log("Connection closed/error. Retry cancelled.");
            }
        }
        closeOffscreenDocument(); // Close offscreen doc on disconnect/error
    }
}

// Function to send specific errors to the popup
function sendErrorToPopup(errorMessage, isCritical = true) {
    console.error("Background sending error to popup:", errorMessage);
    setConnectionState('error', errorMessage); // Ensure state reflects error
    chrome.runtime.sendMessage({ 
        action: 'showPopupError', 
        error: errorMessage, 
        isCritical: isCritical 
    }).catch(err => {
        // Ignore error if popup is not open
        if (!err.message.includes("Receiving end does not exist")) {
            console.warn("Could not send error to popup:", err.message);
        }
    });
}

// --- Helper Functions ---
function reportErrorToPopup(errorMessage, isCritical = false) {
    console.error("Reporting error to popup:", errorMessage);
    chrome.runtime.sendMessage({ 
        action: 'showPopupError', 
        error: errorMessage, 
        isCritical: isCritical 
    }).catch(err => console.log("Popup not open or receiver error for showPopupError.", err.message)); // Ignore error if popup isn't open
}

function updatePopupState(statusMessage = null) {
     chrome.runtime.sendMessage({ 
        action: 'updatePopupState', 
        connectionState: connectionState, 
        statusMessage: statusMessage,
        microphoneLabel: currentMicrophoneLabel
    }).catch(err => console.log("Popup not open or receiver error for updatePopupState.", err.message)); // Ignore error if popup isn't open
}

// Function to schedule reconnection attempts with exponential backoff
function scheduleReconnect() {
    if (retryTimeout) {
        console.log("Reconnect already scheduled.");
        return;
    }
    if (connectionState === 'disconnected') { // Check if manual disconnect happened
        console.log("Reconnect cancelled due to manual disconnect.");
        connectionInitiatedByUser = false; // Ensure flag is reset
        return;
    }

    if (currentRetryDelay <= MAX_RETRY_DELAY) {
        console.log(`Scheduling reconnect attempt in ${currentRetryDelay / 1000} seconds...`);
        retryTimeout = setTimeout(() => {
            retryTimeout = null; // Clear the timeout ID before attempting to connect
            if (connectionState !== 'connected' && connectionState !== 'connecting') {
                 // Only attempt if not already connected or connecting
                 console.log("Retrying connection...");
                 connectWebSocket();
            } else {
                 console.log("Skipping scheduled reconnect as connection is already established or in progress.");
             }
        }, currentRetryDelay);
        // Increase delay for the next potential retry
        currentRetryDelay = Math.min(currentRetryDelay * 2, MAX_RETRY_DELAY);
    } else {
        console.error("Max WebSocket reconnect attempts reached. Stopping retries.");
        sendErrorToPopup("Connection failed after multiple retries. Please check the helper service.", true);
        connectionInitiatedByUser = false; // Stop trying after max retries
    }
}

// --- Extension Lifecycle ---
chrome.runtime.onStartup.addListener(() => {
    console.log("Extension startup.");
    // Clean up any potentially lingering offscreen documents from previous sessions
    closeOffscreenDocument(); 
});

chrome.runtime.onInstalled.addListener((details) => {
    console.log("Extension installed or updated:", details.reason);
     if (details.reason === 'install' || details.reason === 'update') {
         closeOffscreenDocument(); // Ensure clean state on install/update
     }
});

console.log("Background service worker started.");
// Initial state update for any already open popups?
// updatePopupState(); // Might cause errors if popup isn't ready

// --- Helper: Base64 to ArrayBuffer ---
function base64ToArrayBuffer(base64) {
    console.log("[base64ToArrayBuffer] Decoding Base64 string of length:", base64.length);
    try {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        console.log("[base64ToArrayBuffer] Decode successful, returning ArrayBuffer.");
        return bytes.buffer;
    } catch (error) {
        console.error("[base64ToArrayBuffer] Error decoding Base64:", error);
        console.error("[base64ToArrayBuffer] Input Base64 string (first 100 chars):", base64.substring(0, 100));
        return null; // Return null or handle error appropriately
    }
}

/**
 * Converts WebSocket readyState numeric value to a string representation.
 * @param {number} readyState The numeric readyState.
 * @returns {string} The string representation (CONNECTING, OPEN, CLOSING, CLOSED).
 */
function readyStateToString(readyState) {
    switch (readyState) {
        case WebSocket.CONNECTING: return 'CONNECTING (0)';
        case WebSocket.OPEN: return 'OPEN (1)';
        case WebSocket.CLOSING: return 'CLOSING (2)';
        case WebSocket.CLOSED: return 'CLOSED (3)';
        default: return `UNKNOWN (${readyState})`;
    }
}

// Helper function to send the start_ai_session message
function sendStartAISession() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[Background] (sendStartAISession) Preparing to send...');
        ws.send(JSON.stringify({ type: 'start_ai_session' }));
        console.log('[Background] (sendStartAISession) ...message sent.');
    } else {
        console.error('[Background] Cannot send start_ai_session: WebSocket not open or ready.');
    }
}
