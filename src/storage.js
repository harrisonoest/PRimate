import fs from "fs";
import path from "path";
import log from "./logger.js";

const STORAGE_FILE = path.join(process.cwd(), "data", "pr_data.json");
const USER_STATS_FILE = path.join(process.cwd(), "data", "user_stats.json");

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
      const data = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf8"));
      return new Map(Object.entries(data));
    }
  } catch (error) {
    log("Error loading PR data:", error);
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
    log("Error saving PR data:", error);
  }
}

/**
 * Load user statistics from storage
 * @returns {Map} Map of userId to UserStats
 */
export function loadUserStats() {
  try {
    if (fs.existsSync(USER_STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(USER_STATS_FILE, "utf8"));
      return new Map(Object.entries(data));
    }
  } catch (error) {
    log("Error loading user stats:", error);
  }
  return new Map();
}

/**
 * Save user statistics to storage
 * @param {Map} userStats Map of userId to UserStats
 */
export function saveUserStats(userStats) {
  try {
    const data = Object.fromEntries(userStats);
    fs.writeFileSync(USER_STATS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    log("Error saving user stats:", error);
  }
}

/**
 * Initialize user stats if they don't exist
 * @returns {Object} New user stats object
 */
export function initializeUserStats() {
  const now = new Date().toISOString();
  return {
    prsAuthored: 0,
    prsApproved: 0,
    commentsLeft: 0,
    prsMerged: 0,
    fastestApproval: null,
    longestPRDuration: null,
    approvalTimes: [],
    prDurations: [],
    lastUpdated: now,
    firstActivity: now,
  };
}
