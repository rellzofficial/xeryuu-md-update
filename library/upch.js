// upch.js
const fs = require('fs');
const path = require('path');
const TARGET_CHANNEL_FILE = path.join(__dirname, '..', 'targetChannel.json');

let targetChannelData = { id: '120363420029967952@newsletter' };

const loadTargetChannel = () => {
    try {
        if (fs.existsSync(TARGET_CHANNEL_FILE)) {
            const file = fs.readFileSync(TARGET_CHANNEL_FILE, 'utf-8');
            targetChannelData = JSON.parse(file);
        } else {
            saveTargetChannel();
        }
    } catch (err) {
        console.error('Gagal load target channel:', err);
    }
};

const saveTargetChannel = () => {
    try {
        fs.writeFileSync(TARGET_CHANNEL_FILE, JSON.stringify(targetChannelData, null, 2));
    } catch (err) {
        console.error('Gagal save target channel:', err);
    }
};

// Load otomatis saat file di require
loadTargetChannel();

// Export supaya bisa dipakai di case.js
module.exports = { targetChannelData, loadTargetChannel, saveTargetChannel };