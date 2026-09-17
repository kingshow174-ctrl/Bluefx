const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(__dirname, { extensions: ["html"] }));

const DERIV_APP_ID = "34qkHBWs65EnHfTnuEESd";
const TOKEN_ENDPOINT = "https://auth.deriv.com/oauth2/token";

// Deriv's docs are explicit: the authorization-code-for-token exchange
// must happen server-side, never from the browser. This is that step.
app.post("/api/exchange-code", async (req, res) => {
  const { code, code_verifier, redirect_uri } = req.body || {};
  if (!code || !code_verifier || !redirect_uri) {
    return res.status(400).json({ error: "Missing code, code_verifier, or redirect_uri" });
  }

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: DERIV_APP_ID,
      code,
      redirect_uri,
      code_verifier,
    });

    const derivRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const body = await derivRes.json();
    if (!derivRes.ok) {
      console.error("Deriv token exchange failed:", body);
      return res.status(derivRes.status).json(body);
    }
    // body should contain { access_token, refresh_token, expires_in, token_type }
    res.json(body);
  } catch (err) {
    console.error("Token exchange error:", err);
    res.status(500).json({ error: "Token exchange failed", detail: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Blue FX server listening on port ${PORT}`);
});
