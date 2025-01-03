import fs from 'fs';
import path from 'path';
import log from './logger.js';

const STORAGE_FILE = path.join(process.cwd(), 'data', 'pr_data.json');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(STORAGE_FILE))) {
    fs.mkdirSync(path.dirname(STORAGE_FILE), { recursive: true });
}

/**
 * Load PR data from storage
 * @returns {Map} Map containing PR tracking data
 */
export function loadPRData() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
            return new Map(Object.entries(data));
        }
    } catch (error) {
        log('Error loading PR data:', error);
    }
    return new Map();
}

/**
 * Save PR data to storage
 * @param {Map} prData Map containing PR tracking data
 */
export function savePRData(prData) {
    try {
        const data = Object.fromEntries(prData);
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        log('Error saving PR data:', error);
    }
}
