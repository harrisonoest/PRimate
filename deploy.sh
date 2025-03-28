#!/bin/bash

# SSH into the machine and run the remaining commands
ssh uxteam@192.168.101.155 <<EOF
# Move the TGZ to the correct directory and navigate to that directory
mv primate.tar.gz primate
cd primate

# Stop the container for the server and delete it
./remove-primate.sh

# Untar the TGZ Docker image
docker image load -i primate.tar.gz

# Start the process for the server again
docker compose up -d --build --force-recreate primate-bot 

# Delete the tarball
rm primate.tar.gz

# Exit the SSH session
exit
EOF
