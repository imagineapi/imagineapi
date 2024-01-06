import * as amqp from "amqp-connection-manager";
import dotenvSafe from "dotenv-safe";

import { chromium, Page, Frame } from "playwright-core";
import {
  clickCaptchaAndFindSiteKey,
  loginAfterEmailVerfificationAction,
  loginIntoChannel,
  sendCaptcha,
  sendCaptchaChallengeAction,
  verifyEmailAction,
} from "./browser-actions";
import invariant from "tiny-invariant";
import { logger } from "./utils/logger";
import { actions, assign, createMachine, interpret, send, spawn } from "xstate";
import fs from "fs";
import { Message as MqMessage } from "amqplib";
import * as ss from "superstruct";
import dotenv from "dotenv";
import strictUriEncode from "strict-uri-encode";
import { WebSocket } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

import { generateImageMachineFactory } from "./machines/generate-image-machine";
import {
  LicenseKeyStatus,
  activateMachine,
  validateLicenseKey,
} from "./utils/licensekey";

dotenvSafe.config();

// get channel name from proc file (filename is hardcoded in docker-entrypoint.sh)
const procInfoContents = fs.readFileSync("./proc/info", "utf8");
const procInfo = dotenv.parse(procInfoContents);

const MAX_CONCURRENT_JOBS = parseInt(
  process.env.MAX_CONCURRENT_JOBS || "1",
  10
);

const PROMPT_SEND_DELAY = parseInt(process.env.PROMPT_SEND_DELAY_MS || "2350");

ss.assert(
  procInfo,
  ss.type({ CHANNEL_NAME: ss.string(), INSTANCE_ID: ss.string() })
);

const defaultChannelName = procInfo.CHANNEL_NAME;

const REMOTE_DEBUG_PORT: number = 9111;
const cdpBrowserEndpoint = `http://127.0.0.1:${REMOTE_DEBUG_PORT}`;

type WsConnectionPool = Record<
  string,
  { connection: WebSocket; count: number; lastSequence: number | null }
>;

type LoginMachineContext = {
  captchaId?: string;
  loginRetries: number;
  childMachine?: any;
  authorDiscordUserId?: string;
  token?: string;
  loginPage?: Page;
  globalWsConnectionPool: WsConnectionPool;
};

export type LoginMachineEvent =
  | { type: "GO_TO_LOGIN" }
  | { type: "ENTER_CREDENTIALS" }
  | { type: "AUTHENTICATE" }
  | { type: "VERIFY_EMAIL"; data: { next: string } }
  | { type: "SEND" }
  | { type: "SOLVED" }
  | { type: "RETRY" }
  | { type: "CHECK_AGAIN" }
  | { type: "RECEIVED" }
  | { type: "EMAIL_VERIFIED" }
  | { type: "EMAIL_NOT_VERIFIED" }
  | { type: "CAPTCHA_SOLVED"; data: { solution: string } }
  | {
      type: "GENERATE_IMAGE";
      threadName: string;
      imageId: string;
      mqMessage: MqMessage;
      mqChannelWrapper: amqp.ChannelWrapper;
      prompt: string;
    }
  | {
      type: "GO_TO_ERROR";
      data: { message: string };
    }
  | {
      type: "LICENSE_VALID";
    }
  | {
      type: "LICENSE_INVALID";
      data: string;
    }
  | {
      type: "createOrUpdateConnection";
      data: { discordUserId: string };
    }
  | {
      type: "releaseConnection";
      data: { discordUserId: string };
    };

type LoginMachineService = {
  login: { data: { next: string } | void };
  solveCaptcha: { data: { next: string } | void };
  verifyEmail: { data: { verified: boolean } };
  sendCaptchaChallenge: { data: { status: "waiting"; captchaId: string } };
  checkCaptchaChallenge: { data: { next: string } | void };
  engageCaptchaUIAndFindSiteKey: { data: { sitekey: string } };
  sendCaptchaSolution: { data: { status: string } };
  checkSolution: {
    data:
      | { status: "solved"; solution: string }
      | { status: "waiting"; captchaId: string };
  };
  loginAfterEmailVerfification: { data: {} };
  createNewPage: { data: {} };
  monitorForLogin: { data: {} };
  // checkLicense;
};

