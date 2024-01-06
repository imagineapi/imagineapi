export default function discordInPageLogin({
  solution,
  discordUsername,
  discordPassword,
}: {
  solution: string;
  discordUsername: string;
  discordPassword: string;
}) {
  return new Promise((resolve, reject) => {
    fetch("https://discord.com/api/v9/auth/login", {
      headers: {
        "content-type": "application/json",
      },
      body: `{"login":"${discordUsername}","password":"${discordPassword}","undelete":false,"captcha_key":"${solution}","gift_code_sku_id":null}`,
      method: "POST",
    })
      .then((response) => response.json())
      .then((data) => resolve(data))
      .catch((error) => reject(error));
  });
}
