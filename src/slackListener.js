import pkg from "@slack/bolt";
const { App } = pkg;
import dotenv from "dotenv";
import { appConfig, BOT_USER_ID } from "./config.js";
import { canMergePR, mergePR } from "./bot.js";
import { prTracker } from "./prReminders.js";
import log from "./logger.js";
import {
  trackPRCreation,
  trackPRApproval,
  trackComment,
  trackPRMerge,
  getUserStats,
  getLeaderboard,
  getUserAverages,
} from "./statistics.js";

dotenv.config();

// ============================== Constants ============================== //

const app = new App(appConfig);

// This is a comma-separated list of channel IDs
const TARGET_CHANNEL_IDS = process.env.SLACK_CHANNEL_ID.split(",").map((id) =>
  id.trim()
);

// Emojis that indicate different actions
const approvalEmojis = ["thumbsup", "+1"];
const commentEmojis = ["memo"];
const mergeEmojis = ["merge"];
const stopEmojis = ["x"];
const fixedEmojis = ["fixed", "hammer_and_wrench", "wrench"];

// ============================== Functions ============================== //

// Function to extract PR URL from message
function extractPRUrl(text) {
  // Find any URLs in the text
  const urls = text.match(/(https?:\/\/[^\s>]+)/g);
  log("Found URLs:", urls);

  if (!urls) return null;

  // Find the first URL that contains the GITLAB_HOST and the text, "merge_requests"
  const gitlabUrl = urls.find(
    (url) =>
      url.includes(process.env.GITLAB_HOST) && url.includes("merge_requests")
  );

  if (!gitlabUrl) return null;

  // Extract project path components
  const parts = gitlabUrl.split("/");
  const mrIndex = parts.findIndex((part) => part === "merge_requests");
  if (mrIndex === -1 || !parts[mrIndex + 1]) return null;

  // Get workspace, group (if exists), and project name
  const pathParts = parts.slice(3, mrIndex - 1); // Skip protocol, domain, and -
  if (pathParts.length < 2) return null;

  const workspace = pathParts[0];
  const projectName = pathParts[pathParts.length - 1];
  const group = pathParts.length === 3 ? pathParts[1] : null;

  // Build project path based on whether group exists
  const projectPath = group
    ? `${workspace}/${group}/${projectName}`
    : `${workspace}/${projectName}`;

  return {
    url: gitlabUrl,
    workspace,
    group,
    projectName,
    projectPath,
    mrIid: parseInt(parts[mrIndex + 1], 10),
  };
}

// Function to extract reviewers from Slack message
function extractReviewerIds(text) {
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  const matches = [...text.matchAll(mentionRegex)];
  // Filter out the bot's own ID and return unique user IDs
  const reviewerIds = [
    ...new Set(
      matches.map((match) => match[1]).filter((id) => id !== BOT_USER_ID)
    ),
  ];
  log("Extracted reviewer IDs:", reviewerIds);
  return reviewerIds;
}

// Function to remove a reviewer from tracking
async function removeReviewer(messageTs, reviewerId) {
  const pr = prTracker.get(messageTs);
  if (pr) {
    pr.reviewers = pr.reviewers.filter((id) => id !== reviewerId);
    if (pr.reviewers.length === 0) {
      pr.approved = true; // Mark as approved instead of deleting
    }
    return prTracker.set(messageTs, pr); // Update the Map with modified pr
  }
  return false;
}

// Function to check if all reviewers have approved the PR
function allReviewersApproved(messageTs) {
  const pr = prTracker.get(messageTs);
  return pr && pr.approved;
}

// Function to stop tracking a PR completely
function stopTrackingPR(messageTs) {
  return prTracker.delete(messageTs);
}

// Function to add a reviewer to a PR
async function addReviewer(messageTs, reviewerId) {
  const pr = prTracker.get(messageTs);
  if (!pr) return false;

  if (!pr.reviewers.includes(reviewerId)) {
    pr.reviewers.push(reviewerId);
    prTracker.set(messageTs, pr);
    return true;
  }
  return false;
}

