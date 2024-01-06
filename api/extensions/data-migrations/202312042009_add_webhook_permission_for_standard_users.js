module.exports = {
  async up(knex) {
    const standardRole = await knex("directus_roles")
      .where("name", "Standard")
      .first();

    // read permissions
    await knex("directus_permissions")
      .where({
        role: standardRole.id,
        collection: "directus_users",
      })
      .whereIn("action", ["read"])
      .update({
        permissions: JSON.stringify({
          _and: [{ id: { _eq: "$CURRENT_USER" } }],
        }),
        fields:
          "first_name,last_name,email,password,token,role,status,tfa_secret,auth_data,theme,language,avatar,preferences_divider,tags,description,title,location,last_page,webhooks",
      });

    // update permissions
    return knex("directus_permissions")
      .where({
        role: standardRole.id,
        collection: "directus_users",
      })
      .whereIn("action", ["update"])
      .update({
        permissions: JSON.stringify({
          _and: [{ id: { _eq: "$CURRENT_USER" } }],
        }),
        fields: "first_name,last_name,password,email,token,webhooks",
      });
  },

  async down(knex) {
    const standardRole = await knex("directus_roles")
      .where("name", "Standard")
      .first();

    // read permissions
    await knex("directus_permissions")
      .where({
        role: standardRole.id,
        collection: "directus_users",
      })
      .whereIn("action", ["read"])
      .update({
        permissions: JSON.stringify({
          _and: [{ id: { _eq: "$CURRENT_USER" } }],
        }),
        fields:
          "first_name,last_name,email,password,token,role,status,tfa_secret,auth_data,theme,language,avatar,preferences_divider,tags,description,title,location,last_page",
      });

    // update permissions
    return knex("directus_permissions")
      .where({
        role: standardRole.id,
        collection: "directus_users",
      })
      .whereIn("action", ["update"])
      .update({
        permissions: JSON.stringify({
          _and: [{ id: { _eq: "$CURRENT_USER" } }],
        }),
        fields: "first_name,last_name,password,email,token",
      });
  },
};
