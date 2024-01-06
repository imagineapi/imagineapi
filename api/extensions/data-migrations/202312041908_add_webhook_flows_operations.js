module.exports = {
  async up(knex) {
    await knex("directus_flows").insert([
      {
        id: "dc9a63a0-95a5-46d5-9af3-078f24c195c7",
        name: "Run webhooks",
        icon: "bolt",
        color: null,
        description: "Deliver webhook call",
        status: "active",
        trigger: "operation",
        accountability: "all",
        options: JSON.stringify("{}"),
        date_created: new Date("2023-12-01T18:39:45.999Z"),
      },
      {
        id: "c6851217-07c7-4164-84a3-a19d5e1c9471",
        name: "Image create, update event",
        icon: "bolt",
        color: null,
        description:
          "Prepare event data for webhook and call flow that runs webhooks",
        status: "active",
        trigger: "event",
        accountability: "all",
        options: JSON.stringify({
          type: "action",
          scope: ["items.create", "items.update"],
          collections: ["images"],
        }),
        date_created: new Date("2023-09-13T03:26:01.627Z"),
      },
    ]);

    // Insert into directus_operations
    await knex("directus_operations").insert([
      {
        id: "a9c16778-6536-479a-927b-d53c5dedc477",
        name: "Trigger Flow",
        key: "trigger_zyxk7",
        type: "trigger",
        position_x: 70,
        position_y: 3,
        options: JSON.stringify({
          flow: "dc9a63a0-95a5-46d5-9af3-078f24c195c7",
          payload: "{{$last}}",
        }),
        resolve: null,
        reject: null,
        flow: "c6851217-07c7-4164-84a3-a19d5e1c9471",
        date_created: new Date("2023-12-01T18:42:13.898Z"),
      },
      {
        id: "79bd41a3-1c3c-4f51-9bab-682dd301b8b4",
        name: "Prep data for webhook",
        key: "prep_data_for_webhook",
        type: "exec",
        position_x: 45,
        position_y: 2,
        options: JSON.stringify({
          code: "module.exports = async function({$last, $trigger, item_read_hhkp1}) {\n\treturn $last.webhooks.filter(obj => obj.webhook !== null).map(obj => {\n        return {\n            ...obj,\n            data: {\n                event: $trigger.event,\n                payload: item_read_hhkp1[0]\n            }\n        }\n    });\n}",
        }),
        resolve: "a9c16778-6536-479a-927b-d53c5dedc477",
        reject: null,
        flow: "c6851217-07c7-4164-84a3-a19d5e1c9471",
        date_created: new Date("2023-12-01T01:44:04.921Z"),
      },
      {
        id: "68fe6e76-2c8c-4a4e-b646-ae44cb640fd1",
        name: "Get image owner's webhooks",
        key: "item_read_ef9xa",
        type: "item-read",
        position_x: 22,
        position_y: 2,
        options: JSON.stringify({
          collection: "directus_users",
          key: ["{{$last[0].user_created}}"],
          emitEvents: true,
          query: { fields: ["webhooks"] },
        }),
        resolve: "79bd41a3-1c3c-4f51-9bab-682dd301b8b4",
        reject: null,
        flow: "c6851217-07c7-4164-84a3-a19d5e1c9471",
        date_created: new Date("2023-12-01T01:38:36.473Z"),
      },
      {
        id: "c1f71995-5335-43ba-898f-33057afe483a",
        name: "Load image",
        key: "item_read_hhkp1",
        type: "item-read",
        position_x: 30,
        position_y: 21,
        options: JSON.stringify({
          collection: "images",
          key: null,
          emitEvents: true,
          query: {
            filter: { id: { _eq: "{{$last.id}}" } },
            fields: [
              "id",
              "prompt",
              "results",
              "user_created",
              "date_created",
              "status",
              "progress",
              "url",
              "error",
              "upscaled_urls",
              "upscaled",
            ],
          },
          permissions: "$full",
        }),
        resolve: "68fe6e76-2c8c-4a4e-b646-ae44cb640fd1",
        reject: null,
        flow: "c6851217-07c7-4164-84a3-a19d5e1c9471",
        date_created: new Date("2023-12-01T23:06:22.49Z"),
      },
      {
        id: "cc8cd1fc-c9d1-43e7-b451-52ee47aa4365",
        name: "Get Image Id",
        key: "get_image_id",
        type: "exec",
        position_x: 11,
        position_y: 22,
        options: JSON.stringify({
          code: "module.exports = async function({$trigger}) {\n\tif ($trigger.keys) {\n        return {id: $trigger.keys[0]};\n    }\n\treturn {id: $trigger.key};\n}",
        }),
        resolve: "c1f71995-5335-43ba-898f-33057afe483a",
        reject: null,
        flow: "c6851217-07c7-4164-84a3-a19d5e1c9471",
        date_created: new Date("2023-12-01T23:03:49.091Z"),
      },
      {
        id: "58c66a25-49ff-45ba-9a38-1040818d4ff7",
        name: "Webhook / Request URL",
        key: "request_23bjq",
        type: "request",
        position_x: 33,
        position_y: 1,
        options: JSON.stringify({
          method: "POST",
          url: "{{$last.webhook}}",
          body: "{{$last.data}}",
        }),
        resolve: null,
        reject: null,
        flow: "dc9a63a0-95a5-46d5-9af3-078f24c195c7",
        date_created: new Date("2023-12-01T18:46:54.779Z"),
      },
    ]);

    // update flows to add operations
    await knex("directus_flows")
      .where("id", "dc9a63a0-95a5-46d5-9af3-078f24c195c7")
      .update({
        operation: "58c66a25-49ff-45ba-9a38-1040818d4ff7",
      });

    await knex("directus_flows")
      .where("id", "c6851217-07c7-4164-84a3-a19d5e1c9471")
      .update({
        operation: "cc8cd1fc-c9d1-43e7-b451-52ee47aa4365",
      });
  },

  async down(knex) {
    await knex("directus_operations")
      .whereIn("id", [
        "a9c16778-6536-479a-927b-d53c5dedc477",
        "79bd41a3-1c3c-4f51-9bab-682dd301b8b4",
        "68fe6e76-2c8c-4a4e-b646-ae44cb640fd1",
        "c1f71995-5335-43ba-898f-33057afe483a",
        "cc8cd1fc-c9d1-43e7-b451-52ee47aa4365",
        "58c66a25-49ff-45ba-9a38-1040818d4ff7",
      ])
      .del();

    // Delete from directus_flows
    return knex("directus_flows")
      .whereIn("id", [
        "dc9a63a0-95a5-46d5-9af3-078f24c195c7",
        "c6851217-07c7-4164-84a3-a19d5e1c9471",
      ])
      .del();
  },
};
