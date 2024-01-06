import {
  array,
  assert,
  assign,
  date,
  enums,
  literal,
  nullable,
  number,
  object,
  optional,
  partial,
  string,
  type,
} from "superstruct";

export const Image = object({
  id: string(),
  internal_id: string(),
  prompt: string(),
  results: optional(string()),
  status: enums(["pending", "queued", "in-progress", "completed", "failed"]),
  progress: nullable(optional(string())),
  generation_type: enums(["initial", "upscaled", "remixed"]),
  discord_channel_id: optional(string()),
  discord_server_id: optional(string()),
  discord_message_id: optional(string()),
  discord_account_id: optional(string()),
  discord_image_url: optional(string()),
  date_created: optional(string()),
  url: nullable(string()),
  user_created: string(),
  error: optional(string()),
  upscaled: optional(array(string())),
  upscaled_urls: optional(array(string())),
});

export const PreCalculatedFieldsImage = assign(
  Image,
  object({
    internal_id: optional(string()),
    id: optional(string()),
  })
);

export const blah = partial(
  type({
    age: number(),
  })
);


export const ReadImage = type({
  id: string(),
  prompt: string(),
  user_created: string(),
  date_created: string(),
  status: enums(["pending", "queued", "in-progress", "completed", "failed"]),
  progress: nullable(optional(string())),
  url: nullable(string()),
  results: optional(string()),
});

export const ImageReadMeta = object({
  event: literal("images.items.read"),
  query: object({
    fields: array(string()),
    sort: optional(array(string())),
    limit: optional(number()),
    page: optional(number()),
    filter: optional(
      object({
        id: optional(object()),
      })
    ),
    aggregate: optional(
      object({
        count: array(),
      })
    ),
  }),
  collection: literal("images"),
});