exports.up = async function (knex) {
  const standardRole = await knex("directus_roles")
    .where("name", "Standard")
    .first();
  const firstUserWithStandardRole = await knex("directus_users")
    .where("role", standardRole.id)
    .first();

  const newPreset = {
    user: firstUserWithStandardRole.id,
    collection: "images",
    layout: "cards",
    layout_query: JSON.stringify({
      cards: { sort: ["-date_updated"], page: 1 },
    }),
    layout_options: JSON.stringify({
      cards: {
        size: 5,
        title: "{{progress}}%",
        subtitle: "{{prompt}}",
      },
    }),
    icon: "bookmark_outline",
  };

  const existingPreset = await knex("directus_presets")
    .where("user", newPreset.user)
    .andWhere("collection", newPreset.collection)
    .first();

  if (existingPreset) {
    await knex("directus_presets")
      .where("id", existingPreset.id)
      .update(newPreset);
  } else {
    await knex("directus_presets").insert(newPreset);
  }
};

exports.down = async function (knex) {
  const standardRole = await knex("directus_roles")
    .where("name", "Standard")
    .first();
  const firstUserWithStandardRole = await knex("directus_users")
    .where("role", standardRole.id)
    .first();

  const existingPreset = await knex("directus_presets")
    .where("user", firstUserWithStandardRole.id)
    .andWhere("collection", "images")
    .first();

  if (existingPreset) {
    await knex("directus_presets").where("id", existingPreset.id).delete();
  }
};
