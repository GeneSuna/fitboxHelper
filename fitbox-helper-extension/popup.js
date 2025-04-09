document.addEventListener('DOMContentLoaded', () => {
    // --- Get DOM Elements ---
    const initialView = document.getElementById('initialView');
    const connectingView = document.getElementById('connectingView');
    const connectedView = document.getElementById('connectedView');
    const errorView = document.getElementById('errorView');

    const connectBtn = document.getElementById('connectBtn');
    const cancelConnectBtn = document.getElementById('cancelConnectBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const tryAgainBtn = document.getElementById('tryAgainBtn');
    const closePopupBtn = document.getElementById('closePopupBtn'); // Added

    const initialErrorText = document.getElementById('initialErrorText');
    const connectingStatus = document.getElementById('connectingStatus');
    const connectedStatus = document.getElementById('connectedStatus');
    const connectionContext = document.getElementById('connectionContext'); // Added
    const errorText = document.getElementById('errorText');
    const micLabelSpan = document.getElementById('mic-label'); // Get the new element

    // --- Helper Functions ---
    function showView(viewToShow) {
        [initialView, connectingView, connectedView, errorView].forEach(view => {
            if (view.id === viewToShow) {
                view.classList.remove('hidden');
            } else {
                view.classList.add('hidden');
            }
        });
        // Clear errors when switching views (except when showing the error view itself)
        if (viewToShow !== 'errorView') {
            errorText.textContent = '';
            initialErrorText.textContent = ''; 
        }
         if (viewToShow !== 'connectingView') {
            connectingStatus.textContent = 'Connecting to helper service...'; // Reset text
        }
    }

    function showError(message, isInitialError = false) {
        console.error("Popup Error:", message);
        if (isInitialError) {
            initialErrorText.textContent = message;
            showView('initialView');
        } else {
            errorText.textContent = message;
            showView('errorView');
        }
    }

    // --- Event Listeners for Buttons ---
    connectBtn.addEventListener('click', () => {
        console.log("Connect button clicked.");
        initialErrorText.textContent = ''; // Clear previous initial errors
        showView('connectingView');
        // Send message to background to initiate connection
        chrome.runtime.sendMessage({ action: 'initiateConnection' }, (response) => {
            if (chrome.runtime.lastError) {
                showError(`Error initiating connection: ${chrome.runtime.lastError.message}`);
            } else if (!response || !response.success) {
                showError(`Failed to initiate connection: ${response?.error || 'Unknown reason'}`);
            } else {
                console.log("Connection initiation acknowledged by background.");
                 // Background will send state updates
            }
        });
    });

    cancelConnectBtn.addEventListener('click', () => {
        console.log("Cancel Connect button clicked.");
        chrome.runtime.sendMessage({ action: 'closeConnection' }, (response) => {
            // Don't necessarily show error if background confirms
            console.log("Disconnect message sent (from cancel button).");
            showView('initialView'); // Go back to initial view
        });
    });

    disconnectBtn.addEventListener('click', () => {
        console.log("Disconnect button clicked.");
        chrome.runtime.sendMessage({ action: 'closeConnection' }, (response) => {
            console.log("Disconnect message sent.");
            showView('initialView'); // Go back to initial view
        });
    });

    tryAgainBtn.addEventListener('click', () => {
        console.log("Try Again button clicked.");
        showView('initialView'); // Go back to initial view, user can click connect again
        // Optionally, could directly trigger connectBtn.click() here
    });

     closePopupBtn.addEventListener('click', () => {
        window.close(); // Close the popup window
    });

    // --- Listen for Messages from Background Script ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log("Popup received message:", message);

        switch (message.action) {
            case 'updatePopupState':
                // Update UI based on connection state from background
                switch (message.connectionState) {
                    case 'connecting':
                        showView('connectingView');
                        if (message.statusMessage) connectingStatus.textContent = message.statusMessage;
                        break;
                    case 'connected':
                        showView('connectedView');
                        if (message.statusMessage) connectedStatus.textContent = message.statusMessage;
                         // Request context info when connected
                         chrome.runtime.sendMessage({ action: 'getBackgroundState' }, (stateResponse) => {
                            if (stateResponse && stateResponse.success) {
                                connectionContext.textContent = stateResponse.screenContext || 'Unknown';
                            } else {
                                connectionContext.textContent = 'Error getting context';
                            }
                         });
                        break;
                    case 'disconnected':
                        showView('initialView');
                        // Optionally show a message if disconnect was unexpected?
                        if (message.statusMessage) initialErrorText.textContent = message.statusMessage;
                        break;
                    case 'error':
                         // Background should send 'showPopupError' for specific errors
                         // This is a fallback if only the state is 'error'
                         showError(message.statusMessage || "Connection error occurred.");
                        break;
                }
                break;

            case 'showPopupError':
                // Display error message sent from background
                showError(message.error, message.isCritical); // isCritical might control if we show initial error or error view
                break;

            case 'updateState':
                console.log("[Popup] Received state update:", message.state);
                updateUI(message.state);
                break;

            case 'updatePopupState':
                console.log("[Popup] Received updatePopupState:", message); // Log the entire request
                // Extract the relevant state parts
                const newState = {
                    connectionState: message.connectionState,
                    connectionError: message.statusMessage || '', // Use statusMessage if provided
                    lastContext: message.screenContext || document.getElementById('context-value').textContent, // Keep context if not provided
                    microphoneLabel: message.microphoneLabel || '-' // Get microphone label
                };
                updateUI(newState);
                break;

            // Handle other potential messages if needed

            default:
                console.warn("Popup received unknown action:", message.action);
                break;
        }

        // Indicate that the listener doesn't send a response itself
        return false;
    });

    function updateUI(state) {
        console.log("[Popup] Updating UI with state:", state);
        const connectButton = document.getElementById('connect-button');
        const disconnectButton = document.getElementById('disconnect-button');
        const statusDiv = document.getElementById('status');
        const contextSpan = document.getElementById('context-value');
        const errorDiv = document.getElementById('error-message');

        // Update Context
        contextSpan.textContent = state.lastContext || 'N/A';

        // Update Microphone Label
        micLabelSpan.textContent = state.microphoneLabel || '-'; // Use microphoneLabel here

        // Update Connection Status and Buttons
        switch (state.connectionState) {
            case 'disconnected':
                // ...
                break;
        }

        // Handle errors
        if (state.connectionError) {
             console.log("[Popup] Displaying error:", state.connectionError);
             errorDiv.textContent = `Error: ${state.connectionError}`;
             errorDiv.style.display = 'block';
        } else if (state.connectionState !== 'error') { // Keep error shown if state IS error
             errorDiv.style.display = 'none';
             errorDiv.textContent = '';
        }
    }

    // --- Initial State Check ---
    // Ask the background script for the current state when the popup opens
    console.log("Popup opened. Requesting initial state from background...");
    chrome.runtime.sendMessage({ action: 'getBackgroundState' }, (response) => {
        if (chrome.runtime.lastError) {
            // This often happens if the background script hasn't loaded yet
            console.warn(`Could not get initial state: ${chrome.runtime.lastError.message}. Assuming disconnected.`);
            showView('initialView');
            // Optionally display a less alarming message here
            // initialErrorText.textContent = "Helper initializing...";
        } else if (response && response.success) {
            console.log("Received initial state:", response);
             // Trigger UI update based on the received state
             const state = response.connectionState;
             const context = response.context; // Use 'context' from background

             switch (state) {
                 case 'connecting':
                     showView('connectingView');
                     // Use a generic message or potentially get one from background if needed
                     connectingStatus.textContent = 'Connecting...'; 
                     break;
                 case 'connected':
                     showView('connectedView');
                     connectedStatus.textContent = 'Connected'; // Default message
                     connectionContext.textContent = context || 'Unknown';
                     break;
                 case 'disconnected':
                     showView('initialView');
                     // No error message needed unless disconnect was unexpected (can't tell here)
                     initialErrorText.textContent = ''; 
                     break;
                 case 'error':
                     // Use the showError function defined above
                     showError(response.errorMessage || "Connection error occurred."); 
                     break;
                 default:
                     showView('initialView'); // Fallback
             }

        } else {
            console.error("Failed to get initial state from background:", response?.error);
            showError("Could not determine helper status.", true);
        }
    });
});
