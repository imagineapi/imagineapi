module.exports = {
  async up(knex) {
    return knex("directus_permissions").insert({
      role: "09c04dcf-5a1b-4583-b900-b259fa32dffa", //standard role
      collection: "images",
      action: "update",
      permissions: JSON.stringify({
        _and: [{ user_created: { _eq: "$CURRENT_USER" } }],
      }),
      validation: "{}",
      fields: "prompt",
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
