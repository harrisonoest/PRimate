#!/bin/bash

# Build the Docker image
docker build -t primate .

# Compress the Docker image into a TGZ
docker save -o primate.tar.gz primate:latest

# Put the file on the AWS server
scp primate.tar.gz uxteam@192.168.101.155:/home/uxteam

# Put the script to remove the existing container on the AWS server
scp remove-primate.sh uxteam@192.168.101.155:/home/uxteam/primate

# Deploy the image to the UXTeam-Vault server
./deploy.sh

# Clean up
rm primate.tar.gz
