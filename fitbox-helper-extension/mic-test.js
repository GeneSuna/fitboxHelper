document.addEventListener('DOMContentLoaded', () => {
    const testButton = document.getElementById('testMicButton');
    const statusDiv = document.getElementById('status');

    if (testButton) {
        testButton.addEventListener('click', async () => {
            statusDiv.textContent = 'Status: Requesting microphone access...';
            console.log('[MicTest] Attempting to call getUserMedia({ audio: true })...');
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                statusDiv.textContent = 'Status: SUCCESS! Microphone access granted.';
                console.log('[MicTest] getUserMedia successful!', stream);
                // Stop the tracks immediately to release the microphone indicator
                stream.getTracks().forEach(track => track.stop());
                console.log('[MicTest] Microphone stream tracks stopped.');
            } catch (error) {
                statusDiv.textContent = `Status: FAILED! ${error.name} - ${error.message}`;
                console.error('[MicTest] getUserMedia failed:', error);
                console.error('[MicTest] Error Name:', error.name);
                console.error('[MicTest] Error Message:', error.message);
            }
        });
    }
});
