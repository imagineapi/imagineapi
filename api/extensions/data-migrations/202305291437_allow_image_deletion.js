module.exports = {
  async up(knex) {
    return knex("directus_permissions").insert({
      role: "09c04dcf-5a1b-4583-b900-b259fa32dffa", //standard role
      collection: "images",
      action: "delete",
      permissions: JSON.stringify({
        _and: [
          {
            user_created: {
              _eq: "$CURRENT_USER",
            },
          },
          {
            date_created: {
              // only images that are older than 1 day (we don't want queued images to be deleted right away since they won't get deleted from rabbitmq queue)
              _lt: "$NOW(-1 day)",
            },
          },
        ],
      }),
      validation: "{}",
    });
  },

  async down(knex) {
    return knex("directus_permissions")
      .where("role", "09c04dcf-5a1b-4583-b900-b259fa32dffa")
      .where("collection", "images")
      .where("action", "update")
      .del();
  },
};
