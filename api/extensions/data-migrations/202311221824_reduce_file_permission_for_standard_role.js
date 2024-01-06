module.exports = {
  async up(knex) {
    const standardRole = await knex("directus_roles")
      .where("name", "Standard")
      .first();

    return knex("directus_permissions")
      .where({
        role: standardRole.id,
        collection: "directus_files",
      })
      .whereIn("action", ["read", "update", "delete"])
      .update({
        permissions: JSON.stringify({
          _and: [{ uploaded_by: { _eq: "$CURRENT_USER" } }],
        }),
        fields: "*",
      });
  },

  async down(knex) {
    const standardRole = await knex("directus_roles")
      .where("name", "Standard")
      .first();

    return knex("directus_permissions")
      .where({
        role: standardRole.id,
        collection: "directus_files",
      })
      .whereIn("action", ["read", "update", "delete"])
      .update({
        permissions: JSON.stringify({}),
      });
  },
};
