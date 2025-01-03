import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name from import.meta.url
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define the log file path
const logFilePath = path.join(__dirname, '../logs', 'primate.log');

// Ensure the logs directory exists
fs.mkdirSync(path.dirname(logFilePath), { recursive: true });

// Create a write stream for the log file
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

// Custom logger function
function log(...messages) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${messages.join(' ')}`;
  logStream.write(`${logMessage}\n`);
}

export default log;
