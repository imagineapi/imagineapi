module.exports = {
  async up(knex) {
    const roleId = "09c04dcf-5a1b-4583-b900-b259fa32dffa";
    const collection = "images";
    const action = "read";
    const newFields =
      "id,prompt,results,user_created,date_created,status,progress,url,error";

    await knex("directus_permissions")
      .where({ role: roleId, collection, action })
      .update({
        fields: newFields,
      });
  },

  async down(knex) {
    const roleId = "09c04dcf-5a1b-4583-b900-b259fa32dffa";
    const collection = "images";
    const action = "read";
    const originalFields =
      "id,prompt,results,user_created,date_created,status,progress,url";

    await knex("directus_permissions")
      .where({ role: roleId, collection, action })
      .update({
        fields: originalFields,
      });
  },
};
