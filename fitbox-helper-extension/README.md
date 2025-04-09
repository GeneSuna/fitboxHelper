# Fitbox Helper (Cloud AI) Chrome Extension

This Chrome extension provides AI-powered assistance for the Fitbox web application using Google Cloud APIs (Speech-to-Text, Gemini Vision).

## Features

*   **Multimodal AI Assistant:** Interact with Google Gemini using both voice input and screen context.
*   **Real-time Voice Input:** Speak your requests, which are transcribed using Google Cloud Speech-to-Text.
*   **Screen Context Awareness:** Share your screen (or a specific Fitbox tab/window) with the extension. It captures frames and sends them to Gemini Vision along with your voice command for highly relevant assistance.
*   **Secure Authentication:** Uses OAuth 2.0 via `chrome.identity` to securely access Google Cloud APIs on your behalf.

**Note:** This version requires a Google Cloud project, enabling specific APIs, and setting up OAuth 2.0 credentials. Using Google Cloud APIs may incur costs.

## Folder Structure

```
/fitbox-helper-extension
├── manifest.json         # Extension configuration (permissions, OAuth)
├── popup.html            # Popup UI structure (controls, chat display)
├── popup.js              # Popup logic (UI interaction, communication with background)
├── popup.css             # Popup styling
├── background.js         # Service worker (core logic: OAuth, API calls, stream handling)
├── icons/
│   └── icon128.png       # (Needs to be added) Extension icon
└── content-script.js     # (Currently basic, role may change/be removed)
```

## Setup (IMPORTANT)

1.  **Clone or Download:** Get the extension code onto your local machine.
2.  **Add Icon:**
    *   Create or find a 128x128 pixel PNG icon for the extension.
    *   Name it `icon128.png` and place it inside the `icons/` folder.
3.  **Google Cloud Project Setup:**
    *   You need an active Google Cloud Platform (GCP) project.
    *   **Enable APIs:** In your GCP project, enable the following APIs:
        *   Google Cloud Speech-to-Text API
        *   Vertex AI API (which provides access to Gemini models)
        *   (Optional: Google Cloud Text-to-Speech API if adding voice output later)
    *   **Billing:** Ensure billing is enabled for your GCP project, as these APIs are not entirely free.
4.  **OAuth 2.0 Setup:**
    *   Go to "APIs & Services" -> "Credentials" in your GCP project.
    *   Click "+ CREATE CREDENTIALS" -> "OAuth client ID".
    *   If prompted, configure the "OAuth consent screen" first. Choose "User Type" (likely "External" unless you are a Workspace user). Fill in the required app name, user support email, and developer contact information.
    *   For the OAuth client ID itself:
        *   Select "Application type" -> **"Chrome App"**. 
        *   Enter a name (e.g., "Fitbox Helper Extension Client").
        *   Enter your **Extension ID** in the "Application ID" field. You can find this ID after loading the unpacked extension into Chrome (see step 5). It's a long string of letters.
        *   Click "Create".
    *   **Copy the generated "Client ID"**. It will look something like `xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com`.
5.  **Update Manifest:**
    *   Open `manifest.json`.
    *   Find the `oauth2` section.
    *   **Replace** the placeholder value `"YOUR_GOOGLE_CLOUD_OAUTH_CLIENT_ID.apps.googleusercontent.com"` with the **actual Client ID** you just copied.
    *   Save the `manifest.json` file.
6.  **Load the Extension in Chrome:**
    *   Open Chrome and navigate to `chrome://extensions/`.
    *   Enable "Developer mode" using the toggle switch in the top-right corner.
    *   Click the "Load unpacked" button.
    *   Select the `fitbox-helper-extension` folder on your computer.
    *   The Fitbox Helper icon should appear in your Chrome toolbar. **Note down the Extension ID shown on the extension card - you need this for the OAuth setup in step 4 if you haven't done it already.**
    *   If you had to update the Application ID in GCP after loading, you might need to reload the extension in Chrome (using the refresh icon on the extension card).

## Testing (Conceptual - Code needs implementation)

*Once the core logic in `background.js` and `popup.js` is implemented:* 

1.  **Open the Popup:** Click the Fitbox Helper icon.
2.  **Authenticate:** The first time (or after token expiry), you should be prompted via a Google login screen to authorize the extension to access the scopes defined in the manifest.
3.  **Start Interaction:** Click a button (e.g., "Start Listening & Watching") in the popup.
4.  **Grant Permissions:** Chrome will likely prompt you for:
    *   Microphone access.
    *   Screen sharing permission (choose the Fitbox window/tab or entire screen).
5.  **Speak:** Talk normally. Your speech should be transcribed (potentially shown in the popup).
6.  **AI Response:** The extension will capture a screen frame, send it along with your transcription to Gemini, and display the AI's response in the chat area.
7.  **Stop Interaction:** Click a "Stop" button.

## Development Notes

*   **OAuth Flow:** The `chrome.identity.getAuthToken` function handles the OAuth flow.
*   **API Calls:** All calls to Google Cloud APIs MUST include the obtained OAuth token in the `Authorization: Bearer <token>` header.
*   **Screen Capture:** `chrome.desktopCapture` initiates the screen selection. `navigator.mediaDevices.getUserMedia` gets the video stream. Frames need to be extracted (e.g., using a canvas) and likely base64 encoded for the Gemini Vision API.
*   **Streaming STT:** Requires setting up a WebSocket or HTTP/2 connection to the Speech-to-Text streaming endpoint.
*   **Gemini API:** Use the Vertex AI SDK or direct REST calls to the Gemini endpoint, sending both text and image data.
*   **Error Handling:** Robust handling for permission denials, API errors, network issues, and authentication failures is critical.
*   **Performance & Costs:** Be mindful of the frequency of screen captures and API calls to manage performance and GCP costs.
