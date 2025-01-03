# Build stage
FROM node:18-alpine AS builder

# Set the working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application code
COPY . .

# Production stage
FROM node:18-alpine

# Install glab
RUN apk add --no-cache git glab

# Set the working directory
WORKDIR /usr/src/app

# Copy built node modules and application code
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/src ./src
COPY --from=builder /usr/src/app/package.json ./

EXPOSE 3000

# Command to run your bot
CMD ["node", "src/bot.js"]