// Function to handle PR approval
async function handlePrApproval(channel, messageTs, pr, reactingUser) {
  // Check if this is an Asgard PR
  // STB PRs are in draft status and cannot be merged
  const isAsgard = pr.projectPath.includes("asgard");

  const approvedAt = new Date().toISOString();

  // Track the approval time for this reviewer
  if (!pr.approvalTimes) {
    pr.approvalTimes = {};
  }
  pr.approvalTimes[reactingUser] = approvedAt;

  // Track first approval if this is the first one
  if (!pr.firstApprovalAt) {
    pr.firstApprovalAt = approvedAt;
  }

  // Track approval statistics
  trackPRApproval(
    reactingUser,
    pr.authorId,
    pr.createdAt || approvedAt,
    approvedAt
  );

  // Remove the reacting user from reviewers. This function returns true if all reviewers have been removed.
  await removeReviewer(messageTs, reactingUser).then((reviewerRemoved) => {
    if (reviewerRemoved) {
      log("Reviewer removed:", reactingUser);
    } else {
      log("Failed to remove reviewer:", reactingUser);
      return;
    }
  });

  // If all reviewers have approved
  if (allReviewersApproved(messageTs)) {
    const canMerge = await canMergePR(pr.projectPath, pr.mrIid);
    const mergeFailureMessage = isAsgard
      ? "The PR cannot be merged at this time. Please check for conflicts or other issues."
      : "Please remove the PR from draft status and push the changes to the repo to trigger the smoke test.";

    const mergeMessage = canMerge
      ? "All reviewers have approved the PR! 🎉"
      : `All reviewers have approved the PR! 🎉\n\n${mergeFailureMessage}`;

    await app.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: mergeMessage,
    });
  } else {
    // Get user's name for the message
    const userInfo = await app.client.users.info({ user: reactingUser });
    const userName = userInfo.user.real_name || userInfo.user.name;

    // Alert the author that a reviewer has approved the PR
    await app.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `${userName} has approved the PR! 👍`,
    });
  }
}

// Function to handle comments on a PR
async function handleCommentsOnPR(channel, messageTs, pr, reactingUser) {
  // Get the reviewer's name who left the comment
  const reviewerInfo = await app.client.users.info({
    user: reactingUser,
  });
  const reviewerName = reviewerInfo.user.real_name || reviewerInfo.user.name;

  // Get the original poster's info
  const originalPoster = pr.authorId;

  // Track the user who left comments (if not already tracked)
  if (!pr.commenters) {
    pr.commenters = [];
  }
  if (!pr.commenters.includes(reactingUser)) {
    pr.commenters.push(reactingUser);
  }

  // Track comment statistics
  trackComment(reactingUser, pr.prUrl);

  // Update the lastUpdated time when comments are added
  pr.lastUpdated = new Date().toISOString();
  prTracker.set(messageTs, pr);

  await app.client.chat.postMessage({
    channel,
    thread_ts: messageTs,
    text: `Hey <@${originalPoster}>, ${reviewerName} has left some comments on your PR! 📝`,
  });
}

// Function to handle merging a PR
async function handleMerge(channel, messageTs) {
  const pr = prTracker.get(messageTs);
  const mergedAt = new Date().toISOString();

  if (pr) {
    // Mark PR as merged and track merge statistics
    pr.merged = true;
    trackPRMerge(pr.authorId, pr.createdAt || mergedAt, mergedAt);
  }

  if (stopTrackingPR(messageTs)) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `The PR has been merged :merge: and will no longer be tracked.`,
    });
  } else {
    log("There was an error removing this PR from being tracked.");
    await app.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `There was an error removing this PR from being tracked.`,
    });
  }
}

// Function to stop tracking a PR
async function handleStopTracking(channel, messageTs) {
  if (stopTrackingPR(messageTs)) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `This PR will no longer be tracked.`,
    });
  } else {
    log("There was an error removing this PR from being tracked.");
    await app.client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `There was an error removing this PR from being tracked.`,
    });
  }
}

