import { WebClient } from "@slack/web-api";
import log from "./logger.js";
import dotenv from "dotenv";
import { loadPRData, savePRData } from "./storage.js";
import { checkLastUpdate } from "./bot.js";
dotenv.config();

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Load PR tracking information from storage
export const prTracker = loadPRData();

// Wrap Map methods to persist changes
const originalSet = prTracker.set.bind(prTracker);
prTracker.set = function (key, value) {
  const result = originalSet(key, value);
  savePRData(prTracker);
  return result;
};

const originalDelete = prTracker.delete.bind(prTracker);
prTracker.delete = function (key) {
  const result = originalDelete(key);
  savePRData(prTracker);
  return result;
};

/**
 * Get all PRs that need review, grouped by reviewer
 * @returns {Map<string, Array<{prUrl: string, messageTs: string}>>} Map of reviewer ID to array of their pending PRs
 */
function getPendingReviews() {
  const reviewerPRs = new Map();

  // Iterate through all tracked PRs
  for (const [messageTs, pr] of prTracker.entries()) {
    if (!pr.approved) {
      // Add each reviewer's pending PRs to their list
      pr.reviewers.forEach((reviewerId) => {
        if (!reviewerPRs.has(reviewerId)) {
          reviewerPRs.set(reviewerId, []);
        }
        reviewerPRs.get(reviewerId).push({
          prUrl: pr.prUrl,
          messageTs: messageTs,
        });
      });
    }
  }

  return reviewerPRs;
}

/**
 * Get all PRs that haven't been updated, grouped by author
 * @returns {Map<string, Array<{prUrl: string, messageTs: string}>>} Map of author ID to array of their stale PRs
 */
async function getStaleAuthorPRs() {
  const authorPRs = new Map();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date();

  // Iterate through all tracked PRs
  for (const [messageTs, pr] of prTracker.entries()) {
    if (!pr.approved && pr.lastUpdated) {
      const prLastUpdated = await checkLastUpdate(pr.projectPath, pr.mrIid);
      const lastUpdateTime = new Date(prLastUpdated);
      if (now - lastUpdateTime > ONE_DAY_MS) {
        const authorId = pr.authorId;
        if (!authorPRs.has(authorId)) {
          authorPRs.set(authorId, []);
        }
        authorPRs.get(authorId).push({
          prUrl: pr.prUrl,
          messageTs: messageTs,
        });
      }
    }
  }

  return authorPRs;
}

/**
 * Send reminder messages to users about their pending PR reviews
 */
export async function sendReminders() {
  // Check if it's weekend (Saturday = 6, Sunday = 0)
  const today = new Date().getDay();
  if (today === 0 || today === 6) {
    log("Skipping PR reminders as it is a weekend day.");
    return;
  }

  const reviewerPRs = getPendingReviews();
  const staleAuthorPRs = getStaleAuthorPRs();

  // Send reminders to reviewers
  for (const [reviewerId, prs] of reviewerPRs.entries()) {
    try {
      // Get user info for personalized message
      const userInfo = await slack.users.info({ user: reviewerId });
      const userName = userInfo.user.real_name;

      // Create message with list of PRs
      const prList = prs.map((pr) => pr.prUrl).join("\n");
      const message = {
        channel: reviewerId, // Send DM to user
        text: `Hi, ${userName}! 👋 You have ${prs.length} pending PR${
          prs.length > 1 ? "s" : ""
        } to review:\n\n${prList}`,
      };

      // Send the reminder
      await slack.chat.postMessage(message);
      log(`Sent reminder to ${userName} about ${prs.length} PRs`);
    } catch (error) {
      log(`Error sending reminder to reviewer ${reviewerId}:`, error);
    }
  }

  // Send reminders to PR authors with stale PRs
  for (const [authorId, prs] of staleAuthorPRs.entries()) {
    try {
      // Get user info for personalized message
      const userInfo = await slack.users.info({ user: authorId });
      const userName = userInfo.user.real_name;

      // Create message with list of PRs
      const prList = prs.map((pr) => pr.prUrl).join("\n");
      const message = {
        channel: authorId, // Send DM to user
        text: `Hi, ${userName}! 👋 Your PR${
          prs.length > 1 ? "s haven't" : " hasn't"
        } been updated in over 24 hours. Please review the comments and update ${
          prs.length > 1 ? "them" : "it"
        } when you can:\n\n${prList}`,
      };

      // Send the reminder
      await slack.chat.postMessage(message);
      log(`Sent reminder to author ${userName} about ${prs.length} stale PRs`);
    } catch (error) {
      log(`Error sending reminder to author ${authorId}:`, error);
    }
  }
}

/**
 * Schedule daily reminders at a specific time
 * Uses REMINDER_TIME environment variable in format "HH:MM" (24-hour format)
 * Defaults to 09:00 if not set
 */
export function scheduleReminders() {
  const reminderTime = process.env.REMINDER_TIME || "09:00";
  const [hour, minute] = reminderTime.split(":").map(Number);

  if (
    isNaN(hour) ||
    isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(
      "Invalid REMINDER_TIME format. Use HH:MM in 24-hour format (e.g. 09:00)"
    );
  }

  const now = new Date();
  let scheduledTime = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute
  );

  // Convert scheduled time to local timezone
  scheduledTime = new Date(scheduledTime.toLocaleString());

  // If the time has already passed today, schedule for tomorrow
  if (now > scheduledTime) {
    scheduledTime.setDate(scheduledTime.getDate() + 1);
  }

  // Calculate delay until first reminder
  const delay = scheduledTime.getTime() - now.getTime();

  // Schedule first reminder
  setTimeout(() => {
    sendReminders();
    // Schedule subsequent reminders every 24 hours
    setInterval(sendReminders, 24 * 60 * 60 * 1000);
  }, delay);

  log(`Reminders scheduled for ${scheduledTime.toLocaleString()}`);
}
