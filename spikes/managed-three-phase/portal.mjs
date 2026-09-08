/**
 * Read the Helix CLI's stored OIDC access token and talk to the portal control plane.
 * Used once, by hand, to discover the app slug / manifest / dev-token endpoint for
 * this measurement spike. Not part of any gate.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const PORTAL = "https://portal.azx.helix.azxlabs.io";

export function accessToken() {
  const raw = JSON.parse(readFileSync(`${homedir()}/.config/helix/tokens.json`, "utf8"));
  return raw.byPortal[PORTAL].tokens.accessToken;
}

export async function portal(path, init = {}) {
  const res = await fetch(`${PORTAL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken()}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, text };
}

if (process.argv[1] && process.argv[1].endsWith("portal.mjs")) {
  const raw = JSON.parse(readFileSync(`${homedir()}/.config/helix/tokens.json`, "utf8"));
  console.log("token keys:", Object.keys(raw));
  const paths = process.argv[2] ? process.argv[2].split(",") : ["/api/v1/apps"];
  for (const p of paths) {
    const r = await portal(p);
    console.log(`\n=== ${p} -> ${r.status}`);
    console.log(r.text.slice(0, 3000));
  }
}