logger.debug(`Starting bot with PID: ${process.pid}`);
logger.debug(`Max concurrent jobs set to: ${MAX_CONCURRENT_JOBS}`);
logger.debug(`Delay before a prompts is sent set to: ${PROMPT_SEND_DELAY}`);

let imageGenerationCounter = 0;

type ProxyInfo = { server: string; username?: string; password?: string };
let proxyInfo: Partial<ProxyInfo> | undefined = {};
let hardProxyInfo: ProxyInfo | undefined = undefined;
if (process.env.BOT_PROXY_SERVER) {
  proxyInfo.server = process.env.BOT_PROXY_SERVER;

  hardProxyInfo = proxyInfo as ProxyInfo;
}
if (process.env.BOT_PROXY_USERNAME) {
  proxyInfo.username = encodeURIComponent(process.env.BOT_PROXY_USERNAME);
}
if (process.env.BOT_PROXY_PASSWORD) {
  proxyInfo.password = encodeURIComponent(process.env.BOT_PROXY_PASSWORD);
}

const credentials =
  proxyInfo.username && proxyInfo.password
    ? `${proxyInfo.username}:${proxyInfo.password}@`
    : "";

export const proxyAgent = proxyInfo.server
  ? new HttpsProxyAgent(`${credentials}${proxyInfo.server}`)
  : undefined;

export const ConnectionPool: WsConnectionPool = {};

