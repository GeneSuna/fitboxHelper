
# Fitbox Helper – Full Project Plan

You are building a real-time, voice-only AI assistant Chrome Extension called **Fitbox Helper**, which integrates with the **Google Gemini Live API** to provide contextual guidance inside the **Fitbox IQ web app** (`https://www.fitbox.iq`).  
This app replicates the experience of **Google AI Studio’s Stream Realtime**, enabling hands-free voice interaction, screen awareness, and admin-managed knowledge integration.

---

## 📁 Project Structure

```
/fitbox-helper
├── /extension             ← Chrome Extension (frontend)
│   ├── manifest.json
│   ├── popup.html / popup.js / popup.css
│   ├── background.js
│   ├── offscreen.html / offscreen.js
│   └── icons/
│
└── /fitbox-helper-server  ← Node.js Backend (Gemini Live Relay)
    ├── index.js
    ├── gemini-session.js
    ├── knowledge.js
    ├── .env
    └── package.json
```

---

## ✅ Phase 1: Extension Setup

### Goal:
Allow the user to click a Chrome Extension, share their tab and mic, and begin talking to the Fitbox Helper AI.

### Components:
- `manifest.json`: Uses Manifest V3, permissions for `offscreen`, `desktopCapture`, `tts`, `scripting`, `storage`, `activeTab`, and `tabs`
- `popup.html`: Minimal UI with one button: **“Get Help”**
- `popup.js`: Starts capture flow → launches offscreen document
- `offscreen.js`: Captures mic audio, streams to backend
- `background.js`: Orchestrates WebSocket connection and handles AI responses via `chrome.tts.speak`

### Tasks:
1. [ ] Configure extension permissions
2. [ ] Add Get Help button UI
3. [ ] Prompt for screen and mic access
4. [ ] Launch offscreen capture
5. [ ] Stream mic input to backend
6. [ ] Read AI response via TTS

---

## ✅ Phase 2: Backend Setup

### Goal:
Proxy WebSocket streams from extension to Gemini Live API securely, and stream replies back.

### Components:
- `index.js`: WebSocket server for extension connections
- `gemini-session.js`: Handles connection to Gemini Live API
- `knowledge.js`: Provides Fitbox-specific context
- `.env`: Stores sensitive data
- `package.json`: Uses `ws`, `dotenv`, `uuid`

### Tasks:
1. [ ] Set up .env with credentials
2. [ ] Build Gemini session connector
3. [ ] Accept WebSocket clients in index.js
4. [ ] Load screen context
5. [ ] Route input/output between client and Gemini

---

## ✅ Phase 3: Streaming Audio & AI Interaction

### Goal:
Enable full voice-only interaction loop:
1. Capture mic audio
2. Stream to backend
3. Relay to Gemini
4. Respond with TTS

### Tasks:
1. [ ] Capture mic in offscreen.js
2. [ ] Send to backend
3. [ ] Forward to Gemini
4. [ ] Speak reply using chrome.tts

---

## ✅ Phase 4: Knowledge Base & Context Awareness

### Goal:
Let AI know what screen the user is on and tailor responses.

### Tasks:
1. [ ] Determine current Fitbox screen
2. [ ] Send screen name to backend
3. [ ] Inject relevant help context into Gemini session

---

## ✅ Phase 5: UX Polish

### Final Flow:
1. User clicks Fitbox Helper
2. Sees popup with “Get Help”
3. Clicks → shares tab + mic
4. Fitbox Helper introduces itself by voice
5. User speaks a question
6. AI responds via voice using Gemini Live API
7. Interaction is 100% voice-only

---

## ✅ Extras & Stretch Goals

| Feature | Description |
|--------|-------------|
| Remote knowledge fetch | Replace hardcoded `knowledge.js` with API |
| Session memory | Retain Q&A context |
| Audio streaming | Use binary streaming |
| Activity logs | Optional transcripts |

