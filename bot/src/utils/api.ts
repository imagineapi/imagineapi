import { AxiosInstance } from "./http";
import { logger } from "./logger";

interface ImageFields {
  discord_image_url: string;
  progress: string | null;
  discord_channel_id: string;
  discord_server_id: string;
  discord_message_id: string;
  discord_account_id: string;

  status: "pending" | "in-progress" | "failed" | "completed";

  error: string;
}

// log Axios requests
AxiosInstance.interceptors.request.use((config) => {
  logger.debug("Starting Request", config);
  return config;
});

// log Axios responses
AxiosInstance.interceptors.response.use((response) => {
  // log response data
  if (response.data) {
    logger.debug("Response Data:", response.data);
  }
  return response;
});

export const PatchImage = (id: string, fields: Partial<ImageFields>) =>
  AxiosInstance.patch(
    `/items/images/${id}`,
    {
      ...fields,
      //   url: fields.url,
      //   progress: fields.progress,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.API_TOKEN}`,
      },
    }
  );