(async function main() {
  const browser = await chromium.launch({
    headless: true,
    slowMo: 1000,
  });

  logger.info(`Starting bot with proxy server: ${hardProxyInfo?.server}`);
  // Create a new browser context with proxy
  const browserContext = await browser.newContext({
    proxy: hardProxyInfo,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
    viewport: {
      width: 1920,
      height: 1080,
    },
  });

  logger.debug(
    `Browser context created. Context ID: ${(browserContext as any)._guid}`
  );

  // Listen to the 'page' event in the context
  browserContext.on("page", (page) => {
    logger.debug("A new page has been created");
  });

  invariant(process.env.DISCORD_SERVER_ID, "DISCORD_SERVER_ID not set");
  invariant(process.env.RABBITMQ_USER, "RABBITMQ_USER is not defined");
  invariant(process.env.RABBITMQ_PASSWORD, "RABBITMQ_PASSWORD is not defined");

  process.env.INSTANCE_ID = process.env.FLY_APP_NAME || "";

  const username = strictUriEncode(process.env.RABBITMQ_USER);
  const password = strictUriEncode(process.env.RABBITMQ_PASSWORD);

  const connection = await amqp.connect(
    `amqp://${username}:${password}@${process.env.RABBITMQ_HOST}:${process.env.RABBITMQ_PORT}/`
  );

  const queue = "bot_status"; // has to match the queue name in the API
  const botStatusChannelWrapper = connection.createChannel({
    json: true,
    setup: function (channel: amqp.Channel) {
      // `channel` here is a regular amqplib `ConfirmChannel`.
      return channel.assertQueue(queue, {
        durable: true,
        maxLength: 1, // Maximum number of messages in the queue
      });
    },
  });
  logger.debug("Connected to RabbitMQ!");

  type StatusType = "paused" | "unhealthy" | "healthy" | "starting"; // should match wit `bot_status` field in `status` collection in the API

  async function sendBotStatus({
    status,
    message,
    additionalInfoRequired,
  }: {
    status: StatusType;
    message?: string;
    additionalInfoRequired?: string;
  }) {
    logger.debug(`Sending '${status}' report to RabbitMQ!`);

    botStatusChannelWrapper.sendToQueue(queue, {
      status,
      message,
    });
  }

  const uncaughtExceptionHandler: NodeJS.UncaughtExceptionListener = async (
    e
  ) => {
    await logger.error("Fatal error: Uncaught exception", e);

    // this give logtail a chance to flush logs
    setTimeout(() => {
      browser.close();
      process.exit(3);
    }, 2000);

    sendBotStatus({ status: "unhealthy", message: "Uncaught exception" });
  };

  const unexpectedKillHandler: NodeJS.UncaughtExceptionListener = async (e) => {
    await logger.error(
      "Fatal error. Process terminated/interrupted unexpectedly",
      e
    );

    sendBotStatus({ status: "unhealthy", message: "Unexpectedly terminated" });

    // this give logtail a chance to flush logs
    setTimeout(() => {
      browser.close();
      process.exit(2);
    }, 2000);
  };

  // We don't want to exit on uncaught exceptions
  process.on("uncaughtException", uncaughtExceptionHandler);
  // For some reason, unexpectedKillHandler is called twice on Ctrl+C...can't figure out why but at least it saves the screenshot once (one screenshot it cannot save)
  process.on("SIGINT", unexpectedKillHandler);
  process.on("SIGTERM", unexpectedKillHandler);

  type LoginMachineGuard = {
    type: "";
  };

  const DISCORD_LOGIN_URL = "https://discord.com/login";
  const CAPTCHA_TIMEOUT = 2 * 60 * 1000; // 2 minutes
  const CAPTCHA_RECHECK = 5000; // 5 seconds

  // Delay function
  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Create state machine for login process
  // states: login, captcha, emailVerification, loggedIn
  const authMachine = createMachine(
    {
      /** @xstate-layout N4IgpgJg5mDOIC5QEMCuAXAFmAduglgMbIED2OAdDmAO4AKyMAxANoAMAuoqAA6mz4yObiAAeiAExs2FAJwBWAMwBGACwA2AOzy2ADg2LNAGhABPRLKkVdK1SrW7Nm9YoC+rk2iy4CxIRQAbUih8HABlQgAnMFwmCHIwClCAN1IAa0SvbDwiEnxyQODQiOjcBBTSP3ycdg5akT4BIRFxBFlddQo2HWc2VQkJVWUXE3MEZT0JCn7VPuUJRQUXdXdPDGzfPIKgkPComJw4hKScVIyKLJ9c-x3i-bKKqvJalmUuJBBGwWqWxAnlWRydSWZQTdS6RzKXSjCzKeTTPqaBTyAESYaaVYgS45J6UW57UqHMCRSKkSIUHgBEgAMzJAFsLusrrjCrsSgdyqdKlsapx6h8vs0Pq11PJAU5FKpdINFOo2JpFDCEJohhR5JopBJ1boJmxFBJMdjNjcigSDkxiaTyZSafTGd4cTzWXdCZzUriXm8GvxvuRfghdLJlNZZGxwYow85QUrlIZ4bIhhIIZrZFplIamY7-MQeOhCJhkAAZUjICCQI7UE5nTKZ43VCg5vMF4ulyBu7lCF6cb1NH7CxDAzp9foKSXyMWaZRKly6CjKTQ2VSqcfdYaqDMOusFRv5oslssQC0kskUqnoWmRBlG671nfN-dtx48rvvXg+oWgVoQwH9fSBgGTloEgxqCQ56HCoZyvMk4bhsN4FE0YAANJgKYABipCoDgh7xJWFTnNeLKISh6GYdh7Yeny3YCu+fafogiiShQEgLjoKIDOoCyyEq8jgmqKj6PMLhsPOBoeFitbwZQxGoRhWGHpaJ42uedqEU6MmkfJFHPlRr6fLRfr9gg+rBi4SZwvqGhLuoqhKo4igUIxajjpYEjAro8iwcyTp3sgYSkAEyShFAR5WqetqXvacEsr5-mBcF2mdrpPa+sIRkeTIjFipKTgdEu3FmIgUqqPx7GxlKWryGJayblJDbILmu5xUFOAhQAwgAgnQAAqbUABIdQA+mEADyhYAGoAKIACL8m+vaGfRCADLO84TJYdg6GisiKoVy0TBQnEav00hovMgxeVm9awLgEBtQ1TZ+QFGDVBWiT4TWtVEbd92NQWcUveQiXVC+KUfmIDFWFCKpRhqhgFWMsYyI4OgVR0ijSlKl1btJP0PU1z1CKFSlnheV6Sd92G-Y9ANCMDzzJTRC1pUt+oyNDqiwwsSJ2Q5hhSrIsiTn0gyONjdVgHSyD4AE43Evg1JScT1qk6pFNOpL0uy-Liu4vTvJ1NR82pf6gsOeoFmMUierWUqspTJzolwqooZih54ssprMty5ECtK5NACyHUAJKFoNU0AErB2hwczXN+nM-6ijjmq8odGwrkSuOdsSD+2i51CCjOP0KziWp-he9rvu6zyTCByHYcAHIjd14eTVHMdx0bCcm+lugyFnixJuCv5Kpqh2DELiztLMsq6B7Tr4h11LoMSk1S97xKKzXRO4e9XIEerJq7Mvq+ROvWs+9vUn66DTO96zy6pwucqZwq2d7f0mjTPnyeGPMSh55lyPvWJeK814byrtfXEytwoqUiuXUBppT4QMvlvP2esnxJUNnpQUdEIbGRTj0dOb9k7yDtkiOQ+coLLnnKXGq0UnTl3LAAcRGoNbq7DCwjRYcHRu8c8GLQIaGVaCghgiURNodQMYWKzj6NIFQ3RlwKIXv4Zhh42EcPYe3COI0I4CIMizAhVUYyaDDHIRMSgcoAjUKo+s6imAsMmo3duHVuqTUGsHIOTiDGJyMs5eEC5pQ6ExguBGFh9SOXHMMLK4Zlx2IKOohs2BCBpELEQXAN0mCFmDm1ZxYQPF8PGh1HJs1u6CKMSKYCe1hi8WmImDKQsnBCwSZQJJ+YwCpPSYQTJYBsm5PyR44ppTfEPwIWuWcSZpQ2DmFCaUMY2AsWsJMScah87pkxDgUgZZ4AfEQUIip-oAC00i9onK6NIESQxyr92XOuYBX0nTUHoIwMAYN8GtH6HZVMjlbD9EYvZTmrTnRmlwO8oRnylCHSFvMeYOppQKAWaqZOSIhgaHkDYFiwLfItgPOCypfxBjf1uZOHUoY9QqmnLGOcC5JQuzDBMBUwKNJyWwvi-0XzP4-PlFoJw2g1oJmxfjf6AUWpQHZUZDUMhspC14jZESCoeIRkchncEaJOa2A2Qw7y-gbpU2FU9AIgMjGHKMpysYOppiC3aHqQcSIXDAsrj7DBPIJVLXztYXiKp2jWpWmPDoFAX4sQjHoQWQxgVgLPhfTekRoGuvvuDT51Sxj6k6HKRZ0pFjzg0FqiSjy1FH0gG68Zsxv5BK1JMTmgYlQqnhB5Kq3RGLKLFg8xhBb82QGSZ0tJGScA3WLa0NQCY5yDChFoLanNTmIzUFMGyEEMZTy1MCpJNBpYEFagOv4VVZwW0YtIBMaIWK2RqfKKYGd5C0IjJKUEGJW06vrFAIIAAjZAARJrHkiJu5aF6ugqBYuCJwlyFwxi0DIBM8wlyMTOvKdw7ggA */
      id: "authentication",
      initial: "newPage",
      tsTypes: {} as import("./consumer.typegen").Typegen0,
      predictableActionArguments: true,
      schema: {
        context: {} as LoginMachineContext,
        events: {} as LoginMachineEvent,
        services: {} as LoginMachineService,
        guards: {} as LoginMachineGuard,
      },
      states: {
        newPage: {
          entry: [() => sendBotStatus({ status: "starting" })],
          invoke: {
            src: "createNewPage",
            onDone: {
              target: "loginScreen",
              actions: assign({
                loginPage: (_, event) => event.data,
              }),
            },
            onError: {
              actions: [
                send({
                  type: "GO_TO_ERROR",
                  error: "Failed to create login page",
                }),
              ],
            },
          },
        },
        loginScreen: {
          invoke: {
            src: "login",
            onDone: [
              {
                cond: "sawCaptcha",
                target: "captchaLoaded",
              },
              {
                target: "authenticated",
                actions: assign({
                  authorDiscordUserId: (context, event) => event.data.userId,
                  token: (context, event) => event.data.token,
                }),
              },
            ],
            onError: [
              {
                target: "loginScreen",
                cond: "notManyLoginAttempts",
                actions: assign({
                  loginRetries: (context, event) => context.loginRetries + 1,
                }),
              },
              {
                target: "globalError",
              },
            ],
          },
        },
        captchaLoaded: {
          invoke: {
            src: "engageCaptchaUIAndFindSiteKey",
            onDone: {
              target: "siteKeyFound",
            },
            onError: "loginScreen",
          },
        },
        siteKeyFound: {
          invoke: {
            src: "sendCaptchaChallenge",
            onDone: [{ target: "captchaSolving", actions: ["setCaptchaId"] }],
            onError: "loginScreen",
          },
        },
        captchaSolving: {
          invoke: {
            src: "checkSolution",
            onError: { target: "captchaLoaded" },
          },
          on: {
            CAPTCHA_SOLVED: "sendCaptchaSolution",
          },
          after: {
            [CAPTCHA_TIMEOUT]: {
              target: "loginScreen",
            },
          },
        },
        sendCaptchaSolution: {
          invoke: {
            src: "sendCaptchaSolution",
            onDone: {
              target: "emailVerification",
              cond: "sawEmailVerification",
            },
            onError: "captchaLoaded",
          },
        },

        emailVerification: {
          entry: [
            () =>
              sendBotStatus({
                status: "paused",
                message: "Please verify your email",
                additionalInfoRequired: "emailVerificationLink",
              }),
          ],
          invoke: {
            src: "verifyEmail",
            onError: "emailVerification",
          },
          on: {
            EMAIL_VERIFIED: "loginAfterEmailVerfification",
            EMAIL_NOT_VERIFIED: "emailVerification",
          },
        },
        loginAfterEmailVerfification: {
          invoke: {
            src: "loginAfterEmailVerfification",
            onDone: "loginScreen",
            onError: "emailVerification",
          },
        },
        authenticated: {
          invoke: [
            {
              id: "acceptPrompts",
              src: "acceptPrompts",
            },
          ],

          entry: [
            () => sendBotStatus({ status: "healthy" }),
            async (context) => {
              logger.info("Closing login page");
              await context.loginPage?.close();
            },
          ],

          on: {
            GO_TO_ERROR: "globalError",
            GENERATE_IMAGE: [
              {
                target: ".waiting",
                actions: [
                  () => {
                    imageGenerationCounter += 1;
                  },
                  assign({
                    childMachine: (context: LoginMachineContext, event) => {
                      logger.debug("Creating messageSequence child machine");

                      invariant(context.token, "token is null");
                      const child = spawn(
                        generateImageMachineFactory({
                          retries: 0,
                          browserContext: browserContext,
                          threadName: event.threadName,
                          channelName: defaultChannelName,
                          mqConnection: connection,
                          imageId: event.imageId,
                          mqMessage: event.mqMessage,
                          token: context.token,
                          mqChannelWrapper: event.mqChannelWrapper,
                          prompt: event.prompt,
                          authorDiscordId: context.authorDiscordUserId,
                        }),
                        {
                          name: `generateImage-${event.threadName}`,
                        }
                      );

                      child.subscribe((state) => {
                        logger.info(
                          `messageSequence: [${state.context.prompt}] \u2728 ${
                            typeof state.value === "string"
                              ? state.value
                              : Object.entries(state.value)
                                  .map(
                                    ([parentState, childState]) =>
                                      `${parentState}.${childState}`
                                  )
                                  .join(", ")
                          } connection pool counct: ${Object.keys(
                            ConnectionPool
                          ).join(", ")}`
                        );
                      });

                      return child;
                    },
                  }),
                ],
              },
            ],
          },

          initial: "waiting",
          states: {
            checkLicense: {
              on: {
                LICENSE_INVALID: "#authentication.globalError",
                LICENSE_VALID: "#authentication.authenticated",
              },
            },
            waiting: {},
          },
        },
        globalError: {
          entry: [
            "logGlobalError",
            (context, event) => {
              let message: string = "";
              const [error, dataEvent] = ss.validate(
                event,
                ss.type({ data: ss.string() })
              );
              if (!error) {
                message = dataEvent.data;
              } else {
                logger.debug("No error message found in event: ", event);
              }

              return sendBotStatus({
                status: "unhealthy",
                message:
                  message || "Please see the bot logs in Docker container.",
              });
            },
          ],
        },
      },
    },
    {
      actions: {
        logGlobalError: () => {
          logger.error("In global error state");
        },
        setCaptchaId: assign({
          captchaId: (context, event) => event.data.captchaId,
        }),
        // cancelCaptcha2: (context, event) => {},
        // recheckCaptcha: (context, event) => {},
      },
      guards: {
        notManyLoginAttempts: (context, event) => {
          return context.loginRetries < 3;
        },
        sawCaptcha: (context, event) => {
          return event.data?.next === "captcha";
        },
        sawEmailVerification: (context, event) => {
          return event.data?.status === "verifyEmail";
        },
      },
      services: {
        createNewPage: async (context, event) => {
          const page = await browserContext.newPage();
          page.on("close", () => {
            logger.info("Login page got closed");
          });
          return page;
        },
        acceptPrompts: (context, event) => (send) => {
          const queue = "prompts";
          const mqChannelWrapper = connection.createChannel({
            json: true,
            setup: (channel: amqp.Channel) => {
              // don't dispatch a new message to a worker until it has processed and acknowledged the previous one
              channel.prefetch(MAX_CONCURRENT_JOBS);
              return channel.assertQueue(queue, { durable: true });
            },
          });

          const processMessage = async (mqMessage: MqMessage | null) => {
            logger.debug("Connected to RabbitMQ!");
            logger.info(
              `Received new job message: ${JSON.stringify(mqMessage)}`
            );
            invariant(
              process.env.DISCORD_SERVER_ID,
              "DISCORD_SERVER_ID not set"
            );
            invariant(mqMessage, "mqMessage is null");

            // Parse the message
            const { type, prompt, imageId, internalImageId } = JSON.parse(
              mqMessage.content.toString()
            );

            // Execute the function based on the message type
            if (type === "generate image") {
              if (
                imageGenerationCounter === 0 ||
                imageGenerationCounter % 19 === 0
              ) {
                logger.debug("shouldValidateLicense: true");

                validateLicenseKey()
                  .then(({ id, status }) => {
                    if (
                      id &&
                      status === LicenseKeyStatus.FINGERPRINT_SCOPE_MISMATCH
                    ) {
                      logger.debug("Activating...");
                      activateMachine(procInfo.INSTANCE_ID, id)
                        .then((res) => {
                          logger.debug("Activated response", res);
                        })
                        .catch((err) => {
                          logger.warn("Error activating...", err);
                          send({
                            type: "LICENSE_INVALID",
                            data: "Could not activate license",
                          });
                        });
                    } else if (id && status === LicenseKeyStatus.VALID) {
                    } else {
                      // invalid
                      send({
                        type: "LICENSE_INVALID",
                        data: "License is invalid",
                      });
                    }
                  })
                  .catch((err) => {
                    logger.warn("Error validating...", err);
                    send({
                      type: "LICENSE_INVALID",
                      data: "Could not validate license",
                    });
                  });
              } else {
                logger.debug("shouldValidateLicense: false");
              }

              send({
                type: "GENERATE_IMAGE",
                threadName: internalImageId,
                imageId,
                mqMessage,
                mqChannelWrapper,
                prompt,
              });
            }
          };

          let promiseChain = Promise.resolve();

          const processAndAck = (
            channel: amqp.ChannelWrapper,
            message: MqMessage | null
          ) => {
            if (message !== null) {
              return processMessage(message).then(() => {
                // channel.ack(message);
              });
            }
            return Promise.resolve();
          };

          const delay = PROMPT_SEND_DELAY; //ms

          mqChannelWrapper.consume(queue, (message) => {
            promiseChain = promiseChain
              .then(() => {
                return processAndAck(mqChannelWrapper, message);
              })
              .then(() => {
                return new Promise((resolve) => setTimeout(resolve, delay));
              });
          });
        },

        engageCaptchaUIAndFindSiteKey: async (context, event) => {
          invariant(context.loginPage, "loginPage is null");
          return await clickCaptchaAndFindSiteKey(context.loginPage);
        },
        login: async (context, event): Promise<void | { next: string }> => {
          invariant(process.env.DISCORD_EMAIL, "DISCORD_EMAIL not set");
          invariant(process.env.DISCORD_PASSWORD, "DISCORD_PASSWORD not set");
          invariant(context.loginPage, "loginPage is null");

          const nextData = await loginIntoChannel(
            context.loginPage,
            DISCORD_LOGIN_URL,
            process.env.DISCORD_EMAIL,
            process.env.DISCORD_PASSWORD
          );

          await logger.screenshot(
            context.loginPage,
            "loginScreen",
            null,
            "login-screen"
          );

          return nextData;
        },
        checkSolution: (context, event) => (send) => {
          let captchaSolution;

          // set interval to check if captcha is solved
          const interval = setInterval(() => {
            fetch(
              `https://2captcha.com/res.php?key=${process.env.TWO_CAPTCHA_API_KEY}&action=get&id=${context.captchaId}`
            ).then((solvedCaptchaResponse) => {
              logger.debug(
                `Got reponse from 2captcha: ${solvedCaptchaResponse.status}`,
                solvedCaptchaResponse
              );
              solvedCaptchaResponse.text().then((responseText) => {
                const solvedCaptchaResponseText = responseText;
                if (solvedCaptchaResponseText.startsWith("OK")) {
                  const solvedCaptcha = solvedCaptchaResponseText.split("|")[1];
                  logger.debug("Captcha solved:", solvedCaptcha);
                  captchaSolution = solvedCaptcha;
                  send({
                    type: "CAPTCHA_SOLVED",
                    data: { solution: captchaSolution },
                  });
                } else {
                  logger.debug(
                    "Captcha not solved yet. Retrying in 5 seconds..."
                  );
                }
              });
            });
          }, CAPTCHA_RECHECK);

          return () => {
            clearInterval(interval);
          };
        },
        verifyEmail: (context, event) => (send) => {
          invariant(context.loginPage, "loginPage is null");
          verifyEmailAction(context.loginPage, connection)
            .then((emailVerificationData) => {
              send({ type: "EMAIL_VERIFIED" });
            })
            .catch((error) => {
              send({ type: "EMAIL_NOT_VERIFIED" });
            });
        },
        loginAfterEmailVerfification: async (context, event) => {
          invariant(context.loginPage, "loginPage is null");
          await loginAfterEmailVerfificationAction(context.loginPage);

          return {};
        },
        sendCaptchaSolution: async (context, event) => {
          invariant(process.env.DISCORD_EMAIL, "DISCORD_EMAIL not set");
          invariant(process.env.DISCORD_PASSWORD, "DISCORD_PASSWORD not set");
          invariant(context.loginPage, "loginPage is null");

          logger.debug("Sending captcha solution");

          const nextInfo = await sendCaptcha(
            context.loginPage,
            event.data.solution,
            process.env.DISCORD_EMAIL,
            process.env.DISCORD_PASSWORD
          );

          logger.debug("Captcha sent", nextInfo);

          return nextInfo;
        },
        sendCaptchaChallenge: async (context, event) => {
          invariant(context.loginPage, "loginPage is null");
          const sentInfo = await sendCaptchaChallengeAction(
            context.loginPage,
            event.data.sitekey
          );

          return sentInfo;
        },
      },
    }
  );

  const authMachineService = interpret(
    authMachine.withContext({
      loginRetries: 0,
      globalWsConnectionPool: {},
    })
  );
  authMachineService.subscribe((state) => {
    logger.info(
      `${authMachine.id}: \u2728 ${
        typeof state.value === "string"
          ? state.value
          : Object.entries(state.value)
              .map(
                ([parentState, childState]) => `${parentState}.${childState}`
              )
              .join(", ")
      } global pool: ${Object.keys(ConnectionPool)}`
    );
  });

  authMachineService.start();
})();
