import { Page, BrowserContext } from "playwright-core";
import { createMachine, assign, sendParent, sendTo, send } from "xstate";
import invariant from "tiny-invariant";
import { sendPromptUsingWs } from "../browser-actions";
import { createBotThread } from "../bot/actions";
import { logger } from "../utils/logger";
import { PatchImage } from "../utils/api";
import { Message as MqMessage } from "amqplib";
import * as amqp from "amqp-connection-manager";
import * as ss from "superstruct";
import { ConnectionPool, proxyAgent } from "../consumer";
import { OutOfCreditsError, SolveCaptchaError } from "../utils/errors";
import { JSDOM } from "jsdom";
import { RawData, WebSocket, MessageEvent as WsMessageEvent } from "ws";
import typia from "typia";
import { match, P } from "ts-pattern";
import { IntentsBitField } from "discord.js";

interface IAttachment {
  url: string;
}

interface IMessageCreateOrUpdate {
  t: "MESSAGE_CREATE" | "MESSAGE_UPDATE";
  d: {
    content: string;
    attachments: IAttachment[];
    guild_id: string;
    channel_id: string;
    id: string;
  };
  op: number;
  s?: number;
}

interface IMessageCreateOrUpdateWithDescription {
  t: "MESSAGE_CREATE" | "MESSAGE_UPDATE";
  d: {
    embeds: { title: string; description: string }[];
    attachments: IAttachment[];
    channel_id: string;
    content: string;
    id: string;
  };
  op: number;
  s?: number;
}

interface IMessageCreateOrUpdateAttached {
  t: "MESSAGE_CREATE" | "MESSAGE_UPDATE";
  d: {
    content: string;
    attachments: IAttachment[];
    message_reference: {
      guild_id: string;
      channel_id: string;
    };
    id: string;
  };
  op: number;
  s?: number;
}

interface IOtherMessageTypes {
  t:
    | "READY"
    | "READY_SUPPLEMENTAL"
    | "SESSION_REPLACE"
    | "INTERACTION_CREATE"
    | "INTERACTION_SUCCESS"
    | "THREAD_MEMBERS_UPDATE"
    | "THREAD_CREATE"
    | "MESSAGE_ACK"
    | null
    | undefined;
  d?: any;
  op: number;
  s?: number;
}

type WsMessage =
  | IMessageCreateOrUpdate
  | IMessageCreateOrUpdateAttached
  | IOtherMessageTypes
  | IMessageCreateOrUpdateWithDescription;

type NewMessage = {
  content: string;
  attachments: { url: string }[];
  guild?: { id: string };
  channel: { id: string; type?: number };
  id: string;
};

export const onWsMessage = (
  sender: (event: GenerateMachineEvent) => void,
  discordUserId: string,
  threadId: string,
  prompt: string,
  rawMessage: WsMessageEvent
) => {
  const sliceLenght = 1000;
  logger.info(`WS \u{1F4A6} WsMessage line:105 [${prompt}]`, {
    messageData: `${rawMessage.data.toString().slice(0, sliceLenght)}${
      rawMessage.data.toString().length > sliceLenght ? "..." : ""
    }`,
  });

  const parsedData = JSON.parse(rawMessage.data.toString());
  const res = typia.validate<WsMessage>(parsedData);

  if (!res.success) {
    logger.warn("No message found in ws message", {
      rawMessage,
      err: res.errors,
    });
    return;
  }
  const message = res.data;

  if (message.op === 10) {
    // heartbeat
    logger.debug("WS Heartbeat", { message });
    ConnectionPool[discordUserId].lastSequence = message.s ?? null;
    return;
  }

  if (message.t !== "MESSAGE_CREATE" && message.t !== "MESSAGE_UPDATE") {
    logger.warn("WS Message not a message create or update, ignoring", {
      message,
    });
    return;
  }

  const channelId =
    "channel_id" in message.d
      ? message.d.channel_id
      : message.d.message_reference.channel_id;

  if (channelId !== threadId) {
    logger.debug(
      `WS Message not in thread, ignoring. Expected ${threadId} but got ${channelId}`,
      `${message.d.content.slice(0, 20)}...`
    );
    return;
  } else {
    logger.debug(
      `WS Message in thread, processing. Expected ${threadId} and got ${channelId}`,
      `${message.d.content.slice(0, 20)}...`
    );
  }

  match(message)
    .with(
      {
        t: "MESSAGE_CREATE",
        d: { embeds: [{ title: P.string, description: P.string }] },
      },
      ({ d }) => {
        if (d.embeds[0].title === "Credits exhausted") {
          sender({
            type: "GLOBAL_ERROR",
            data: { message: `Midjourney credits exhausted` },
          });
        } else {
          sender({
            type: "LOCAL_ERROR",
            data: { message: `Midjourney message: ${d.embeds[0].description}` },
          });
        }
      }
    )
    .with({ t: "MESSAGE_CREATE", d: { guild_id: P.string } }, ({ d }) =>
      sender({
        type: "NEW_MESSAGE",
        data: {
          ...message.d,
          guild: { id: d.guild_id },
          channel: { id: channelId },
        },
      })
    )
    .with(
      { t: "MESSAGE_CREATE", d: { message_reference: { guild_id: P.string } } },
      ({ d }) =>
        sender({
          type: "NEW_MESSAGE",
          data: {
            ...message.d,
            guild: { id: d.message_reference.guild_id },
            channel: { id: channelId },
          },
        })
    )
    .with({ t: "MESSAGE_UPDATE" }, () =>
      sender({
        type: "UPDATED_MESSAGE",
        data: {
          content: message.d.content,
          attachments: message.d.attachments.map((x) => x),
        },
      })
    );
};

