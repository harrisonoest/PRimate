import {
  loadUserStats,
  saveUserStats,
  initializeUserStats,
} from "./storage.js";
import { checkLastUpdate } from "./bot.js";
import log from "./logger.js";

// Load user statistics with auto-persistence
export const userStatsTracker = loadUserStats();

// Wrap Map methods to persist changes automatically
const originalSet = userStatsTracker.set.bind(userStatsTracker);
userStatsTracker.set = function (key, value) {
  const result = originalSet(key, value);
  saveUserStats(userStatsTracker);
  return result;
};

const originalDelete = userStatsTracker.delete.bind(userStatsTracker);
userStatsTracker.delete = function (key) {
  const result = originalDelete(key);
  saveUserStats(userStatsTracker);
  return result;
};

/**
 * Calculate time difference in minutes
 * @param {string} startTime ISO timestamp
 * @param {string} endTime ISO timestamp
 * @returns {number} Difference in minutes
 */
function calculateTimeDifferenceMinutes(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  return Math.round((end - start) / (1000 * 60));
}

/**
 * Ensure user stats exist, create if needed
 * @param {string} userId Slack user ID
 * @returns {Object} User statistics object
 */
function ensureUserStats(userId) {
  if (!userStatsTracker.has(userId)) {
    userStatsTracker.set(userId, initializeUserStats());
  }
  return userStatsTracker.get(userId);
}

/**
 * Update user stats after modification
 * @param {string} userId Slack user ID
 * @param {Object} stats Updated stats object
 */
function updateUserStats(userId, stats) {
  stats.lastUpdated = new Date().toISOString();
  userStatsTracker.set(userId, stats);
}

/**
 * Safe statistics update with error handling
 * @param {Function} updateFn Function to execute
 * @param {string} operation Description of operation
 */
function safeStatsUpdate(updateFn, operation) {
  try {
    updateFn();
  } catch (error) {
    log(`Error during statistics update (${operation}):`, error);
    // Continue execution - don't let statistics errors break core functionality
  }
}

/**
 * Track PR creation
 * @param {string} authorId Slack user ID of PR author
 * @param {string} prUrl GitLab PR URL
 * @param {string} createdAt ISO timestamp of PR creation
 */
export function trackPRCreation(authorId, prUrl, createdAt) {
  safeStatsUpdate(() => {
    const stats = ensureUserStats(authorId);
    stats.prsAuthored++;
    updateUserStats(authorId, stats);
    log(`Tracked PR creation for user ${authorId}: ${prUrl}`);
  }, "trackPRCreation");
}

/**
 * Track PR approval
 * @param {string} reviewerId Slack user ID of reviewer
 * @param {string} authorId Slack user ID of PR author
 * @param {string} prCreatedAt ISO timestamp of PR creation
 * @param {string} approvedAt ISO timestamp of approval
 */
export function trackPRApproval(reviewerId, authorId, prCreatedAt, approvedAt) {
  safeStatsUpdate(() => {
    const reviewerStats = ensureUserStats(reviewerId);
    reviewerStats.prsApproved++;

    // Calculate approval time
    const approvalTimeMinutes = calculateTimeDifferenceMinutes(
      prCreatedAt,
      approvedAt
    );
    reviewerStats.approvalTimes.push(approvalTimeMinutes);

    // Update fastest approval if this is faster
    if (
      reviewerStats.fastestApproval === null ||
      approvalTimeMinutes < reviewerStats.fastestApproval
    ) {
      reviewerStats.fastestApproval = approvalTimeMinutes;
    }

    updateUserStats(reviewerId, reviewerStats);

    log(
      `Tracked PR approval for reviewer ${reviewerId}: ${approvalTimeMinutes} minutes`
    );
  }, "trackPRApproval");
}

/**
 * Track comment left on PR
 * @param {string} commenterId Slack user ID of commenter
 * @param {string} prUrl GitLab PR URL
 */
export function trackComment(commenterId, prUrl) {
  safeStatsUpdate(() => {
    const stats = ensureUserStats(commenterId);
    stats.commentsLeft++;
    updateUserStats(commenterId, stats);

    log(`Tracked comment for user ${commenterId}: ${prUrl}`);
  }, "trackComment");
}

/**
 * Track PR merge
 * @param {string} authorId Slack user ID of PR author
 * @param {string} prCreatedAt ISO timestamp of PR creation
 * @param {string} mergedAt ISO timestamp of merge
 */
