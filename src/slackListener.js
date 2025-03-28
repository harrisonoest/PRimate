import pkg from "@slack/bolt";
const { App } = pkg;
import dotenv from "dotenv";
import { appConfig, BOT_USER_ID } from "./config.js";
import { canMergePR, mergePR } from "./bot.js";
import { prTracker } from "./prReminders.js";
import log from "./logger.js";

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
• React with :x: to stop tracking a PR

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
        text: `I couldn't find a GitLab merge request URL in your message. Please make sure to include the full URL (e.g., https://${process.env.GITLAB_HOST}/group/project/-/merge_requests/123)`,
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
      channel: event.channel, // Add channel ID to tracking info
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
      case stopEmojis.some((emoji) => reaction.includes(emoji)):
        await handleStopTracking(channel, messageTs);
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
