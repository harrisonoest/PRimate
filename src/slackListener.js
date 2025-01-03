import pkg from "@slack/bolt";
const { App } = pkg;
import dotenv from "dotenv";
import { appConfig, BOT_USER_ID } from "./config.js";
import { canMergePR, mergePR } from "./bot.js";
import { prTracker } from "./prReminders.js";
import log from "./logger.js";

dotenv.config();

// === Constants === //

const app = new App(appConfig);

/** This is a comma-separated list of channel IDs */
const TARGET_CHANNEL_IDS = process.env.SLACK_CHANNEL_ID.split(",").map((id) =>
  id.trim()
);

// === Functions === //

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
      return true; // PR fully reviewed
    }
  }
  return false;
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
• React with :x: to stop tracking a PR
• React with :merge: to indicate the PR has been merged

*Thread Commands*
When in a PR thread, you can:
• \`@PRimate add-reviewer @user\` - Add a reviewer to the PR
• \`@PRimate remove-reviewer @user\` - Remove a reviewer from the PR

*Reminders*
• Daily summaries of open PRs are sent automatically at 9AM.`;

    await say({
      text: helpMessage,
      thread_ts: event.thread_ts || event.ts,
    });
    return;
  }

  // If this is a thread message, handle add/remove commands
  if (event.thread_ts) {
    const command = text.includes("add-reviewer")
      ? "add"
      : text.includes("remove-reviewer")
      ? "remove"
      : null;

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
          const added = await addReviewer(event.thread_ts, userId);
          if (added) {
            results.push(`<@${userId}> has been added as a reviewer.`);
          } else {
            results.push(`<@${userId}> is already a reviewer.`);
          }
        } else {
          // remove reviewer
          const removed = await removeReviewer(event.thread_ts, userId);
          if (removed) {
            results.push(`<@${userId}> has been removed as a reviewer.`);
          } else {
            results.push(`<@${userId}> was not a reviewer.`);
          }
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
        text: "I couldn't find a GitLab merge request URL in your message. Please make sure to include the full URL.",
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

    // Store PR tracking information
    prTracker.set(event.ts, {
      prUrl: prInfo.url,
      reviewers: reviewerIds,
      channel: event.channel,
      approved: false,
      projectPath: prInfo.projectPath,
      mrIid: prInfo.mrIid,
      authorId: event.user,
      lastUpdated: new Date().toISOString(), // Track initial creation time
    });

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
    item: { ts: messageTs, channel },
    user: reactingUser,
    reaction,
  } = event;

  // Check if this is a reaction to a tracked PR
  const pr = prTracker.get(messageTs);
  if (!pr) return;

  // Set the type of project
  // STB repos are in draft status and cannot be merged
  const isAsgard = pr.projectPath.includes("asgard");

  try {
    if (
      (reaction === "thumbsup" || reaction === "+1") &&
      pr.reviewers.includes(reactingUser)
    ) {
      // Remove the reacting user from reviewers
      const allApproved = removeReviewer(messageTs, reactingUser);

      // Get user's name for the message
      const userInfo = await app.client.users.info({ user: reactingUser });
      const userName = userInfo.user.name;

      await app.client.chat.postMessage({
        channel,
        thread_ts: messageTs,
        text: `${userName} has approved the PR! 👍`,
      });

      // If all reviewers have approved
      if (allApproved) {
        const canMerge = await canMergePR(pr.projectPath, pr.mrIid);
        const mergeFailureMessage = isAsgard
          ? "The PR cannot be merged at this time. Please check for conflicts or other issues."
          : "Please remove the PR from draft status and push the changes to the repo to trigger the smoke test.";
        const mergeMessage = canMerge
          ? "Would you like me to merge it for you? React to the parent message with ✅ to merge."
          : mergeFailureMessage;

        await app.client.chat.postMessage({
          channel,
          thread_ts: messageTs,
          text: `All reviewers have approved the PR! 🎉\n\n${mergeMessage}`,
        });
      }
    } else if (reaction === "memo") {
      // Get the reviewer's name who left the comment
      const reviewerInfo = await app.client.users.info({ user: reactingUser });
      const reviewerName =
        reviewerInfo.user.real_name || reviewerInfo.user.name;

      // Get the original poster's info
      const originalPoster = pr.authorId;

      // Update the lastUpdated time when comments are added
      pr.lastUpdated = new Date().toISOString();
      prTracker.set(messageTs, pr);

      await app.client.chat.postMessage({
        channel,
        thread_ts: messageTs,
        text: `Hey <@${originalPoster}>, ${reviewerName} has left some comments on your PR! 📝`,
      });
    } else if (reaction === "white_check_mark" && pr.approved && isAsgard) {
      // Check if PR can be merged
      const canMerge = await canMergePR(pr.projectPath, pr.mrIid);
      if (!canMerge) {
        await app.client.chat.postMessage({
          channel,
          thread_ts: messageTs,
          text: "❌ The PR cannot be merged at this time. Please check for conflicts or other issues.",
        });
        return;
      }

      // Try to merge the PR
      const merged = await mergePR(pr.projectPath, pr.mrIid);
      if (merged) {
        await app.client.chat.postMessage({
          channel,
          thread_ts: messageTs,
          text: "🎉 Successfully merged the PR!",
        });
      } else {
        await app.client.chat.postMessage({
          channel,
          thread_ts: messageTs,
          text: "❌ Failed to merge the PR. Please try merging manually.",
        });
      }
      // Stop tracking the PR in either case
      stopTrackingPR(messageTs);
    } else if (reaction === "merge") {
      // Stop tracking the PR entirely
      const wasTracked = stopTrackingPR(messageTs);
      if (wasTracked) {
        await app.client.chat.postMessage({
          channel,
          thread_ts: messageTs,
          text: `The PR has been merged :merge: and will no longer be tracked.`,
        });
      }
    } else if (reaction === "x") {
      // Stop tracking the PR entirely
      const wasTracked = stopTrackingPR(messageTs);
      if (wasTracked) {
        await app.client.chat.postMessage({
          channel,
          thread_ts: messageTs,
          text: `This PR will no longer be tracked.`,
        });
      }
    }
  } catch (error) {
    log("Error handling reaction:", error);
  }
});

// Export the setup function instead of running it directly
export async function setupSlackListener() {
  try {
    await app.start();
    log("⚡️ Slack Bolt app is running!");
    return app;
  } catch (error) {
    log("Error starting Slack Bolt app:", error);
    throw error;
  }
}

// Export the app for use in other files
export { app };
