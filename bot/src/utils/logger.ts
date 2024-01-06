import winston, { LoggerOptions } from "winston";
import * as Transport from "winston-transport";
import invariant from "tiny-invariant";
import { Logtail } from "@logtail/node";
import { LogtailTransport } from "@logtail/winston";

import dotenvSafe from "dotenv-safe";
import { Page } from "playwright-core";
import { nanoid } from "nanoid";
import { getLogsDir } from "./logs-dir";
import path from "path";
import jsonStringifySafe from "json-stringify-safe";
import dotenv from "dotenv";
import fs from "fs";
import * as ss from "superstruct";

dotenvSafe.config();

// get channel name from proc file
const procInfoContents = fs.readFileSync("./proc/info", "utf8");
const procInfo = dotenv.parse(procInfoContents);

ss.assert(procInfo, ss.type({ INSTANCE_ID: ss.string() }));

invariant(process.env.SERVICE_NAME, "SERVICE_NAME not set");
invariant(process.env.DISCORD_EMAIL, "DISCORD_EMAIL not set");

const prettyFormat = winston.format.combine(
  // winston.format.colorize(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...rest } = info;
    const error = rest.event && rest.event.data;
    if (error instanceof Error) {
      rest.event.data = {
        type: error.constructor.name, // Include the error type
        message: error.message,
        stack: error.stack,
      };
    }
    return `${timestamp} ${level}: ${message} ${jsonStringifySafe(
      rest,
      null,
      2
    )}`;
  })
);

const transportsArray: Transport[] = [];

if (process.env.LOGTAIL_SOURCE_TOKEN) {
  console.log("Logtail source token found, logging to Logtail");
  const logtail = new Logtail(process.env.LOGTAIL_SOURCE_TOKEN, {
    contextObjectCircularRefWarn: false,
  });

  transportsArray.push(new LogtailTransport(logtail));
}

transportsArray.push(new winston.transports.Console({ format: prettyFormat }));
transportsArray.push(
  new winston.transports.File({
    filename: path.join(getLogsDir(), "error.log"),
    level: "error",
    format: prettyFormat,
  })
);
transportsArray.push(
  new winston.transports.File({
    filename: path.join(getLogsDir(), "combined.log"),
    format: prettyFormat,
  })
);

// Discord channel.threads has a lot of info so we remove it
const removeThreadsFormat = winston.format((info, opts) => {
  if (info.channel && info.channel.threads) {
    info.channel = { ...info.channel };
    delete info.channel.threads;
  }
  return info;
});

export const logger = winston.createLogger({
  silent: false,
  level: "debug",
  exitOnError: false,
  format: winston.format.combine(removeThreadsFormat(), winston.format.json()),
  defaultMeta: {
    service: process.env.SERVICE_NAME,
    discord_email: process.env.DISCORD_EMAIL,
    instance: procInfo.INSTANCE_ID,
  },
  transports: transportsArray,
});

declare module "winston" {
  interface Logger {
    screenshot: (
      page: Page,
      message: string,
      e?: unknown,
      prefix?: string
    ) => Promise<void>;
  }
}

logger.screenshot = async function (
  page: Page,
  message: string,
  e?: unknown,
  prefix?: string
) {
  const logsDir = getLogsDir();
  const errorPath = path.join(
    logsDir,
    `${prefix}-${new Date().getTime()}-${nanoid()}.png`
  );
  this.error(`${message}. Saving screenshot to ${errorPath}`, e);

  try {
    await page.screenshot({ path: errorPath });
  } catch (error) {
    this.error("Failed to save the screenshot", error);
  }
};
