import { defineHook } from "@directus/extensions-sdk";
import * as amqp from "amqp-connection-manager";
import { assert, enums, object, optional, partial, string } from "superstruct";
import * as ss from "superstruct";
import { nanoid } from "nanoid";
import { Image, PreCalculatedFieldsImage } from "./shared";
import axios from "axios";
// @ts-ignore .. this comes built into Directus
import sharp from "sharp";
import { Readable } from "stream";
import invariant from "tiny-invariant";
import strictUriEncode from "strict-uri-encode";
import { createError } from "@directus/errors";
import { EventContext } from "@directus/shared/dist/esm/types";

// Add this function to download and split the image
async function downloadAndSplitImage(imageUrl: string) {
  const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
  const inputImage = sharp(Buffer.from(response.data));
  const imageType = response.headers["content-type"]; // Get the image MIME type

  const { width, height } = await inputImage.metadata();
  if (!width || !height) {
    throw new Error("Could not get image metadata");
  }

  const halfWidth = Math.round(width / 2);
  const halfHeight = Math.round(height / 2);

  const topLeft = inputImage
    .clone()
    .extract({ left: 0, top: 0, width: halfWidth, height: halfHeight })
    .toBuffer();
  const topRight = inputImage
    .clone()
    .extract({ left: halfWidth, top: 0, width: halfWidth, height: halfHeight })
    .toBuffer();
  const bottomLeft = inputImage
    .clone()
    .extract({ left: 0, top: halfHeight, width: halfWidth, height: halfHeight })
    .toBuffer();
  const bottomRight = inputImage
    .clone()
    .extract({
      left: halfWidth,
      top: halfHeight,
      width: halfWidth,
      height: halfHeight,
    })
    .toBuffer();

  const images = await Promise.all([
    topLeft,
    topRight,
    bottomLeft,
    bottomRight,
  ]);

  return { images, type: imageType };
}

