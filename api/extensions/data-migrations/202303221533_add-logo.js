module.exports = {
  async up(knex) {
    const standardRole = await knex("directus_roles")
      .where("name", "Standard")
      .first();
    const firstUserWithStandardRole = await knex("directus_users")
      .where("role", standardRole.id)
      .first();

    const newFile = {
      id: "b5e35a64-e7af-4418-a0e7-5441026e6001",
      storage: "local",
      filename_disk: "b5e35a64-e7af-4418-a0e7-5441026e6001.png",
      filename_download: "logo-symbol only.png",
      title: "Logo Symbol Only",
      type: "image/png",
      uploaded_by: firstUserWithStandardRole.id,
      uploaded_on: "2023-02-28 17:45:30.72512+00",
      modified_on: "2023-02-28 17:45:30.741+00",
      filesize: 5317,
      width: 202,
      height: 151,
    };

    await knex("directus_files").insert(newFile);
  },

  async down(knex) {
    const standardRole = await knex("directus_roles")
      .where("name", "Standard")
      .first();
    const firstUserWithStandardRole = await knex("directus_users")
      .where("role", standardRole.id)
      .first();

    await knex("directus_files")
      .where("id", "b5e35a64-e7af-4418-a0e7-5441026e6001")
      .delete();
  },
};
