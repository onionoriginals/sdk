import { defineRailway, project, service, volume, preserve } from "railway/iac";

// Infrastructure-as-Code for the landing deploy (the `builder` service, custom
// domain originals.build). Replaces the deprecated root railway.json, whose
// Config-as-Code format stops working after 2026-12-01. It carries the build
// and start commands railway.json held, plus the non-secret runtime shape that
// was previously dashboard-only and therefore invisible in a diff.
//
// This file is the DESIRED STATE of the environment. Railway IaC reconciles the
// whole project authoritatively: a resource or variable present live but absent
// here is DELETED on apply. Two consequences the reader must act on:
//   1. Secret values are declared with preserve() so apply keeps the dashboard
//      value and never writes it into source. See apps/landing/DEPLOY.md.
//   2. Facts this repo cannot see (the live project name below, the volume's
//      size and region, other services if any) are asserted or omitted here.
//      Always run `railway config plan` and confirm it proposes NO unexpected
//      deletion or rename before `railway config apply`. See DEPLOY.md.

export default defineRailway(() => {
  // Persistent volume: the only durable store (no Postgres/SQLite/Redis) and the
  // only copy of signed-but-unbroadcast reveal transactions. Size and region are
  // existing dashboard state, omitted so the plan does not propose changing them.
  const builderVolume = volume("builder-volume");

  const builder = service("builder", {
    build: {
      builder: "NIXPACKS",
      buildCommand:
        "bun install && bun run build && cd apps/landing && bun run build",
    },
    deploy: {
      startCommand: "bun run apps/landing/serve.ts",
      // Capped low on purpose: config.ts ships warn-only so a value production
      // lacks degrades rather than crash-loops the site down. Do not raise it
      // without reading the CONFIG_STRICT note in DEPLOY.md.
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    volumeMounts: {
      "/data": builderVolume,
    },
    env: {
      // Non-secret runtime shape. Values are the recorded production intent from
      // apps/landing/DEPLOY.md and issues #522/#529; config.ts validates them at
      // boot. VITE_* are baked into the SPA at build time, so changing one is a
      // rebuild, not a restart.
      NODE_ENV: "production",
      BTC_NETWORK: "mainnet",
      ORIGINALS_DATA_DIR: "/data",
      TRUSTED_PROXY_HOPS: "1",
      VITE_BTC_NETWORK: "mainnet",
      VITE_WEBVH_HOST: "originals.build",
      // Non-secret, but its live value is not recorded anywhere in the repo, so
      // it is preserved rather than asserted: the sanctioned choice (KTD4) is the
      // free public mempool.space API, and a paid endpoint would be downgraded if
      // this named the wrong URL. Inline the real value here to put it in the
      // diff; BTC_INDEXER_TOKEN stays a dashboard secret. See DEPLOY.md.
      BTC_INDEXER_API: preserve(),
      // Secrets: kept as dashboard state, declared here only so authoritative
      // apply does not delete them. Values never enter source. See DEPLOY.md.
      JWT_SECRET: preserve(),
      TURNKEY_API_PUBLIC_KEY: preserve(),
      TURNKEY_API_PRIVATE_KEY: preserve(),
      TURNKEY_ORGANIZATION_ID: preserve(),
      QUICKNODE_ENDPOINT: preserve(),
      BTC_INDEXER_TOKEN: preserve(),
    },
  });

  // The project name must match the live Railway project or apply proposes a
  // rename. This repo cannot read it; confirm with `railway status` and correct
  // it if the plan shows a rename. See DEPLOY.md ("Not verifiable from here").
  return project("originals", {
    resources: [builder, builderVolume],
  });
});
