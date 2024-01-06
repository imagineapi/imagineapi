module.exports = {
  async up(knex) {
    const newSetting = {
      id: 1,
      project_name: "ImagineAPI",
      project_logo: "b5e35a64-e7af-4418-a0e7-5441026e6001",
      auth_login_attempts: 25,
      storage_asset_transform: "all",
      module_bar: JSON.stringify([
        { type: "module", id: "content", enabled: true },
        { type: "module", id: "users", enabled: false },
        { type: "module", id: "files", enabled: true },
        { type: "module", id: "insights", enabled: false },
        { type: "module", id: "docs", enabled: false },
        { type: "module", id: "settings", enabled: true, locked: true },
      ]),
      default_language: "en-US",
    };

    await knex("directus_settings").insert(newSetting);
  },

  async down(knex) {
    await knex("directus_settings").where("id", 1).delete();
  },
};