export default defineHook(
  (
    { filter, action, init },
    { services, env, logger, database, getSchema }
  ) => {
    let promptChannelWrapper: amqp.ChannelWrapper;
    const queue = "prompts";

    /**
     * Ensure demo users can only create 10 images
     * @param context
     */
    async function validateDemoUser(context: EventContext) {
      const MAX_DEMO_IMAGES = 10;
      const DEMO_ROLE_ID = "84047249-44c5-476c-8261-4b65b4b6e7aa"; // should match demo role id in demo server

      const schema = await getSchema({ database });

      if (context.accountability?.role === DEMO_ROLE_ID) {
        // demo role

        const imageService = new services.ItemsService("images", {
          schema,
          accountability: {
            user: context.accountability?.user,
            role: context.accountability?.role,
            permissions: context.accountability.permissions,
          },
        });

        // get all images of user
        const query = {
          filter: {
            user_created: {
              // assuming `user_id` is the field for the user who owns the image
              _eq: context.accountability?.user, // assuming `user` is the field for the user ID
            },
          },
        };
        const images = await imageService.readByQuery(query);

        // if user has more than 10 images
        if (images.length >= MAX_DEMO_IMAGES) {
          const MyExtensionError = createError(
            "IMAGE_ERROR",
            "Cannot create more images",
            429
          );

          throw new MyExtensionError();
        }
      }
    }

    init("app.before", async () => {
      logger.info("Connecting to RabbitMQ");

      invariant(process.env.RABBITMQ_USER, "RABBITMQ_USER is not defined");
      invariant(
        process.env.RABBITMQ_PASSWORD,
        "RABBITMQ_PASSWORD is not defined"
      );

      const username = strictUriEncode(process.env.RABBITMQ_USER);
      const password = strictUriEncode(process.env.RABBITMQ_PASSWORD);

      const connection = await amqp.connect(
        `amqp://${username}:${password}@${process.env.RABBITMQ_HOST}:${process.env.RABBITMQ_PORT}/`
      );

      promptChannelWrapper = connection.createChannel({
        json: true,
        setup: async (channel: amqp.Channel) => {
          // Declare a queue

          return channel.assertQueue(queue, {
            durable: true,
          });
        },
      });

      const queueName = "bot_status";

      const botChannelWrapper = connection.createChannel({
        json: true,
        setup: async (channel: amqp.Channel) => {
          // Declare a queue
          return channel.assertQueue(queueName, {
            durable: true,
            maxLength: 1, // Maximum number of messages in the queue
          });
        },
      });

      logger.info(`Created queue "${queueName}"`);

      // Accept incoming messages from the queue
      botChannelWrapper.consume(queueName, async (msg) => {
        logger.info(`Received message from queue "bot_status":`, msg);

        if (msg) {
          const message = JSON.parse(msg.content.toString());

          try {
            assert(
              message,
              object({
                status: enums(["starting", "healthy", "unhealthy", "paused"]),
                message: optional(string()),
              })
            );
          } catch (e) {
            logger.error("Could not parse bot status", e);
            botChannelWrapper.nack(msg);
            return;
          }

          const schema = await getSchema({ database });

          try {
            const statusService = new services.ItemsService("status", {
              schema,
              accountability: { admin: true },
            });

            await statusService.upsertSingleton({
              bot_status: message.status,
              message: message.message || null,
            });

            logger.info("Saved bot status", message);

            botChannelWrapper.ack(msg);
          } catch (e) {
            logger.error("Could not save bot status", e);
            botChannelWrapper.nack(msg, false, false);
            return;
          }
        }
      });
    });

    filter("images.items.update", async (input, meta, context) => {
      assert(meta, ss.type({ keys: ss.size(ss.array(ss.string()), 1) }));

      assert(input, partial(Image));

      const imageId = meta.keys[0];

      if (input.discord_image_url) {
        logger.info("Importing image from discord", input);
        const fileService = new services.FilesService({
          schema: context.schema,
        });

        // get image owner id
        const imageService = new services.ItemsService("images", {
          schema: context.schema,
        });

        invariant(imageId, "imageId is not defined");

        const image = await imageService.readOne(imageId);

        const fileId = await fileService.importOne(input.discord_image_url, {
          title: input.prompt,
          filename_download: nanoid(),
          uploaded_by: image.user_created,
        });

        // get file
        const file = await fileService.readOne(fileId);

        // only split images if the status is "completed" because
        // we don't want to keep "in progress" images on file
        if (input.status === "completed") {
          // Download and split the image
          const { images: splittedImages, type } = await downloadAndSplitImage(
            input.discord_image_url
          );

          // Upload the splitted images
          const upscaledFileIds = [];
          const urls = []; // Array to store the URLs of the splitted images
          for (const imageBuffer of splittedImages) {
            // Convert the image buffer to a readable stream
            const imageStream = new Readable({
              read() {
                this.push(imageBuffer);
                this.push(null);
              },
            });

            const upscaledFileId = await fileService.uploadOne(imageStream, {
              title: input.prompt,
              filename_download: nanoid(),
              storage: "local", // Replace 'local' with the storage adapter you're using if necessary
              type,
              upscaled_image_id: meta.keys[0], // current image id
              uploaded_by: image.user_created,
            });
            upscaledFileIds.push(upscaledFileId);

            // Get the uploaded file and store its URL in the 'urls' array
            const uploadedFile = await fileService.readOne(upscaledFileId);
            urls.push(
              `${env.PUBLIC_URL}/assets/${uploadedFile.id}/${uploadedFile.filename_disk}`
            );
          }

          // Assign the uploaded splitted images to the "upscaled" field
          input.upscaled = upscaledFileIds;

          // Assign the URLs of the splitted images to the "urls" field
          input.upscaled_urls = urls;
        }

        input.results = fileId;
        input.url = `${env.PUBLIC_URL}/assets/${file.id}/${file.filename_disk}`;
      }

      return input;
    });

    /**
     * Create a filter to set internal_id on an image on create
     */
    filter("images.items.create", async (input, meta, context) => {
      assert(input, partial(PreCalculatedFieldsImage)); // partial means I give up

      await validateDemoUser(context);

      // generate uuid for internal_id
      if (!input.internal_id) {
        input.internal_id = nanoid();
      }

      return input;
    });

    /**
     * Use action instead of filter so auto-generated fields are available
     */
    action(
      "images.items.create",
      async ({ payload, key: imageId }, context) => {
        assert(payload, partial(PreCalculatedFieldsImage)); // partial means I give up

        logger.info(`Created queue "${queue}"`);

        const MQMessage = object({
          type: enums(["generate image"]),
          prompt: string(),
          imageId: string(),
          internalImageId: string(),
        });

        if (payload.prompt) {
          logger.info(`Sending message to queue "prompts": ${payload.prompt}`);
          // TODO: hardcode these for now, but we should be able to get them from the
          const message = {
            type: "generate image",
            prompt: payload.prompt.replace(/\n/g, " "),
            imageId: imageId,
            internalImageId: payload.internal_id,
          };

          assert(message, MQMessage);
          promptChannelWrapper.sendToQueue(queue, message, {
            // keep message in queue if rabbitmq restarts
            persistent: true,
          });
        }

        return payload;
      }
    );
  }
);
