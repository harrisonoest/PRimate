import fs from 'fs';
import path from 'path';
import log from './logger.js';

// Define storage file for user statistics
const STATS_FILE = path.join(process.cwd(), 'data', 'user_stats.json');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(STATS_FILE))) {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
}

/**
 * Class to manage user statistics for PR activities
 * This class tracks various metrics related to user interactions with PRs
 */
class UserStatsTracker {
    constructor() {
        this.stats = this.loadStats();
    }

    /**
     * Load user statistics from storage
     * @returns {Object} Object containing user statistics
     */
    loadStats() {
        try {
            if (fs.existsSync(STATS_FILE)) {
                return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            }
        } catch (error) {
            log('Error loading user stats:', error);
        }
        return {};
    }

    /**
     * Save user statistics to storage
     */
    saveStats() {
        try {
            fs.writeFileSync(STATS_FILE, JSON.stringify(this.stats, null, 2));
        } catch (error) {
            log('Error saving user stats:', error);
        }
    }

    /**
     * Initialize stats for a user if they don't exist
     * @param {string} userId - Slack user ID
     */
    initUserStats(userId) {
        if (!this.stats[userId]) {
            // Create default stats object for new users
            this.stats[userId] = {
                prsApproved: 0,
                prsAuthored: 0,
                commentsOnPRs: 0,
                prsReviewed: 0,
                prsMerged: 0,
                fastestApproval: null, // Will store timestamp in milliseconds
                streakDays: 0,
                lastActivity: null,
                weeklyActivity: {}, // Will store counts by ISO week
            };
        }
    }

    /**
     * Record a PR approval by a user
     * @param {string} userId - Slack user ID of the approver
     * @param {Object} pr - PR object containing metadata
     */
    recordApproval(userId, pr) {
        // Initialize user stats if needed
        this.initUserStats(userId);
        
        // Increment approval count
        this.stats[userId].prsApproved += 1;
        
        // Update last activity timestamp
        this.stats[userId].lastActivity = new Date().toISOString();
        
        // Update streak
        this.updateStreak(userId);
        
        // Update weekly activity
        this.updateWeeklyActivity(userId, 'approvals');
        
        // Calculate approval speed if possible
        if (pr.createdAt) {
            const createdTime = new Date(pr.createdAt).getTime();
            const approvalTime = new Date().getTime();
            const approvalSpeed = approvalTime - createdTime;
            
            // Update fastest approval if this is faster or if there's no previous record
            if (!this.stats[userId].fastestApproval || approvalSpeed < this.stats[userId].fastestApproval) {
                this.stats[userId].fastestApproval = approvalSpeed;
            }
        }
        
        // Save changes
        this.saveStats();
    }

    /**
     * Record a PR authored by a user
     * @param {string} userId - Slack user ID of the author
     */
    recordAuthoredPR(userId) {
        this.initUserStats(userId);
        this.stats[userId].prsAuthored += 1;
        this.stats[userId].lastActivity = new Date().toISOString();
        this.updateStreak(userId);
        this.updateWeeklyActivity(userId, 'authored');
        this.saveStats();
    }

    /**
     * Record a comment made by a user on a PR
     * @param {string} userId - Slack user ID of the commenter
     */
    recordComment(userId) {
        this.initUserStats(userId);
        this.stats[userId].commentsOnPRs += 1;
        this.stats[userId].lastActivity = new Date().toISOString();
        this.updateStreak(userId);
        this.updateWeeklyActivity(userId, 'comments');
        this.saveStats();
    }

    /**
     * Record a PR merged by a user
     * @param {string} userId - Slack user ID of the user who merged
     */
    recordMerge(userId) {
        this.initUserStats(userId);
        this.stats[userId].prsMerged += 1;
        this.stats[userId].lastActivity = new Date().toISOString();
        this.updateStreak(userId);
        this.updateWeeklyActivity(userId, 'merges');
        this.saveStats();
    }

    /**
     * Update the user's activity streak
     * @param {string} userId - Slack user ID
     */
    updateStreak(userId) {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const lastActivity = this.stats[userId].lastActivity;
        
        if (lastActivity) {
            const lastDate = new Date(lastActivity).toISOString().split('T')[0];
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            
            if (lastDate === today) {
                // Already recorded activity today, no streak change
                return;
            } else if (lastDate === yesterdayStr) {
                // Activity was yesterday, increment streak
                this.stats[userId].streakDays += 1;
            } else {
                // Activity was before yesterday, reset streak
                this.stats[userId].streakDays = 1;
            }
        } else {
            // First activity, start streak at 1
            this.stats[userId].streakDays = 1;
        }
    }

    /**
     * Update weekly activity metrics
     * @param {string} userId - Slack user ID
     * @param {string} activityType - Type of activity (approvals, authored, comments, merges)
     */
    updateWeeklyActivity(userId, activityType) {
        const now = new Date();
        const year = now.getFullYear();
        const weekNumber = this.getWeekNumber(now);
        const weekKey = `${year}-W${weekNumber}`;
        
        if (!this.stats[userId].weeklyActivity[weekKey]) {
            this.stats[userId].weeklyActivity[weekKey] = {
                approvals: 0,
                authored: 0,
                comments: 0,
                merges: 0,
            };
        }
        
        this.stats[userId].weeklyActivity[weekKey][activityType] += 1;
    }

    /**
     * Get ISO week number for a date
     * @param {Date} date - Date to get week number for
     * @returns {number} Week number (1-53)
     */
    getWeekNumber(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }

    /**
     * Get statistics for a specific user
     * @param {string} userId - Slack user ID
     * @returns {Object|null} User statistics or null if user not found
     */
    getUserStats(userId) {
        return this.stats[userId] || null;
    }

    /**
     * Get leaderboard data for all users
     * @param {string} metric - Metric to rank by (prsApproved, prsAuthored, commentsOnPRs, prsMerged, streakDays)
     * @param {number} limit - Maximum number of users to return
     * @returns {Array} Array of user stats sorted by the specified metric
     */
    getLeaderboard(metric = 'prsApproved', limit = 10) {
        const validMetrics = ['prsApproved', 'prsAuthored', 'commentsOnPRs', 'prsMerged', 'streakDays'];
        
        if (!validMetrics.includes(metric)) {
            metric = 'prsApproved'; // Default to prsApproved if invalid metric
        }
        
        return Object.entries(this.stats)
            .map(([userId, stats]) => ({
                userId,
                [metric]: stats[metric] || 0
            }))
            .sort((a, b) => b[metric] - a[metric])
            .slice(0, limit);
    }
}

// Create and export a singleton instance
export const userStatsTracker = new UserStatsTracker();
