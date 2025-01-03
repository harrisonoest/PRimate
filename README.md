# PRimate Bot

PRimate Bot is a Slack bot designed to help the teams track GitLab PRs. It monitors specified Slack channels for GitLab PR links, posts PR comments in Slack threads, notifies about pipeline failures, and sends daily summaries of open PRs.

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
- React with :x: to stop tracking a PR
- React with :merge: to indicate the PR has been merged
- Once a PR is fully approved, the bot can merge it with a :white_check_mark:

### Thread Commands
When in a PR thread, you can:
- `@PRimate add-reviewer @user` - Add a reviewer to the PR
- `@PRimate remove-reviewer @user` - Remove a reviewer from the PR

### Daily Summaries
The bot sends daily summaries of open PRs at the configured time. These summaries include:
- Open PRs awaiting review
- Current reviewers and their status

## Configuration

Update the `.env` file to change:
- Monitored Slack channels
- Daily summary time
- API keys

## Things to Test
- Reminders
- Different projects/repos
- Removing/adding users
- Install on the host machine

## Future Features
- Send message for pipeline failures
- Remind if PR not updated in a certain amount of time?
