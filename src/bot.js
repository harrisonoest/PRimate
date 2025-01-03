import { exec } from "child_process";
import { promisify } from "util";
import { setupSlackListener } from "./slackListener.js";
import { scheduleReminders } from "./prReminders.js";
import log from "./logger.js";
import dotenv from "dotenv";

dotenv.config();

// === Constants === //

/** Wrapper for child_process.exec */
const execAsync = promisify(exec);

// === GitLab Integration === //

/**
 * Checks the last update of a merge request
 * @param {string} projectPath - The GitLab project path
 * @param {number} mrIid - The merge request IID
 * @returns {Promise<string | null>} The last update timestamp, or null if not found
 */
async function checkLastUpdate(projectPath, mrIid) {
  try {
    const { stdout } = await execAsync(
      `glab mr view ${mrIid} --repo ${projectPath} -F json`
    );
    const mrData = JSON.parse(stdout);
    return mrData.updated_at;
  } catch (error) {
    log("Error checking last update:", error);
    return null;
  }
}

/**
 * Checks if a merge request can be merged
 * @param {string} projectPath - The GitLab project path
 * @param {number} mrIid - The merge request IID
 * @returns {Promise<boolean>} Whether the MR can be merged
 */
async function canMergePR(projectPath, mrIid) {
  try {
    const { stdout } = await execAsync(
      `glab mr view ${mrIid} --repo ${projectPath} -F json`
    );
    const mrData = JSON.parse(stdout);
    return (
      mrData.merge_status === "can_be_merged" &&
      !mrData.draft &&
      !mrData.work_in_progress
    );
  } catch (error) {
    log("Error checking if PR can be merged:", error);
    return false;
  }
}

/**
 * Merges a merge request
 * @param {string} projectPath - The GitLab project path
 * @param {number} mrIid - The merge request IID
 * @returns {Promise<boolean>} Whether the merge was successful
 */
async function mergePR(projectPath, mrIid) {
  try {
    await execAsync(`glab mr merge ${mrIid} --repo ${projectPath}`);
    log("Merged PR %s for %s", mrIid, projectPath);
    return true;
  } catch (error) {
    log("Error merging PR:", error);
    return false;
  }
}

/**
 * Setup GitLab authentication
 */
async function setupGitLab() {
  try {
    await execAsync(
      `glab auth login -h ${process.env.GITLAB_HOST} -t ${process.env.GITLAB_TOKEN}`
    );
    await execAsync(`glab auth status -h ${process.env.GITLAB_HOST}`);
    log("GitLab authentication verified");
  } catch (error) {
    log("Error verifying GitLab authentication:", error);
  }
}

// Initial setup
setupGitLab()
  .then(async () => {
    // Set up Slack event listener
    await setupSlackListener({ canMergePR, mergePR });

    // Schedule reminders
    scheduleReminders();
  })
  .catch((error) => {
    log("Error during setup:", error);
    process.exit(1);
  });

process.on("unhandledRejection", (error) => {
  log("Unhandled Rejection:", error);
});

// Export the merge functions
export { checkLastUpdate, canMergePR, mergePR };
