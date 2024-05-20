import {
  BrowserContext,
  Page,
  Response,
  ConsoleMessage,
} from "playwright-core";
import invariant from "tiny-invariant";
import { nanoid } from "nanoid";
import { logger } from "./utils/logger";
import readline from "readline";
import superstruct from "superstruct";
import discordInPageLogin from "./playwright-utils/browser-eval/discord-inpage-login";
import * as amqp from "amqp-connection-manager";
import path from "path";
import { getLogsDir } from "./utils/logs-dir";
import { getUserAgent } from "./playwright-utils/browser-eval/agent";
import fetch from "node-fetch";
import {
  BannedPromptError,
  InvalidParametersError,
  OutOfCreditsError,
  SolveCaptchaError,
} from "./utils/errors";
import ss from "superstruct";
import { proxyAgent } from "./consumer";

export async function verifyEmailAction(
  page: Page,
  mqConnection: amqp.AmqpConnectionManager
) {
  const queueName = "email-verification";
  const channelWrapper = await mqConnection.createChannel({
    json: true,
    setup: (channel: amqp.Channel) => {
      return channel.assertQueue(queueName);
    },
  });
  return new Promise<{ verified: boolean }>((resolve, reject) => {
    logger.debug('Waiting for "email-verification" message from rabbitmq...');
    channelWrapper.consume(queueName, (message) => {
      if (!message) {
        logger.error(`No message found in queue: ${queueName}`);
        return;
      }

      const discordConfirmUrl = message.content.toString();

      // navigate to new page
      page
        .goto(discordConfirmUrl)
        .then((newPage) => {
          page
            .isVisible('text="IP authorization link has expired"')
            .then(() => {
              reject(new Error("IP authorization link has expired"));
            });

          if (newPage?.status() === 200) {
            resolve({ verified: true });
          }
        })
        .catch(() => {
          reject(new Error("Failed to verify email!"));
        })
        .finally(() => {
          channelWrapper.ack(message);
        });
    });
  });
}

export async function sendCaptchaChallengeAction(
  page: Page,
  sitekey: string
): Promise<{ status: "waiting"; captchaId: string }> {
  // send to 2captcha
  logger.debug("Sending captcha challenge to 2captcha...");
  try {
    const captchaResponse = await fetch(
      `https://2captcha.com/in.php?key=${
        process.env.TWO_CAPTCHA_API_KEY
      }&method=hcaptcha&sitekey=${sitekey}&pageurl=${page.url()}`
    );

    logger.debug(`Got response from 2captcha:`, captchaResponse);

    const captchaResponseText = await captchaResponse.text();
    const [status, captchaId] = captchaResponseText.split("|");

    logger.debug(`Initial captcha response: ${captchaResponseText}`);
    return { status: "waiting", captchaId };
  } catch (e) {
    logger.error("Failed to send captcha challenge to 2captcha", e);
    throw e;
  }
}

export async function sendCaptcha(
  page: Page,
  solution: string,
  discordUsername: string,
  discordPassword: string
): Promise<{ status: "verifyEmail" | "success" }> {
  try {
    const loginResults = await page.evaluate(discordInPageLogin, {
      solution,
      username: discordUsername,
      password: discordPassword,
    });
    logger.debug("Got login results", loginResults);

    // {"code": 50035, "errors": {"login": {"_errors": [{"code": "ACCOUNT_LOGIN_VERIFICATION_EMAIL", "message": "New login location detected, please check your e-mail."}]}}, "message": "Invalid Form Body"}
    //when the error object is like above, we need to get the link from the email and click it

    superstruct.assert(
      loginResults,
      superstruct.type({ code: superstruct.number() }),
      "loginResults is null"
    );
    if (loginResults.code === 50035) {
      return { status: "verifyEmail" };
    }
  } catch (e) {
    logger.error("Failed to send captcha solution", e);
    throw e;
  }

  return { status: "success" };
}

export async function loginAfterEmailVerfificationAction(page: Page) {
  await page.getByRole("button", { name: "Log In" }).click();
}

export async function loginIntoChannel(
  page: Page,
  loginUrl: string,
  username: string,
  password: string,
  xCaptchaKey?: string
): Promise<
  | {
      next:
        | "two-factor"
        | "not-authenticated"
        | "invalidCredentials"
        | "verifyEmail";
    }
  | { next: "captcha"; sitekey: string }
  | { next: "authenticated"; userId: string; token: string }
  | void
