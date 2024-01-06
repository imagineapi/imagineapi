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
    icon: "bookmark_outline",
    refresh_interval: 30,
    layout_options: JSON.stringify({
      cards: {
        size: 5,
        title: "{{status}}: {{progress}}%",
        subtitle: "{{prompt}}",
        imageSource: "results",
      },
    }),
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

exports.down = async function (knex) {};
