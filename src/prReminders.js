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
 * @returns {Map<string, Array<{prUrl: string, messageTs: string, channel: string}>>} Map of reviewer ID to array of their pending PRs
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
          channel: pr.channel,
        });
      });
    } else {
      // Remove the PR from tracking if it's approved
      prTracker.delete(messageTs);
    }
  }

  return reviewerPRs;
}

/**
 * Get all PRs that haven't been updated, grouped by author
 * @returns {Map<string, Array<{prUrl: string, messageTs: string, channel: string}>>} Map of author ID to array of their stale PRs
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
          channel: pr.channel,
        });
      }
    }
  }

  return authorPRs;
}

/**
 * Creates a reminder message for stale PRs using Slack Block Kit
 * @param {string} userId - Slack user ID
 * @param {string} userName - User's real name
 * @param {Array} prs - Array of PR objects
 * @returns {Object} Formatted Slack message
 */
function createAuthorReminderMessage(userId, userName, prs) {
  return {
    channel: userId,
    text: `Stale PR Reminder for ${userName}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Hi ${userName}!* 👋 Your PR${
            prs.length > 1 ? "s haven't" : " hasn't"
          } been updated in over 24 hours.`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${prs.length} PR${
            prs.length > 1 ? "s need" : " needs"
          } attention:*\n${prs
            .map(
              (pr) =>
                `• <https://${process.env.SLACK_WORKSPACE}.slack.com/archives/${
                  pr.channel
                }/p${pr.messageTs.replace(".", "")}|View PR>`
            )
            .join("\n")}`,
        },
      },
    ],
  };
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

  // Fetch pending reviews and the reviewers for each PR
  const reviewerPRs = getPendingReviews();

  // Send reminders to reviewers
  for (const [reviewerId, prs] of reviewerPRs.entries()) {
    try {
      // Get user info for personalized message
      const userInfo = await slack.users.info({ user: reviewerId });
      const userName = userInfo.user.real_name;

      // Create message with list of PRs
      const prList = prs
        .map(
          (pr) =>
            `https://${process.env.SLACK_WORKSPACE}.slack.com/archives/${
              pr.channel
            }/p${pr.messageTs.replace(".", "")}`
        )
        .join("\n");
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
  const staleAuthorPRs = await getStaleAuthorPRs();

  // Return early if there are no stale PRs to process
  if (!staleAuthorPRs || staleAuthorPRs.size === 0) return;

  // Process in batches with rate limiting
  const BATCH_SIZE = 15; // Conservative limit for Slack's Tier 2
  const authorEntries = Array.from(staleAuthorPRs.entries());
  const batches = [];

  while (authorEntries.length) {
    batches.push(authorEntries.splice(0, BATCH_SIZE));
  }

  const results = [];
  for (const batch of batches) {
    const batchResults = await Promise.allSettled(
      batch.map(async ([authorId, prs]) => {
        await new Promise((resolve) => setTimeout(resolve, 1000 / BATCH_SIZE));
        try {
          const userInfo = await slack.users.info({ user: authorId });
          const userName = userInfo.user.real_name;
          const message = createAuthorReminderMessage(authorId, userName, prs);

          const result = await slack.chat.postMessage(message);
          return {
            status: "success",
            userId: authorId,
            prCount: prs.length,
            messageTs: result.ts,
          };
        } catch (error) {
          return {
            status: "error",
            userId: authorId,
            error: error.message,
            stack: error.stack,
          };
        }
      })
    );
    results.push(...batchResults);
  }

  // Log batch results
  const successful = results.filter(
    (r) => r.status === "fulfilled" && r.value.status === "success"
  );
  const failed = results.filter(
    (r) => r.status === "fulfilled" && r.value.status === "error"
  );
  const rejected = results.filter((r) => r.status === "rejected");

  log({
    event: "stale_pr_reminder_batch",
    totalAuthors: staleAuthorPRs.size,
    successful: successful.length,
    failed: failed.length + rejected.length,
    errors: [...failed.map((f) => f.value), ...rejected.map((r) => r.reason)],
  });
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