export type WsConnectionPool = Record<
  string,
  { ws: WebSocket; poolCount: number }
>;

type Context = {
  retries: number;
  mqConnection: amqp.AmqpConnectionManager;
  page?: Page;
  // wsConnectionPool with discord user id as key (string) and websocket as value
  browserContext: BrowserContext;
  error?: string;
  token: string;
  threadName: string; // exists as a desired thread name (thread may not exist yet)
  threadId?: string; // only exists after thread has been created
  channelName: string;
  authorDiscordId?: string;
  imageId: string;
  mqChannelWrapper: amqp.ChannelWrapper;
  mqMessage: MqMessage;
  prompt: string;
  boundOnWsMessage?: (message: WsMessageEvent) => void;
};

type GenerateMachineSevice = {
  registerBotMessageHandlers: { data: {} };
  sendPrompt: { data: {} };
  errorOnJob: { data: {} };
  createThread: {
    data: {
      threadId: string;
    };
  };
};

type UpdatedMessagePayload = {
  content: string;
  attachments: { url: string }[];
};

type GenerateMachineGuard = {
  type: "";
};

type GenerateMachineEvent =
  | { type: "NEW_MESSAGE"; data: NewMessage }
  | { type: "UPDATED_MESSAGE"; data: UpdatedMessagePayload }
  | { type: "MESSAGE_DELETED" }
  | { type: "GLOBAL_ERROR"; data: { message: string } }
  | { type: "LOCAL_ERROR"; data: { message: string } };
// | { type: "REJECT_JOB"; error: string };

const POSTFIX_REGEX =
  "(?:fast, stealth|fast , stealth |turbo, stealth|turbo , stealth |fast|fast |turbo|turbo )";
// message from browser DOM seems to have extra space which is why we do that funky extra space thing after "fast", "stealth" and "turbo"

const PROGRESS_REGEX = new RegExp(
  `\\((\\d{1,3})%\\) \\(${POSTFIX_REGEX}\\)$|\\((Stopped|Stopped )\\)$`
);
const ENDS_WITH_REGEX = new RegExp(`\\(${POSTFIX_REGEX}\\)`);

