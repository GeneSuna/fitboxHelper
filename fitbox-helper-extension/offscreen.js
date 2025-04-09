// offscreen.js - Handles audio capture in the offscreen document

console.log("Offscreen document script running.");

let mediaRecorder;
let audioStream;
let backgroundPort = null; // Port for communicating back to the background script
let isRecording = false;
const TIMESLICE_MS = 1000; // Send audio chunks every second

// --- Port Communication ---

// Listen for connection from the background script
chrome.runtime.onConnect.addListener((port) => {
    console.log("[Offscreen] Connected to background script port:", port.name);
    if (port.name === 'offscreen-audio-port') {
        backgroundPort = port;

        // Handle messages received FROM the background script via the port
        backgroundPort.onMessage.addListener(handleBackgroundMessage);

        // Handle disconnection
        backgroundPort.onDisconnect.addListener(() => {
            console.log("[Offscreen] Background port disconnected.");
            stopAudioCaptureInternal(); // Stop recording if background disconnects
            backgroundPort = null;
        });

        // Signal readiness TO the background script
        sendToBackground({ action: 'offscreenReady' });
        console.log("[Offscreen] Sent 'offscreenReady' to background.");

    } else {
        console.warn("[Offscreen] Ignoring connection from unknown port:", port.name);
    }
});

// Handles messages received via the Port connection
function handleBackgroundMessage(message) {
     console.log("[Offscreen Port Listener] Raw message received. Action:", message?.action);
    if (!message || typeof message !== 'object' || !message.action) {
        console.error("[Offscreen Port Listener] Invalid message received:", message);
        return;
    }
    console.log(`[Offscreen Port Listener] Starting to process action: ${message.action}`);

     if (typeof messageHandlers[message.action] === 'function') {
         console.log(`[Offscreen Port Listener] Message structure valid, entering switch for action: ${message.action}`);
        messageHandlers[message.action](message.payload); // Pass payload if needed
     } else {
         console.warn(`[Offscreen Port Listener] No handler for action: ${message.action}`);
     }
}

// --- Message Handlers (Called by Port Listener) ---

const messageHandlers = {
    startAudioCapture: startAudioCaptureInternal,
    stopAudioCapture: stopAudioCaptureInternal
};

// Helper to send messages TO the background script via the port
function sendToBackground(message) {
    if (backgroundPort) {
        try {
            backgroundPort.postMessage(message);
           // console.log(`[Offscreen] Sent message to background:`, message.action);
        } catch (error) {
            console.error("[Offscreen] Error sending message to background:", error);
            // Attempt to stop capture if port fails, might indicate background closure
             stopAudioCaptureInternal();
        }
    } else {
        console.warn("[Offscreen] Cannot send message, background port not connected.");
    }
}


// --- Audio Capture Logic ---

async function startAudioCaptureInternal() {
    console.log("[Offscreen] Received request to start audio capture.");
    if (isRecording) {
        console.warn("[Offscreen] Audio capture already in progress.");
        return;
    }

    try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("[Offscreen] Microphone access granted.");

        // --- Log and Send the microphone label ---
        const audioTracks = audioStream.getAudioTracks();
        if (audioTracks.length > 0) {
            const microphoneLabel = audioTracks[0].label || 'Default Microphone';
            console.log(`[Offscreen] Using microphone: ${microphoneLabel}`);
            // Send label back to background script
            sendToBackground({ action: 'microphoneLabel', label: microphoneLabel });
        } else {
            console.warn("[Offscreen] Could not get audio track label.");
             sendToBackground({ action: 'microphoneLabel', label: 'Unknown Microphone' }); // Send fallback
        }
        // --- End log/send microphone label ---

        // --- IMPORTANT: MediaRecorder Format ---
        // Browsers typically default to opus in webm or ogg.
        // Gemini *might* require raw PCM 16kHz 16-bit.
        // For now, let's use the default and send what we get.
        // We may need to add transcoding later if this fails.
        const options = { mimeType: 'audio/webm;codecs=opus' }; // Example, adjust if needed
        try {
             mediaRecorder = new MediaRecorder(audioStream, options);
        } catch (e) {
             console.warn(`[Offscreen] Failed to create MediaRecorder with options ${JSON.stringify(options)}, trying default:`, e);
             mediaRecorder = new MediaRecorder(audioStream); // Fallback to browser default
        }
       
        console.log("[Offscreen] MediaRecorder created. MimeType:", mediaRecorder.mimeType);


        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && backgroundPort) {
               // console.log("[Offscreen] ondataavailable event, data size:", event.data.size);
                // Convert Blob to Base64 and send to background
                blobToBase64(event.data)
                    .then(base64String => {
                        sendToBackground({ action: 'audioChunk', data: base64String });
                    })
                    .catch(error => {
                        console.error("[Offscreen] Error converting blob to Base64:", error);
                    });
            }
        };

        mediaRecorder.onstop = () => {
            console.log("[Offscreen] MediaRecorder stopped.");
            isRecording = false;
            // Ensure stream tracks are stopped *after* recorder is fully stopped
            if (audioStream) {
                 audioStream.getTracks().forEach(track => track.stop());
                 console.log("[Offscreen] Microphone stream tracks stopped.");
                 audioStream = null;
            }
        };

        mediaRecorder.onerror = (event) => {
            console.error("[Offscreen] MediaRecorder error:", event.error);
            stopAudioCaptureInternal(); // Stop on error
             sendToBackground({ action: 'audioError', message: event.error.message || 'Unknown MediaRecorder error' });
        };

        mediaRecorder.start(TIMESLICE_MS); // Record in chunks
        isRecording = true;
        console.log(`[Offscreen] MediaRecorder started, recording in ${TIMESLICE_MS}ms chunks.`);

    } catch (error) {
        console.error("[Offscreen] Error starting audio capture:", error);
        sendToBackground({ action: 'audioError', message: `Failed to get microphone: ${error.message}` });
        stopAudioCaptureInternal(); // Clean up if getUserMedia fails
    }
}

function stopAudioCaptureInternal() {
    console.log("[Offscreen] Received request to stop audio capture.");
    if (!isRecording && !mediaRecorder) {
        console.log("[Offscreen] Not recording, nothing to stop.");
         // Ensure stream tracks are stopped even if recorder wasn't fully started
        if (audioStream) {
             audioStream.getTracks().forEach(track => track.stop());
             console.log("[Offscreen] Cleaned up lingering microphone stream tracks.");
             audioStream = null;
        }
        return;
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
         console.log("[Offscreen] Stopping MediaRecorder...");
        mediaRecorder.stop(); // This will trigger onstop event for final cleanup
    } else {
         console.log("[Offscreen] MediaRecorder already inactive or null.");
         // Explicitly call cleanup if recorder is null but stream might exist
         if (audioStream) {
             audioStream.getTracks().forEach(track => track.stop());
             console.log("[Offscreen] Microphone stream tracks stopped manually.");
             audioStream = null;
         }
          isRecording = false; // Ensure state is correct
    }
    
    // Clear references
    mediaRecorder = null;
}


// --- Utility Functions ---

// Converts a Blob to a Base64 encoded string
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // Result includes the data URL prefix (e.g., "data:audio/webm;base64,"), remove it.
            const base64String = reader.result.split(',', 2)[1];
            resolve(base64String);
        };
        reader.onerror = (error) => {
            reject(error);
        };
        reader.readAsDataURL(blob);
    });
}

// Initial log to confirm script load
console.log("[Offscreen] Script loaded and listeners set up.");