// Function to handle when PR author marks issues as fixed
async function handlePRFixed(channel, messageTs, pr, reactingUser) {
  // Only allow the PR author to use this reaction
  if (reactingUser !== pr.authorId) {
    return;
  }

  // Get all users who left comments on this PR
  const commenters = pr.commenters || [];

  if (commenters.length === 0) {
    return; // No commenters to notify
  }

  // Get the PR author's name
  const authorInfo = await app.client.users.info({ user: reactingUser });
  const authorName = authorInfo.user.real_name || authorInfo.user.name;

  // Create mentions for all commenters
  const commenterMentions = commenters
    .map((userId) => `<@${userId}>`)
    .join(", ");

  await app.client.chat.postMessage({
    channel,
    thread_ts: messageTs,
    text: `🔧 ${authorName} has marked the issues as fixed! ${commenterMentions}, please review the updates.`,
  });
}

// ============================== Event Listeners ============================== //

// Listen for messages that mention the bot
app.event("app_mention", async ({ event, say }) => {
  const text = event.text.toLowerCase();

  // Handle help command
  if (text.includes("help")) {
    const helpMessage = `Here's how to use PRimate Bot:

*Basic Commands*
• Post a GitLab PR link in this channel to start tracking it
• Add reviewers by mentioning them in the same message as the PR link
• React with 👍 to approve a PR
• React with :memo: to leave a comment on a PR
• React with :fixed:, :hammer_and_wrench:, or :wrench: (PR author only) to notify commenters that issues have been addressed
• React with :x: to stop tracking a PR

*Thread Commands*
When in a PR thread, you can:
• \`@PRimate add-reviewer @user\` - Add a reviewer to the PR
• \`@PRimate remove-reviewer @user\` - Remove a reviewer from the PR

*Statistics Commands*
• \`@PRimate stats me\` - View your personal PR statistics
• \`@PRimate leaderboard\` - View top PR authors
• \`@PRimate top approvers\` - View top PR approvers
• \`@PRimate leaderboard comments\` - View most active reviewers
• \`@PRimate top fastest\` - View fastest approval times
• \`@PRimate leaderboard longest\` - View longest PR durations

*Reminders*
• Daily summaries of open PRs are sent automatically at 9AM.`;

    await say({
      text: helpMessage,
      thread_ts: event.thread_ts || event.ts,
    });
    return;
  }

  // Handle statistics commands
  if (text.includes("stats")) {
    // Personal stats command
    if (text.includes("me") || text.includes("my")) {
      const userStats = getUserStats(event.user);
      const averages = getUserAverages(event.user);

      if (!userStats) {
        await say({
          text: "You don't have any tracked statistics yet! Start by creating or reviewing PRs.",
          thread_ts: event.thread_ts || event.ts,
        });
        return;
      }

      const statsMessage = `📊 *Your Statistics:*
      
*Authoring:*
• PRs Created: ${userStats.prsAuthored}
• PRs Merged: ${userStats.prsMerged}
• Longest PR Duration: ${
        userStats.longestPRDuration
          ? `${Math.round(userStats.longestPRDuration / 60)} hours`
          : "N/A"
      }
• Average PR Duration: ${
        averages && averages.avgPRDuration
          ? `${Math.round(averages.avgPRDuration / 60)} hours`
          : "N/A"
      }

*Reviewing:*
• PRs Approved: ${userStats.prsApproved}  
• Comments Left: ${userStats.commentsLeft}
• Fastest Approval: ${
        userStats.fastestApproval
          ? `${userStats.fastestApproval} minutes`
          : "N/A"
      }
• Average Approval Time: ${
        averages && averages.avgApprovalTime
          ? `${averages.avgApprovalTime} minutes`
          : "N/A"
      }

_Stats since: ${new Date(userStats.firstActivity).toLocaleDateString()}_`;

      await say({
        text: statsMessage,
        thread_ts: event.thread_ts || event.ts,
      });
      return;
    }

    // Leaderboard commands
    if (text.includes("leaderboard") || text.includes("top")) {
      let metric = "prsAuthored"; // default
      let title = "PR Authors";

      if (text.includes("approvers") || text.includes("approved")) {
        metric = "prsApproved";
        title = "PR Approvers";
      } else if (text.includes("comments") || text.includes("reviewers")) {
        metric = "commentsLeft";
        title = "Active Reviewers";
      } else if (text.includes("mergers") || text.includes("merged")) {
        metric = "prsMerged";
        title = "PR Mergers";
      } else if (text.includes("fastest")) {
        metric = "fastestApproval";
        title = "Fastest Approvers";
      } else if (text.includes("longest")) {
        metric = "longestPRDuration";
        title = "Longest PR Durations";
      }

      const leaderboard = getLeaderboard(metric, 10);

      if (leaderboard.length === 0) {
        await say({
          text: `No data available for ${title.toLowerCase()} yet.`,
          thread_ts: event.thread_ts || event.ts,
        });
        return;
      }

      // Get user info for display names
      const leaderboardWithNames = await Promise.all(
        leaderboard.map(async (entry, index) => {
          try {
            const userInfo = await app.client.users.info({
              user: entry.userId,
            });
            const name = userInfo.user.real_name || userInfo.user.name;
            let valueDisplay = entry.value;

            // Format time-based metrics
            if (metric === "fastestApproval") {
              valueDisplay = `${entry.value} minutes`;
            } else if (metric === "longestPRDuration") {
              valueDisplay = `${Math.round(entry.value / 60)} hours`;
            }

            return `${index + 1}. ${name}: ${valueDisplay}`;
          } catch (error) {
            return `${index + 1}. ${entry.userId}: ${entry.value}`;
          }
        })
      );

      const leaderboardMessage = `🏆 *Top ${title}:*\n\n${leaderboardWithNames.join(
        "\n"
      )}`;

      await say({
        text: leaderboardMessage,
        thread_ts: event.thread_ts || event.ts,
      });
      return;
    }
  }

  // If this is a thread message, handle add/remove commands
  if (event.thread_ts) {
    const command =
      ["add-reviewer", "remove-reviewer"]
        .find((cmd) => text.includes(cmd))
        ?.split("-")[0] || null;

    if (command) {
      // Extract mentioned users (excluding the bot)
      const mentionedUsers = extractReviewerIds(event.text);

      if (mentionedUsers.length === 0) {
        await say({
          text: "Please mention the user(s) you want to add or remove.",
          thread_ts: event.thread_ts,
        });
        return;
      }

      // Get the PR being tracked in this thread
      const pr = prTracker.get(event.thread_ts);
      if (!pr) {
        await say({
          text: "I couldn't find a tracked PR in this thread.",
          thread_ts: event.thread_ts,
        });
        return;
      }

      const results = [];
      for (const userId of mentionedUsers) {
        if (command === "add") {
          await addReviewer(event.thread_ts, userId).then((added) => {
            results.push(
              added
                ? `<@${userId}> has been added as a reviewer.`
                : `<@${userId}> is already a reviewer.`
            );
          });
        } else {
          await removeReviewer(event.thread_ts, userId).then((removed) => {
            results.push(
              removed
                ? `<@${userId}> has been removed as a reviewer.`
                : `<@${userId}> was not a reviewer.`
            );
          });
        }
      }

      await say({
        text: results.join("\n"),
        thread_ts: event.thread_ts,
      });
      return;
    }
  }

  // If not a thread message or not an add/remove command, proceed with original PR tracking logic
  if (!TARGET_CHANNEL_IDS.includes(event.channel)) return;

  try {
    const text = event.text;

    // Extract PR URL using regex
    const prInfo = extractPRUrl(text);
    if (!prInfo) {
      log("No PR URL found in message");
      await say({
        text: "I couldn't find a GitLab merge request URL in your message. Please make sure to include the full URL (e.g., https://gitlab.windows.nagrastar.com/group/project/-/merge_requests/123)",
        thread_ts: event.ts,
      });
      return;
    }

    // Check if the PR URL is already being tracked
    const isTracked = Array.from(prTracker.values()).some(
      (pr) => pr.prUrl === prInfo.url
    );

    if (isTracked) {
      await say({
        text: "This PR is already being tracked.",
        thread_ts: event.ts,
      });
      return;
    }

    const reviewerIds = extractReviewerIds(text);

    if (reviewerIds.length === 0) {
      await say({
        text: "Please mention the reviewers you'd like me to track.",
        thread_ts: event.ts,
      });
      return;
    }

    const createdAt = new Date().toISOString();

    // Store PR tracking information
    prTracker.set(event.ts, {
      prUrl: prInfo.url,
      reviewers: reviewerIds,
      channel: event.channel, // Add channel ID to tracking info
      approved: false,
      merged: false,
      projectPath: prInfo.projectPath,
      mrIid: prInfo.mrIid,
      authorId: event.user,
      createdAt: createdAt, // Track PR creation time
      lastUpdated: createdAt,
      commenters: [], // Track users who left comments
      approvalTimes: {}, // Track individual approval times
      firstApprovalAt: null, // Track first approval
    });

    // Track PR creation statistics
    trackPRCreation(event.user, prInfo.url, createdAt);

    // Get usernames for display
    const reviewers = await Promise.all(
      reviewerIds.map(async (userId) => {
        try {
          const userInfo = await app.client.users.info({ user: userId });
          return userInfo.user.real_name;
        } catch (error) {
          log(`Error getting user info for ${userId}:`, error);
          return userId;
        }
      })
    );

    // Process the PR with reviewers
    await say({
      text: `Got it! I'll track this PR.\n\n*Current reviewers:*\n${reviewers
        .map((reviewer) => `• ${reviewer}`)
        .join("\n")}`,
      thread_ts: event.ts,
    });
  } catch (error) {
    log("Error processing PR:", error);
    await say({
      text: "Sorry, I encountered an error while processing your request.",
      thread_ts: event.ts,
    });
  }
});

