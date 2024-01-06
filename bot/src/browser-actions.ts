import { BrowserContext, Page, Response } from "playwright-core";
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

export async function clickCaptchaAndFindSiteKey(page: Page) {
  const hCaptchaIframe = await page.waitForSelector("iframe[src*='hcaptcha']");
  const hCaptchaIframeElement = await hCaptchaIframe.asElement();
  hCaptchaIframeElement?.scrollIntoViewIfNeeded();
  const src = await hCaptchaIframe.getAttribute("src");
  // get sitekey from iframe src
  const sitekey = src?.split("sitekey=")[1].split("&")[0];

  if (!sitekey) {
    throw new Error("Failed to find captcha sitekey");
  }

  // TODO: determine if this is needed
  // click hcaptcha checkbox
  await page
    .frameLocator(
      'iframe[title="Widget containing checkbox for hCaptcha security challenge"]'
    )
    .getByRole("checkbox", {
      name: "hCaptcha checkbox. Select in order to trigger the challenge, or to bypass it if you have an accessibility cookie.",
    })
    .click();

  return { sitekey };
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
      discordUsername,
      discordPassword,
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
  password: string
): Promise<
  | { next: "captcha" }
  | { next: "authenticated"; userId?: string; token?: string }
  | void
> {
  await page.goto(loginUrl);

  // We have this factory because we need to be able to remove the response handler
  // when we are done with it. If we don't, caching is disabled for the whole
  // browser context and every page
  function createUserIdPromise() {
    let handler: (response: Response) => Promise<void> = async () => {};

    const promise = new Promise<{ userId: string; token: string } | undefined>(
      (resolve) => {
        handler = async (response) => {
          if (
            response.url().includes("https://discord.com/api/v9/auth/login")
          ) {
            const jsonResponse = await response.json();
            console.log(
              "%cbrowser-actions.ts line:236 jsonResponse",
              "color: #007acc;",
              jsonResponse?.user_id
            );
            if (
              ss.is(
                jsonResponse,
                ss.type({ user_id: ss.string(), token: ss.string() })
              )
            ) {
              resolve({
                userId: jsonResponse.user_id,
                token: jsonResponse.token,
              });
            }
          }
        };

        // Add the response handler
        page.context().on("response", handler);
      }
    );

    return { promise, handler };
  }

  const { promise: userIdPromise, handler: responseHandler } =
    createUserIdPromise();

  // if page has Welcome back, just log in
  if (await page.isVisible("text=Welcome back!")) {
  } else {
    await page.getByRole("button", { name: "Continue in browser" }).click();
  }
  await page.getByLabel("Email or Phone Number*").fill(username);
  await page.getByLabel("Password*").click();
  await page.getByLabel("Password*").fill(password);
  await page.getByRole("button", { name: "Log In" }).click();

  // wait for 5 seconds for user id to be returned
  const loginInfo = await Promise.race([
    userIdPromise,
    new Promise<undefined>((r) => setTimeout(r, 5000)),
  ]);
  const userId = loginInfo?.userId;
  const token = loginInfo?.token;

  // It's important to remove the response handler, otherwise caching is disabled
  page.context().off("response", responseHandler);

  const agent = await page.evaluate(getUserAgent);
  logger.error(`Browser agent: ${agent}`);

  // kind of a hacky way to see if we're logged in or already or in login page
  try {
    const captchaIframe = await page.waitForSelector(
      "iframe[src*='hcaptcha']",
      { timeout: 1000 }
    );

    if (captchaIframe) {
      return { next: "captcha" };
    }
  } catch (e) {
    return { next: "authenticated", userId, token };
  }

  throw new Error("Failed to login into discord. Page url: " + page.url);
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
        version: "1166847114203123795", // command version?
        id: "938956540159881230", // command id
        name: "imagine",
        type: 1,
        options: [{ type: 3, name: "prompt", value: prompt }],
        application_command: {
          id: "938956540159881230", // command id
          application_id: "936929561302675456", // midjourney bot id
          version: "1166847114203123795", // command version
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
