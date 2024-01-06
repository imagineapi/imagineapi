const { Client } = require("pg");

if (process.argv.length !== 9) {
  console.log(
    "Usage: node queryUserToken.js <userId> <newApiToken> <host> <port> <user> <password>"
  );
  process.exit(1);
}

const [, , userId, newApiToken, host, port, user, password, database] =
  process.argv;

const client = new Client({
  host,
  port,
  user,
  password,
  database,
});

(async () => {
  await client.connect();

  try {
    const initialQuery = "SELECT token FROM directus_users WHERE id = $1";
    const { rows: initialRows } = await client.query(initialQuery, [userId]);

    // just return the token if it already exists
    if (initialRows.length > 0) {
      if (initialRows[0].token) {
        console.log(initialRows[0].token);
      } else {
        const updateQuery =
          "UPDATE directus_users SET token = $1 WHERE id = $2";
        await client.query(updateQuery, [newApiToken, userId]);
        const query = "SELECT token FROM directus_users WHERE id = $1";
        const { rows } = await client.query(query, [userId]);
        if (rows.length > 0) {
          console.log(rows[0].token);
        } else {
          console.log(`User with ID ${userId} not found.`);
        }
      }
    } else {
      throw new Error(`User with ID ${userId} not found.`);
    }
  } catch (error) {
    console.error("Error querying the database:", error);
  } finally {
    await client.end();
  }
})();