export function trackPRMerge(authorId, prCreatedAt, mergedAt) {
  safeStatsUpdate(() => {
    const stats = ensureUserStats(authorId);
    stats.prsMerged++;

    // Calculate PR duration
    const durationMinutes = calculateTimeDifferenceMinutes(
      prCreatedAt,
      mergedAt
    );
    stats.prDurations.push(durationMinutes);

    // Update longest PR duration if this is longer
    if (
      stats.longestPRDuration === null ||
      durationMinutes > stats.longestPRDuration
    ) {
      stats.longestPRDuration = durationMinutes;
    }

    updateUserStats(authorId, stats);

    log(
      `Tracked PR merge for author ${authorId}: ${durationMinutes} minutes duration`
    );
  }, "trackPRMerge");
}

/**
 * Get user statistics
 * @param {string} userId Slack user ID
 * @returns {Object|null} User statistics or null if not found
 */
export function getUserStats(userId) {
  return userStatsTracker.get(userId) || null;
}

/**
 * Get leaderboard data
 * @param {string} metric Metric to sort by
 * @param {number} limit Number of top users to return
 * @returns {Array} Array of {userId, value, stats} objects
 */
export function getLeaderboard(metric, limit = 10) {
  const validMetrics = [
    "prsAuthored",
    "prsApproved",
    "commentsLeft",
    "prsMerged",
    "fastestApproval",
    "longestPRDuration",
  ];

  if (!validMetrics.includes(metric)) {
    throw new Error(`Invalid metric: ${metric}`);
  }

  const entries = Array.from(userStatsTracker.entries())
    .map(([userId, stats]) => ({
      userId,
      value: stats[metric],
      stats,
    }))
    .filter(
      (entry) =>
        entry.value !== null && entry.value !== undefined && entry.value > 0
    )
    .sort((a, b) => {
      // For time-based metrics, lower is better
      if (metric === "fastestApproval") {
        return a.value - b.value;
      }
      // For other metrics, higher is better
      return b.value - a.value;
    })
    .slice(0, limit);

  return entries;
}

/**
 * Calculate average values for a user
 * @param {string} userId Slack user ID
 * @returns {Object|null} Average metrics or null if user not found
 */
export function getUserAverages(userId) {
  const stats = getUserStats(userId);
  if (!stats) return null;

  const avgApprovalTime =
    stats.approvalTimes.length > 0
      ? Math.round(
          stats.approvalTimes.reduce((a, b) => a + b, 0) /
            stats.approvalTimes.length
        )
      : null;

  const avgPRDuration =
    stats.prDurations.length > 0
      ? Math.round(
          stats.prDurations.reduce((a, b) => a + b, 0) /
            stats.prDurations.length
        )
      : null;

  return {
    avgApprovalTime,
    avgPRDuration,
    totalApprovals: stats.approvalTimes.length,
    totalMerges: stats.prDurations.length,
  };
}

/**
 * Migrate existing user_stats.json to new format
 */
export function migrateUserStats() {
  let migrated = 0;

  for (const [userId, stats] of userStatsTracker.entries()) {
    let needsMigration = false;

    // Add missing fields
    if (!stats.approvalTimes) {
      stats.approvalTimes = [];
      needsMigration = true;
    }
    if (!stats.prDurations) {
      stats.prDurations = [];
      needsMigration = true;
    }
    if (!stats.firstActivity) {
      stats.firstActivity = stats.lastUpdated || new Date().toISOString();
      needsMigration = true;
    }

    // Rename old fields for consistency
    if (stats.approvalsGiven !== undefined) {
      stats.prsApproved = stats.approvalsGiven;
      delete stats.approvalsGiven;
      needsMigration = true;
    }
    if (stats.mergesDone !== undefined) {
      stats.prsMerged = stats.mergesDone;
      delete stats.mergesDone;
      needsMigration = true;
    }
    if (stats.longestPR !== undefined) {
      stats.longestPRDuration = stats.longestPR;
      delete stats.longestPR;
      needsMigration = true;
    }

    if (needsMigration) {
      userStatsTracker.set(userId, stats);
      migrated++;
    }
  }

  if (migrated > 0) {
    log(`Migrated ${migrated} user statistics to new format`);
  }

  return migrated;
}

// Run migration on module load
migrateUserStats();