// Handle reaction added events
app.event("reaction_added", async ({ event }) => {
  const {
    item: { ts: messageTs, channel, thread_ts },
    user: reactingUser,
    reaction,
  } = event;

  // Ignore reactions on thread replies
  if (thread_ts) return;

  // Check if this is a reaction to a tracked PR
  const pr = prTracker.get(messageTs);
  if (!pr) return;

  // Check if the reacting user is a reviewer
  const reviewerFound = pr.reviewers.includes(reactingUser);

  try {
    switch (true) {
      case approvalEmojis.some((emoji) => reaction.includes(emoji)) &&
        reviewerFound: // Allow approval if reviewer
        await handlePrApproval(channel, messageTs, pr, reactingUser);
        break;
      case commentEmojis.some((emoji) => reaction.includes(emoji)) &&
        reviewerFound: // Allow comments if reviewer
        await handleCommentsOnPR(channel, messageTs, pr, reactingUser);
        break;
      case mergeEmojis.some((emoji) => reaction.includes(emoji)):
        await handleMerge(channel, messageTs);
        break;
      // Note: This is different because the stop emoji is simply "x" so we can't
      //       use a substring.
      case stopEmojis.some((emoji) => reaction == emoji):
        await handleStopTracking(channel, messageTs);
        break;
      case fixedEmojis.some((emoji) => reaction.includes(emoji)):
        await handlePRFixed(channel, messageTs, pr, reactingUser);
        break;
    }
  } catch (error) {
    log("[slackListener.js] Error handling reaction:", error);
  }
});

// ============================== Exported Functions ============================== //

// Export the setup function instead of running it directly
export async function setupSlackListener() {
  try {
    await app.start();
    log("[slackListener.js] ⚡️ Slack Bolt app is running!");
    return app;
  } catch (error) {
    log("[slackListener.js] Error starting Slack Bolt app:", error);
    throw error;
  }
}

// Export the app for use in other files
export { app };