> {
  const logHandler = async (msg: ConsoleMessage) => {
    const values = await Promise.all(msg.args().map((arg) => arg.jsonValue()));
    console.log("In page log handler:", ...values);
  };
  page.on("console", logHandler);

  if (!xCaptchaKey) {
    logger.debug("Navigating to login page");
    await page.goto(loginUrl);
  }

  await logger.screenshot(page, "after in login page", null, "login-page-xxx");

  // Updated function

  try {
    const loginResults = await page.evaluate(discordInPageLogin, {
      username,
      password,
      xCaptchaKey,
    });

    logger.debug("Got login response", loginResults);

    if (
      ss.is(loginResults, ss.type({ mfa: ss.boolean() })) &&
      loginResults.mfa === true
    ) {
      return { next: "two-factor" };
    } else if (
      ss.is(
        loginResults,
        ss.type({
          captcha_key: ss.array(ss.literal("captcha-required")),
          captcha_sitekey: ss.string(),
        })
      )
    ) {
      return {
        next: "captcha",
        sitekey: loginResults.captcha_sitekey,
      };
    } else if (
      ss.is(loginResults, ss.type({ user_id: ss.string(), token: ss.string() }))
    ) {
      return {
        next: "authenticated",
        userId: loginResults.user_id,
        token: loginResults.token,
      };
    } else if (
      ss.is(
        loginResults,
        ss.type({
          code: ss.literal(50035),
          errors: ss.type({
            login: ss.type({
              _errors: ss.array(
                ss.type({
                  code: ss.literal("INVALID_LOGIN"),
                })
              ),
            }),
          }),
        })
      )
    ) {
      return { next: "invalidCredentials" };
    } else if (
      ss.is(
        loginResults,
        ss.type({
          code: ss.literal(50035),
          errors: ss.type({
            login: ss.type({
              _errors: ss.array(
                ss.type({
                  code: ss.literal("ACCOUNT_LOGIN_VERIFICATION_EMAIL"),
                })
              ),
            }),
          }),
        })
      )
    ) {
      return { next: "verifyEmail" };
    } else {
      return { next: "not-authenticated" };
    }
    // Handle loginResults here
  } catch (error) {
    console.error("Error in discordInPageLogin:", error);
  } finally {
    // Move the handler removal to the end to ensure all logs are captured
    page.off("console", logHandler);
  }
}

export async function sendPromptUsingWs(
  prompt: string,
  guildId: string,
  threadId: string,
  token: string
) {
  try {
    const payload: {
      type: number;
      application_id: string;
      guild_id: string | undefined;
      channel_id: string;
      session_id: string;
      data: {
        version: string;
        id: string;
        name: string;
        type: number;
        options: any[];
        application_command: {
          id: string;
          application_id: string;
          version: string;
          default_member_permissions: null;
          type: number;
          nsfw: boolean;
          name: "imagine";
          description: "Create images with Midjourney";
          dm_permission: boolean;
          contexts: number[];
          integration_types: number[];
          options: [
            {
              type: number;
              name: "prompt";
              description: string;
              required: boolean;
            }
          ];
        };
        attachments: any[];
      };
    } = {
      type: 2,
      application_id: "936929561302675456", // midjourney bot id
      guild_id: guildId,
      channel_id: threadId,
      session_id: token,
      data: {
        version: "11237876415471554623", // command version?
        id: "938956540159881230", // command id
        name: "imagine",
        type: 1,
        options: [{ type: 3, name: "prompt", value: prompt }],
        application_command: {
          id: "938956540159881230", // command id
          application_id: "936929561302675456", // midjourney bot id
          version: "1237876415471554623", // command version
          default_member_permissions: null,
          type: 1,
          nsfw: false,
          name: "imagine",
          description: "Create images with Midjourney",
          dm_permission: true,
          contexts: [0, 1, 2],
          integration_types: [0],
          options: [
            {
              type: 3,
              name: "prompt",
              description: "The prompt to imagine",
              required: true,
            },
          ],
        },
        attachments: [],
      },
    };
    const headers = {
      "Content-Type": "application/json",
      Authorization: token,
    };
    const response = await fetch(`https://discord.com/api/v9/interactions`, {
      agent: proxyAgent,
      method: "POST",
      body: JSON.stringify(payload),
      headers: headers,
    });

    if (response.status >= 400) {
      const errorDetails = await response.json(); // or response.json() if the error details are in JSON format
      logger.error("WS \u{1F4A6} API error", {
        payload,
        responseStatus: response.status,
        errorDetails,
      });
    }

    logger.info(`WS \u{1F4A6} API response status ${JSON.stringify(response)}`);
    return response.status;
  } catch (error) {
    logger.error("Unexpcted error in WS request:", error);
  }
}
