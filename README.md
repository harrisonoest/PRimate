# PRimate Bot

PRimate Bot is a Slack bot designed to help Wukong teams track GitLab PRs. It monitors specified Slack channels for GitLab PR links, posts PR comments in Slack threads, notifies about pipeline failures, and sends daily summaries of open PRs.

## Features

- Detects GitLab PR links in specified Slack channels
- Posts PR comments in Slack threads
- Notifies about pipeline failures
- Sends daily summaries of open PRs

## Manual Setup

1. Clone this repository
2. Install dependencies with `npm i`
3. Create a `.env` file

## Usage

### Basic Commands
- Tag the bot with `@PRimate help` to see this list of commands
- Post a GitLab PR link in a monitored channel to start tracking it
- Add reviewers by mentioning them in the same message as the PR link
- React with 👍 to approve a PR
- React with :memo: to indicate you've left comments on the PR
- React with :fixed:, :hammer_and_wrench:, or :wrench: (PR author only) to notify commenters that issues have been addressed
- React with :x: to stop tracking a PR
- React with :merge: to indicate the PR has been merged

### Thread Commands
When in a PR thread, you can:
- `@PRimate add-reviewer @user` - Add a reviewer to the PR
- `@PRimate remove-reviewer @user` - Remove a reviewer from the PR

### Statistics Commands
The bot tracks comprehensive PR statistics and provides leaderboards:
- `@PRimate stats me` - View your personal PR statistics
- `@PRimate leaderboard` - View top PR authors
- `@PRimate top approvers` - View top PR approvers
- `@PRimate leaderboard comments` - View most active reviewers
- `@PRimate top fastest` - View fastest approval times
- `@PRimate leaderboard longest` - View longest PR durations

### Daily Summaries
The bot sends daily summaries of open PRs at the configured time. These summaries include:
- Open PRs awaiting review
- Current reviewers and their status

## Configuration

Update the `.env` file to change:
- Monitored Slack channels
- Daily summary time
- API keys

## Improvements
- Slack messages for pipeline failures
- Create dashboard for viewing data
- Support for GitHub links
