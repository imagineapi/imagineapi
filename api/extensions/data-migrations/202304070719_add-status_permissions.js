module.exports = {
  async up(knex) {
    await knex("directus_permissions").insert({
      role: "09c04dcf-5a1b-4583-b900-b259fa32dffa",
      collection: "status",
      action: "read",
      permissions: "{}",
      fields: "*",
    });
  },

  async down(knex) {
    await knex("directus_permissions")
      .where({
        role: "09c04dcf-5a1b-4583-b900-b259fa32dffa",
        collection: "status",
        action: "read",
      })
      .delete();
  },
};
