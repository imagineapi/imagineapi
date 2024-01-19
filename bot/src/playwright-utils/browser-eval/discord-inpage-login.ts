export default function discordInPageLogin({
  username,
  password,
  xCaptchaKey,
}: {
  username: string;
  password: string;
  xCaptchaKey?: string;
}) {
  console.log("In page login eval");
  const headers: { "content-type": string; "x-captcha-key"?: string } = {
    "content-type": "application/json",
  };

  if (xCaptchaKey) {
    headers["x-captcha-key"] = xCaptchaKey;
  }

  return fetch("https://discord.com/api/v9/auth/login", {
    headers,
    body: JSON.stringify({
      login: username,
      password,
      undelete: false,
      login_source: null,
      gift_code_sku_id: null,
    }),
    method: "POST",
  })
    .then((response) => response.json())
    .then((data) => Promise.resolve(data))
    .catch((error) => Promise.reject(error));
}
