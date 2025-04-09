// knowledge.js

// In-memory knowledge base for fitbox context (can be expanded or loaded from files/DB)
const fitboxKnowledge = {
    'add_member': "To add a new member in fitbox, navigate to the Members section and click the 'Add New Member' button. Fill in their details and save.",
    'edit_member': "To edit a member, find them in the Members list, click the edit icon, make your changes, and save.",
    'view_schedule': "Access the Schedule tab to see upcoming classes and appointments.",
    'book_class': "To book a class, go to the Schedule, find the class you want, and click the 'Book Now' button.",
    'default': "I have general knowledge about the fitbox application. You can ask about managing members, schedules, classes, or settings.",
    'initial': "Welcome to the fitbox AI helper. How can I assist you with fitbox today?"
};

/**
 * Retrieves fitbox-specific knowledge context based on a screen identifier.
 * @param {string} screen - The screen identifier (e.g., 'add_member').
 * @returns {string} The relevant knowledge context or default context.
 */
export function getKnowledgeForScreen(screen) {
    const screenKey = screen ? screen.toLowerCase().trim() : 'default';
    console.log(`[Knowledge] Requested context for screen: '${screenKey}'`);
    const context = fitboxKnowledge[screenKey] || fitboxKnowledge['default'];
    console.log(`[Knowledge] Providing context: "${context.substring(0, 50)}..."`);
    return context;
}

// Example: Load from external source (Placeholder)
// async function loadExternalKnowledge() {
//     const url = process.env.KNOWLEDGE_BASE_URL;
//     if (!url) return;
//     try {
//         const response = await fetch(url);
//         if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
//         const externalData = await response.json(); // Assuming JSON format
//         // Merge or replace fitboxKnowledge with externalData
//         console.log("[Knowledge] Successfully loaded external knowledge.");
//     } catch (error) {
//         console.error("[Knowledge] Failed to load external knowledge:", error);
//     }
// }

// Load external knowledge on startup if needed
// if (process.env.KNOWLEDGE_BASE_URL) {
//     loadExternalKnowledge();
// }
