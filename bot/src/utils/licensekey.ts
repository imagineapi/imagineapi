import axios, { AxiosResponse } from "axios";
import * as ss from "superstruct";
import fs from "fs";
import process from "process";

import fnv from "fnv-plus";
import dotenv from "dotenv";
import { logger } from "./logger";
import invariant from "tiny-invariant";

// get instance id from proc file (filename is hardcoded in docker-entrypoint.sh)
const procInfoContents = fs.readFileSync("./proc/info", "utf8");
const procInfo = dotenv.parse(procInfoContents);

ss.assert(procInfo, ss.type({ INSTANCE_ID: ss.string() }));

// TODO: remove this static key after we enforce license keys
const STATIC_KEY = "06DE44-9A1B46-753E12-D5CD69-A3C8EA-V3";
const ACCOUNT_ID = "3548c384-7dee-4980-832a-8086126c458b"; // This shouldn't change as it's tied to keygen.sh account

const ErrorData = ss.type({
  response: ss.type({
    data: ss.string(),
  }),
});

let key: string;
if (process.env.LICENSE_KEY) {
  key = process.env.LICENSE_KEY;
} else {
  key = STATIC_KEY;
}

export enum LicenseKeyStatus {
  FINGERPRINT_SCOPE_MISMATCH,
  VALID,
  INVALID,
}

// just redirects to keygen.sh endpoint
const BASE_URL = "https://km.imagineapi.dev";

export async function validateLicenseKey(): Promise<{
  id: string | undefined;
  status: LicenseKeyStatus;
}> {
  try {
    const response: AxiosResponse = await axios.post(
      `${BASE_URL}/v1/accounts/${ACCOUNT_ID}/licenses/actions/validate-key`,
      {
        meta: {
          key,
          scope: {
            fingerprint: procInfo.INSTANCE_ID,
          },
        },
      },
      {
        headers: {
          Authorization: `License ${key}`,
        },
      }
    );

    logger.debug("Validation response:", response.data);

    const licenseId = response.data.data.id;
    if (response.data.meta.code === "FINGERPRINT_SCOPE_MISMATCH") {
      return {
        id: licenseId,
        status: LicenseKeyStatus.FINGERPRINT_SCOPE_MISMATCH,
      };
    } else if (response.data.meta.code === "VALID") {
      return { id: licenseId, status: LicenseKeyStatus.VALID };
    }
  } catch (error) {
    if (ss.is(error, ErrorData)) {
      logger.debug("Error response validating:", error.response.data);
    } else if (ss.is(error, ss.type({ message: ss.string() }))) {
      logger.debug("Error response validating:", error.message);
    } else {
      logger.debug("Error response validating:", error);
    }
  }

  return { id: undefined, status: LicenseKeyStatus.INVALID };
}

function hashString(input: string): string {
  return fnv.hash(input, 32).hex();
}
async function getPublicIpAddress(): Promise<string | false> {
  try {
    const response = await axios.get("http://api.ipify.org");
    return response.data;
  } catch (error) {
    logger.debug("IP error:", error);
    return false;
  }
}

/**
 *
 * @param instanceId
 * @param licenseId Note: it's not the license key
 * @returns
 */
export async function activateMachine(
  instanceId: string,
  licenseId: string
): Promise<void> {
  invariant(process.env.DISCORD_EMAIL, "DISCORD_EMAIL is not set");

  try {
    const response: AxiosResponse = await axios.post(
      `${BASE_URL}/v1/accounts/${ACCOUNT_ID}/machines`,
      {
        data: {
          type: "machines",
          attributes: {
            fingerprint: instanceId,
            ip: await getPublicIpAddress(),
            metadata: {
              [`discord_email_${hashString(process.env.DISCORD_EMAIL)}`]:
                process.env.DISCORD_EMAIL,
            },
          },
          relationships: {
            license: {
              data: {
                type: "licenses",
                id: licenseId,
              },
            },
          },
        },
      },
      {
        headers: {
          Authorization: `License ${key}`,
        },
      }
    );

    logger.debug("Activation response:", response.data);

    // if (response.data.meta.code === "FINGERPRINT_SCOPE_MISMATCH") {
    //   return LicenseKeyStatus.FINGERPRINT_SCOPE_MISMATCH;
    // } else if (response.data.meta.code === "VALID") {
    //   return LicenseKeyStatus.VALID;
    // }
  } catch (error) {
    if (ss.is(error, ErrorData)) {
      logger.debug("Error response activating 1:", error.response.data);
    }
    //  else if (
    //   ss.is(error, ss.type({ message: ss.string() })) &&
    //   error.message
    // ) {
    //   logger.debug("Error response activating 2:", error.message);
    //   console.log(
    //     "%clicensekey.ts line:123 activating 2",
    //     "color: #007acc;",
    //     error.message
    //   );
    // }
    else {
      logger.debug("Error response activating 3:", error);
    }

    throw error;
  }
}
