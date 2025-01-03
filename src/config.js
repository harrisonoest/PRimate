import dotenv from "dotenv";
dotenv.config();

export const BOT_USER_ID = process.env.SLACK_BOT_USER_ID;

export const appConfig = {
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  // Enable all the listeners we need
  ignoreSelf: false, // Important: allow the bot to see its own messages for tracking
  customRoutes: [
    {
      path: "/slack/events",
      method: ["POST"],
      handler: (req, res) => {
        res.writeHead(200);
        res.end();
      },
    },
  ],
};
