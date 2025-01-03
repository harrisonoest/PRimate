#!/bin/bash

# This script processes a Slack users JSON file to create a simplified version
# containing only active, non-bot users. It filters out deleted, restricted,
# and bot accounts, and extracts essential user information (ID, name, and
# real name) for easier management and analysis.

# Input and output files
INPUT_FILE="../data/slack_users.json"
OUTPUT_FILE="../data/simplified_users.json"

# Use jq to filter and transform the JSON
jq '
def process_member:
  select(
    .deleted == false                           # Not deleted
    and (.is_bot // false) == false            # Not a bot
    and (.is_restricted // false) == false     # Not restricted
    and (.is_ultra_restricted // false) == false # Not ultra restricted
    and (.name | test("bot|Bot|BOT") | not)   # Name doesnt contain bot
    and (.profile.api_app_id // "" | length == 0) # Not an app
  )
  | {
    key: .id,
    value: {
      name,
      real_name
    }
  };

.members
| map(process_member)
| from_entries
' "$INPUT_FILE" > "$OUTPUT_FILE"

echo "Simplified user data has been saved to $OUTPUT_FILE"