export const generateImageMachine =
  /** @xstate-layout N4IgpgJg5mDOIC5QFs6wIYwMpgI4FcwA7AYzAGIBxAGQHkAhAQWoH0BRAJQ9o4G0AGALqJQABwD2sAJYAXKeKIiQAD0QAWAEwAaEAE9EADgCMAOgCs-SwGYAnFbNGr-DWYMBfNztSwM2PIVIwExIAJzB0GTAAFQALMPQIcggFIKkiADdxAGsg718wHAJiMmD4yNj4iAQ0zJII+SIBQSalCWk5BSVVBA0ANjMTXv4jMzVe8YB2fjMrNR19BCMJidMzXrUrY3H+Kw0jDy80TAL-YqDQ8PK48MSwEJDxEJNRABsIgDNH5BM848KAkoXCLRa4JaoZcR1DqNIQtJAgNqyBpdRB9AZDEZjSbTWbzVE2AZTDQ2PoGXoTDRqfj9A4gX5+IqBUqXEGVch3B5PV4fL4-I4MgHnMqsm7g2r1BRNXhGYTwxHQlE9fqDYajcbknFzPSo5wmFyWMwrCY2XoaCZqMy0+knRklGSgiAAYWFiWSRFSEJyfJ8f1OTPtlWdLKqNUhEphzSErUkSM68O6Nn4NnMBlcM2pBiTOzxi0zBhMxv4mfsFIMGwmVv5NsFJgDNyDwNu90ezzeMk+IW+1v+Z1rDobkRDEKhDSlUblMYV8cQieTadTTl6mcTVhzaiMahMBOJthG9jJZcrPoFvdgxAgAAUHshRDIkikTKGvd2-SUz0RL9fb2Kw9Cx7KxEnZFp0WDZNyLMwbBGSwNEXIwcyWHYC34c0dimbYkyPfIeyZd9P3EG87w5FtuXbXkX1tII8KvAjv1DEdJVhcdAPaYDQG6DdZhMCCoIsZw4JzQ1+EGNYiyMPY82mLDfUokxqK-Ijmy5NsOy7KscLfc8aMIn8GIjaUAIRIC43YxBOPA1NeJggTtQQXojHzEZ7OmQtljNaST1wrSFPIAA5NgAHUWAAWTYLAsEYSg2DhFjY0UEDzO4yzoP46l4NshzxJMYx1xNGZlnsXoPOrU9vNou9-KC0Lwsi6KZWjViTJUMywKSyCUtgtKcxWUwhiggwyRmKwrF6Gxio0oJRAUnAiAqwKQrCiKopiozGvi0yenEjQCzUGw9omTNxlghCVgGfgqSmA7RlmclxtfSbpuIOaqsW2qDIauLFT2DRtvNPabAO6lTVXDKjBGQYXEcGwyWpBw7tkqbypm56Fpq5aNEM+U2Oazafp2-7AaOkGFgPbLxOG01IOXS1PDpdT7ueR7ZvIABVC8ABFGCiNh2dRpbouY1bPpA77ft2-bDuBhDhoGMkliMdYxPsMbaYomtEcI5HWY5rmeb5t76onNbFQVgaTCscTdsJ00NAMHNoYmc2NjLMY1GWaYitV+mEaZu82c57neeq-neAxj6pw2hXhuyt3TQG6HZgBhCLV6biAbLIxzottQDArL3jxK3CZHQEJB21gO9eDt7Baxprult8YCwmWYFaTXKLWT40UwMPphuMWw88OAuJrk4vS8gcvdaD17lsN2KI5xyk1mykbLBGQ09oMYmzIK8wqSXKkt8pJd4ZrWAx7L-2p-19HMeM9bF7JVOCvXPr27MBCl2E2CRgc00UN2jTIe2EGbnxLmXSqN8BZ32NiLJ+TcW5vyMDYDuGVTTJmbgrE0UNpjnVPqeC+E9IFV1njA4WG1KTmm4hYLe-dhjaAyhSKw3EqQbDMJDdYntgEyTPoQxIxCZ7RTDkbchj9G4v1big5BqCFgOSQr0KwEwhiw1zmoNQ+CmRpBolAMIPg-LzRIdA8O2Nugt3zFMJw641HGiUVqWRNCtz9zTDnYkKtuGeRKFoh4Oi0D6JemjOqZCF6mPXOYnY50NxuwBusBCsFU6KIcIaJcBgAauA0Z4og2jdGwEnoHKBK1a4P1MRoSw2VIK5TLGYIS29QLDEGGDUaqZjTGH2PnEBskADu6AkRECgAAMUeI6WiLwwDQnvO6R8npcjexrF0np-TBnDNGQ0XS4Z-zGLrogWwhoCz9EPsSSkyCEJDQLMYdh6wSQWHsukoIcy5C9IGSEIZN4RljOIspHknZvTtNmd0+5CynlLOhKsv8TEgkmK2QSR2SjRhFgOblZOVJza2zUSNVxoSbkmDuWkAFzzXjLIUOQQxLB2ZsGoGwQOBT76KkUVxAa6xc5KNgrY6WdhzAHScOwgkajDxtJ4b2F4YYXhsCUuMj0mRnwzIFUKkVnIQWjjBRsop6gSmmBKWaHY-RoYoRzANTciiUEbA3KMUYmLBV1GFaK95rZPlqWHgzc16BLVyvomsxVIjgkqrqeqixWrMwTG6gorcmDILDE4eMDwtMiDiAgHAJQaszhKsVAAWl6DmVN3FLBJiSbtU0G5MVAiuJUJNIFNAnRzoMfoWr2EOGVpiusCQByQBLRtSCyZdgtJScsAkMwTpTBYWJMsmwUEaExfJcqLacZgwBmTSh503aUhNCdMsepZyUk2BuY0QC6b2p9kjJ6k6OJy3NsNWYI1s5TDtow3Ul0HK7RSRqdwfKPFUT4Ye1EVMnZKLbjnA6ucEI92TOdFCyDm7QxNE+9xhcMlZLQO+hAuwNjZUTJBNYUwHZXvsUhakUSXC92Gpi7FDzFkvIJQ-QpNKjSrsmOsBw6Dk4Em4hbWwJJcroUxe8NIUhYAxGbR6iFCBNDUj1M4X1VMdUZUAUxzEjhXBDA2JiqAgqABGTrZWPHg0sCkJg1EzDOeaCwfQ1ylImKJIdjgOVSWfdBoIjrnUaf45swTh9HFUksP0MkKwcyry3CacYbtzRqI3J7DwQA */
  createMachine(
    {
      id: "messageSequence",
      initial: "createThread",
      predictableActionArguments: true,
      tsTypes: {} as import("./generate-image-machine.typegen").Typegen0,
      schema: {
        context: {} as Context,
        events: {} as GenerateMachineEvent,
        services: {} as GenerateMachineSevice,
        guards: {} as GenerateMachineGuard,
      },
      on: {
        LOCAL_ERROR: "localError",
        GLOBAL_ERROR: "globalError",
      },
      states: {
        createThread: {
          invoke: {
            src: "createThread",
            onDone: {
              target: "threadCreated",
              actions: [
                // this works but current machine doesn't stop execution
                // sendParent({
                //   type: "GO_TO_ERROR",
                //   data: { message: "testing this structure" },
                // }),
                assign({
                  threadId: (context, event) => event.data.threadId,
                  page: (context, event) => event.data.page,
                  boundOnWsMessage: (context, event) =>
                    event.data.boundOnWsMessage,
                }),
                (context, event) => {
                  invariant(
                    context.authorDiscordId,
                    "authorDiscordId must exist"
                  );

                  logger.info(`WS \u{1F4A6} Pool keys`, {
                    pool: Object.keys(ConnectionPool),
                  });

                  // Check if there's a valid threadId and newPoolCount

                  if (event.data.websocketInfo.created) {
                    logger.info(
                      `WS \u{1F4A6} New websocket connection. Pool count: 1`,
                      {
                        pool: Object.keys(ConnectionPool),
                      }
                    );

                    ConnectionPool[context.authorDiscordId] = {
                      connection: event.data.websocketInfo.ws,
                      count: 1,
                      lastSequence: null,
                    };
                  } else {
                    logger.info(
                      `WS \u{1F4A6} Using exsiting websocket connection. Pool count: ${
                        ConnectionPool[context.authorDiscordId]?.count
                      }`
                    );
                    // increment poolCount:
                    ConnectionPool[context.authorDiscordId].count += 1;
                  }
                },
              ],
            },
            onError: [
              {
                cond: "isInvariantError",
                target: "globalError",
              },
              {
                target: "localError",
                actions: [
                  assign({
                    error: (context, event) => event.data.message,
                  }),
                  (context, event) => {
                    logger.error(`Error creating thread:`, {
                      event,
                    });
                  },
                ],
              },
            ],
          },
        },
        threadCreated: {
          invoke: {
            src: "registerBotMessageHandlers",
            onDone: "sendPrompt",
            onError: [
              {
                // if bot handlers aren't registered, this is serious ... go to global error
                target: "globalError",
                actions: [
                  assign({
                    error: (context, event) => event.data.message,
                  }),
                  (context, event) => {
                    logger.error(`Error registering bot message handlers:`, {
                      event,
                    });
                  },
                ],
              },
            ],
          },
        },
        sendPrompt: {
          invoke: {
            src: "sendPrompt",
            onDone: "promptSent",
            onError: [
              {
                cond: "isGlobalError",
                target: "globalError",
              },
              {
                target: "localError",
                actions: [
                  (context, event) => {
                    logger.debug(`Error sending prompt:`, { event });
                  },
                ],
              },
            ],
          },
          on: {
            NEW_MESSAGE: [
              {
                target: "started",
                actions: (context, event) => {
                  logger.debug(`New message on sendPrompt:`, {
                    event,
                  });
                },
                cond: "isWaitingToStart",
              },
              {
                target: "localError",
                actions: [
                  (context, event) => {
                    logger.error(`Unhandled new message on sendPrompt:`, {
                      event,
                    });
                  },
                  assign({
                    error: (context, event) => event.data.content,
                  }),
                ],
              },
            ],
          },
        },
        promptSent: {
          on: {
            NEW_MESSAGE: [
              {
                target: "started",
                cond: "isWaitingToStart",
              },
              {
                target: "waitingForCompletion",
                cond: "isComplete",
              },
              {
                target: "localError",
                actions: [
                  (context, event) => {
                    logger.error(`Unhandled new message on promptSent:`, {
                      event,
                    });
                  },
                  assign({
                    error: (context, event) => event.data.content,
                  }),
                ],
              },
            ],
            UPDATED_MESSAGE: [
              {
                target: "inProgress",
                actions: ["updateProgress"],
                cond: "isInProgress",
              },
              {
                target: "promptSent",
                cond: "isWaitingToStart",
              },
              {
                target: "localError",
                actions: [
                  (context, event) => {
                    logger.error(`Unhandled updated message on promptSent:`, {
                      event,
                    });
                  },
                  assign({
                    error: (context, event) => event.data.content,
                  }),
                ],
              },
            ],
          },
          after: {
            // timeout after 1.5 minutes
            [1.5 * 60 * 1000]: {
              target: "localError",
              actions: [
                assign({
                  error: () => "Timeout after prompt was sent",
                }),
                (context) => {
                  logger.info(
                    `Timeout after prompt was sent [${context.prompt}]`
                  );
                },
              ],
            },
          },
        },
        started: {
          on: {
            UPDATED_MESSAGE: [
              {
                target: "inProgress",
                actions: ["updateProgress"],
                cond: "isInProgress",
              },
              {
                target: "started",
                cond: "isWaitingToStart",
              },
              {
                target: "localError",
                actions: [
                  (context, event) => {
                    logger.error(`Unhandled updated message on started:`, {
                      event,
                    });
                  },
                  assign({
                    error: (context, event) => event.data.content,
                  }),
                ],
              },
            ],
            NEW_MESSAGE: [
              {
                target: "waitingForCompletion",
                // actions: ["setFinalResult"],
                cond: "isComplete",
              },
              {
                target: "started",
                cond: "isWaitingToStart",
              },
              {
                target: "localError",
                actions: [
                  (context, event) => {
                    logger.warn(`Soft reject job:`, { event });
                  },
                  assign({
                    error: (context, event) => event.data.content,
                  }),
                ],
              },
            ],
          },
          after: {
            // timeout after 3 minutes
            [3 * 60 * 1000]: {
              target: "localError",
              actions: [
                assign({
                  error: () => "Timeout while waiting to start",
                }),
                (context) => {
                  logger.info(
                    `Timeout while waiting to start [${context.prompt}]`
                  );
                },
              ],
            },
          },
        },

        inProgress: {
          on: {
            NEW_MESSAGE: [
              {
                target: "waitingForCompletion",
                // actions: ["setFinalResult"],
                cond: "isComplete",
              },
              {
                target: "localError",
                actions: [
                  (context, event) => {
                    logger.error(`Unhandled new message on inProgress:`, {
                      event,
                    });
                  },
                  assign({
                    error: (context, event) => event.data.content,
                  }),
                ],
              },
            ],
            UPDATED_MESSAGE: [
              {
                actions: ["updateUpdatedMessage"],
              },
            ],
          },
          after: {
            // timeout after 3 minutes
            [3 * 60 * 1000]: {
              target: "localError",
              actions: [
                assign({
                  error: () => "Timeout while waiting for completion",
                }),
                (context) => {
                  logger.info(
                    `Timeout while waiting for completion [${context.prompt}]`
                  );
                },
              ],
            },
          },
        },

        waitingForCompletion: {
          invoke: {
            src: "sendResultsToAPI",
            onDone: {
              target: "finished",
            },
            onError: {
              target: "localError",
              actions: [
                assign({ error: () => "Image not sent to API" }),
                (context, event) => {
                  logger.error("Error sending image to API", { event });
                },
              ],
            },
          },
          on: {
            MESSAGE_DELETED: [
              {
                actions: () => {
                  logger.debug("Message deleted in waiting for completeion");
                },
              },
            ],
          },

          // on: {
          // MESSAGE_DELETED: [
          // {
          // target: "finished",
          // // TODO: maybe we check here to ensure that the message deleted matched the same conents as
          // // the message which stopped getting updated waitingForProgress.UPDATED_MESSAGE
          // cond: "isSentToApi",
          // },
          // {
          // target: "localError",
          // actions: assign({ error: () => "Image not sent to API" }),
          // },
          // ],
          // },
        },

        finished: {
          entry: [
            (context, event) => {
              // ack mq message
              context.mqChannelWrapper.ack(context.mqMessage);
            },
            "unregisterBotMessageHandlers",
          ],
          type: "final",
        },
        finishedWithError: {
          entry: [
            (context, event) => {
              // nack message
              logger.debug("Rejecting job with error ", context.error);
              context.mqChannelWrapper.nack(context.mqMessage, false, false);
            },
            "unregisterBotMessageHandlers",
          ],
          type: "final",
        },

        // This is needed because if we fire a sendParent() from another non-final state,
        // the parent will receive the message but this child machine will still run
        // that's because we're launching it with spawn() and not invoke from `bot/consumer.ts`
        globalError: {
          type: "final",
          // Note: `exit` actions are not run on a "final" state but `entry` actions are fine
          entry: [
            sendParent((context, event) => {
              let message =
                "System error came from an image generation. Please check your Midjourney account.";

              if (
                ss.is(
                  event,
                  ss.type({ data: ss.type({ message: ss.string() }) })
                )
              ) {
                message = event.data.message;
              }
              return {
                type: "GO_TO_ERROR",
                data: message,
              };
            }),
            (context, event) => {
              logger.error("Global error", { event });
            },
            "unregisterBotMessageHandlers",
          ],
        },
        localError: {
          invoke: {
            src: "errorOnJob",
            onDone: {
              target: "finishedWithError",
              actions: [
                (context, event) => {
                  logger.info("Image failure sent successfully to API", {
                    event,
                  });
                },
              ],
            },
            onError: {
              target: "finishedWithError",
              actions: [
                (context, event) => {
                  logger.error("Error on job", { event });
                },
              ],
            },
          },
          // can't use final here because we can't have an invoked actor with final
          // type: "final",
        },
      },
    },
    {
      guards: {
        isInvariantError: (context, event) => {
          // super lame that invariant doesn't have custom error type
          if (
            ss.is(event, ss.type({ data: ss.type({ message: ss.string() }) }))
          ) {
            if (event.data.message.startsWith("Invariant failed")) {
              return true;
            }
          }

          return false;
        },
        isGlobalError: (context, event) => {
          if (
            event.data instanceof OutOfCreditsError ||
            event.data instanceof SolveCaptchaError // TODO: remove this and make it a local error when we auto solve captcha
          ) {
            return true;
          }

          return false;
        },
        isWaitingToStart: (context, event) => {
          logger.debug(
            `Testing condition in NEW_MESSAGE event [${context.prompt}]`,
            {
              event,
            }
          );
          return event.data.content.endsWith("(Waiting to start)");
        },
        isInProgress: (context, event) => {
          // event.message matches the regex (0-100%) (fast, stealth) or (0-100%) (fast)
          const matched = event.data.content.match(PROGRESS_REGEX);

          logger.info(
            `Generated image progress [${context.prompt}]: ${
              matched?.[1] ?? "unknown"
            }`
          );

          return matched !== null;
        },
        isComplete: (context, event) => {
          // first attachment url
          const imageUrl = event.data.attachments.at(0)?.url;

          if (!imageUrl) {
            logger.error(`No image url found in message:`, {
              message: event.data,
            });
          }

          return !!event.data.content.match(ENDS_WITH_REGEX);
        },
        // isSentToApi: (context, event) => {
        //   return context.finalResultSentToApi;
        // },
      },
      actions: {
        updateProgress: (context, event) => {
          const matched = event.data.content.match(PROGRESS_REGEX);
          if (matched?.[1]) {
            PatchImage(context.imageId, {
              progress: matched[1],
              discord_image_url: event.data.attachments.at(0)?.url,
              status: "in-progress",
            }).catch((err) => {
              logger.warn("Error updating image", { err });
            });
          }
        },
        updateUpdatedMessage: (context, event) => {
          const match = event.data.content.match(PROGRESS_REGEX);
          logger.info(
            `Generated image progress [${context.prompt}]: ${
              match?.[1] ?? "unknown"
            }`
          );
          if (match?.[1]) {
            PatchImage(context.imageId, {
              progress: match[1],
              status: "in-progress",
              discord_image_url: event.data.attachments.at(0)?.url,
            }).catch((err) => {
              logger.error("Error updating image", { err });
            });
          }
        },
        unregisterBotMessageHandlers: (context, event) => {
          try {
            invariant(context.boundOnWsMessage, "boundOnWsMessage is null");
            invariant(context.authorDiscordId, "authorDiscordId is null");

            logger.debug(`Closing page [${context.prompt}]`);
            context.page?.close();
            const ws = ConnectionPool[context.authorDiscordId].connection;

            // reduce connection pool count
            ConnectionPool[context.authorDiscordId].count -= 1;
            console.log(
              "%cgenerate-image-machine.ts line:809 ConnectionPool",
              "color: #007acc;",
              ConnectionPool
            );
            if (ConnectionPool[context.authorDiscordId].count === 0) {
              // close connection if no more references to it
              ConnectionPool[context.authorDiscordId].connection.close();
              delete ConnectionPool[context.authorDiscordId];
            }
            logger.debug(`Deregistering "message" handler [${context.prompt}]`);
            ws.removeEventListener("message", context.boundOnWsMessage);
          } catch (err) {
            logger.error("Error unregistering bot message handlers", { err });
          }
        },
      },
      services: {
        sendResultsToAPI: async (context, event) => {
          logger.debug(`Sending image to  API [${context.prompt}]`);
          const imageUrl = event.data.attachments.at(0)?.url;

          if (!imageUrl) {
            logger.error(`No image url found in message:`, {
              message: event.data,
            });
          }

          // TODO: make state machine fail if this fails. This can't be here since `cond` must have pure function
          PatchImage(context.imageId, {
            discord_image_url: imageUrl,
            progress: null,
            status: "completed",
            discord_account_id: context.authorDiscordId,
            discord_channel_id: event.data.channel.id, // this is actually the thread id.. I guess threads are channels too just nested?!
            discord_server_id:
              event.data.guild?.id ?? process.env.DISCORD_SERVER_ID,
            discord_message_id: event.data.id,
          })
            .then((response) => {
              logger.info(`Image url updated [${context.prompt}]:`, {
                url: imageUrl,
              });
            })
            .catch((error) => {
              logger.error(`Error updating image url:`, {
                error,
                url: imageUrl,
              });
            });
        },
        createThread: (context, event) => async (send) => {
          // create new thread we use internal image id so
          // Midjourney cannot see our image ID and definitely associate an image
          // with ImagineAPI. This is a protection thing.
          //

          invariant(process.env.DISCORD_SERVER_ID, "DISCORD_SERVER_ID not set");

          logger.info("In createThread service");
          const { threadId, channelId } = await createBotThread(
            context.token,
            process.env.DISCORD_SERVER_ID,
            context.channelName,
            context.threadName,
            context.prompt
          );

          const newPage = await context.browserContext.newPage();

          // WS:
          // lifecycle: open -> message (READY) -> message (READY_SUPPLEMENTAL) -> message (SESSION_REPLACE) -> message (INTERACTION_CREATE) -> message (INTERACTION_SUCCESS) -> message (THREAD_MEMBERS_UPDATE) -> message (THREAD_CREATE) -> message (MESSAGE_CREATE) -> message (MESSAGE_ACK) -> message (MESSAGE_UPDATE) -> message (MESSAGE_UPDATE) -> message (MESSAGE_UPDATE) -> message (MESSAGE_UPDATE) -> message (MESSAGE_UPDATE) -> message (MESSAGE_UPDATE) -> message (MESSAGE_UPDATE) -> message (THREAD_MEMBERS_UPDATE) -> message (MESSAGE_CREATE) -> WS closed

          // this starts the connection to discord websocket

          invariant(context.authorDiscordId, "authorDiscordId is null");

          let ws: WebSocket;
          let wsCreated = false;
          logger.info("Loooking for existing connection in pool", {
            authorDiscordId: context.authorDiscordId,
            pool: Object.keys(ConnectionPool),
          });
          if (ConnectionPool[context.authorDiscordId]) {
            // use existing connection from pool
            // IMPORTANT: don't modify context here
            ws = ConnectionPool[context.authorDiscordId].connection;
            logger.debug("Connection pool found");
          } else {
            // IMPORTANT: don't modify context here
            ws = new WebSocket("wss://gateway.discord.gg/?encoding=json&v=9", {
              agent: proxyAgent,
            });
            wsCreated = true;
            logger.debug("Connection pool not found");
          }

          if (ws.readyState === WebSocket.OPEN) {
            // in case the connection is already open
            logger.error("WS \u{1F4A6}: WebSocket connection established");
          } else {
            function wsAuth() {
              logger.info(`WS \u{1F4A6}: authing [${context.prompt}]`);
              ws.send(
                JSON.stringify({
                  op: 2,
                  d: {
                    token: context.token,
                    // not entierly sure what this does. I thought reducing permissions here would lessen the initial "ready" payload but it doesn't seem to
                    capabilities: new IntentsBitField([
                      1, // GatewayIntentBits.Guilds,
                      32, //GatewayIntentBits.GuildWebhooks,
                      512, //GatewayIntentBits.GuildMessages,
                      1024, // GatewayIntentBits.GuildMessageReactions,
                      4096, //GatewayIntentBits.DirectMessages,
                    ]).bitfield,
                    properties: {
                      $os: "MacOS 11",
                      $browser: "chrome",
                      $device: "chrome",
                    },
                  },
                })
              );
            }

            let connectionInterval: NodeJS.Timeout;

            ws.addEventListener("open", function open() {
              logger.info(`WS \u{1F4A6}: open [${context.prompt}]`);
              wsAuth();

              connectionInterval = setInterval(() => {
                invariant(context.authorDiscordId, "authorDiscordId is null");
                logger.debug("WS \u{1F4A6}: sending heartbeat");

                ws.send(
                  JSON.stringify({
                    op: 1,
                    d: ConnectionPool[context.authorDiscordId].lastSequence,
                  })
                );
              }, 4000); // TODO: change this to use heartbeat interval from discord
            });

            ws.addEventListener("close", () => {
              logger.info(`WS \u{1F4A6}: closed`);
              if (connectionInterval !== undefined) {
                logger.debug("WS \u{1F4A6}: clearing heartbeat interval");
                clearInterval(connectionInterval);
              }
              invariant(context.authorDiscordId, "authorDiscordId is null");
              delete ConnectionPool[context.authorDiscordId];
            });
          }

          // auth

          // bind browser message handlers
          return {
            threadId,
            page: newPage,
            websocketInfo: { ws, created: wsCreated },
            boundOnWsMessage: onWsMessage.bind(
              null,
              send,
              context.authorDiscordId,
              threadId,
              context.prompt
            ),
          };
        },
        errorOnJob: async (context, event) => {
          let eventMessage = "";
          const [error, eventObj] = ss.validate(
            event,
            ss.type({ data: ss.type({ message: ss.string() }) })
          );

          if (!error) {
            eventMessage = eventObj.data.message;
          }

          PatchImage(context.imageId, {
            status: "failed",
            error: context.error || eventMessage || "Unspecified error",
          });

          return {};
        },
        sendPrompt: async (context) => {
          invariant(context.threadId, "threadId is null");
          invariant(context.page, "page is undefined");

          logger.debug(`Sending prompt [${context.prompt}]`, {
            prompt: context.prompt,
            url: context.page.url(),
            action: "sendPrompt",
          });
          invariant(process.env.DISCORD_SERVER_ID, "DISCORD_SERVER_ID not set");

          await sendPromptUsingWs(
            context.prompt,
            process.env.DISCORD_SERVER_ID,
            context.threadId,
            context.token
          );
          logger.debug(`Prompt sent: ${context.prompt}`, {
            prompt: context.prompt,
            url: context.page.url(),
            action: "sendPrompt",
          });

          return {};
        },
        registerBotMessageHandlers: async (context) => {
          invariant(context.boundOnWsMessage, "boundOnWsMessage is null");
          invariant(context.authorDiscordId, "authorDiscordId is null");

          logger.debug(
            `Registering messageCreate handler [${context.prompt}}]`
          );
          console.log(
            "%cgenerate-image-machine.ts line:975 ConnectionPool",
            "color: #007acc;",
            ConnectionPool
          );
          const ws = ConnectionPool[context.authorDiscordId].connection;
          logger.debug(
            `Message listner count before new listener ${ws.listenerCount(
              "message"
            )}`
          );

          ws.addEventListener("message", context.boundOnWsMessage);

          logger.debug(
            `Message listner count after new listener ${ws.listenerCount(
              "message"
            )}`
          );

          return {};
        },
      },
    }
  );

export function generateImageMachineFactory(context: Context) {
  return generateImageMachine.withContext(context);
}
